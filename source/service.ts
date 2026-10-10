import {
	parseTree,
	parseForEditor,
	getEditorContext,
	ParseError,
	formatEdits,
	formatKey,
	type DocumentNode,
	type Node,
	type ValueNode,
	type PathSegment,
	type FormatEdit,
	type Token,
	type Comment,
	type EditorNode,
	type EditorDocument,
	type EditorValue,
	type EditorParseResult,
	type EditorDiagnostic,
} from 'soml-lang';

export type Span = readonly [start: number, end: number];
export type Problem = {message: string; range: Span; limited?: boolean; code?: string; related?: EditorDiagnostic['related']};
export type Analysis = {text: string; tree?: DocumentNode; recovered?: EditorParseResult; problem?: Problem};
export type OutlineEntry = {name: string; type: ValueNode['type'] | 'Unknown'; range: Span; selection: Span; children: OutlineEntry[]};
export type Fold = {start: number; end: number; comment: boolean};

export const defaultMaxDocumentSize = 1_000_000;
const resultLimit = 5000;
const numberFormat = new Intl.NumberFormat('en-US');
const localDateTimeFormat = new Intl.DateTimeFormat(undefined, {dateStyle: 'long', timeStyle: 'long'});

/**
Analyze exactly the editor's text, without normalizing forbidden characters.
*/
export function analyze(text: string, maxSize = defaultMaxDocumentSize): Analysis {
	if (text.length > maxSize) {
		return {text, problem: {message: `Language features are disabled above ${numberFormat.format(maxSize)} UTF-16 code units. Adjust soml.maxDocumentSize to change this limit.`, range: [0, 0], limited: true}};
	}

	try {
		return {text, tree: parseTree(text)};
	} catch (error) {
		if (!(error instanceof ParseError)) {
			throw error;
		}

		const width = (text.codePointAt(error.offset) ?? 0) > 0xFF_FF ? 2 : 1;
		return {text, recovered: parseForEditor(text), problem: {message: error.reason, range: [error.offset, Math.min(text.length, error.offset + width)]}};
	}
}

/**
Report independent recovered errors, retaining the strict parser's first message.
*/
export function diagnosticProblems(analysis: Analysis): Problem[] {
	if (!analysis.problem) {
		return [];
	}

	const result: Problem[] = [{...analysis.problem}];
	for (const diagnostic of analysis.recovered?.diagnostics.slice(1) ?? []) {
		const overlapping = result.find(problem => {
			const [start, end] = problem.range;
			const [otherStart, otherEnd] = diagnostic.range;
			return start === otherStart || (start < otherEnd && otherStart < end);
		});
		if (overlapping) {
			if (overlapping === result[0] && overlapping.code === undefined) {
				overlapping.code = diagnostic.code;
				overlapping.range = diagnostic.range;
				overlapping.related = diagnostic.related;
			}

			continue;
		}

		result.push(diagnostic);
	}

	return result;
}

/**
Cache one version per live document without retaining closed documents.
*/
export class DocumentCache {
	// eslint-disable-next-line @typescript-eslint/no-restricted-types -- Cache keys use object identity, not indexed properties.
	readonly #entries = new WeakMap<object, {version: number; maxSize: number; analysis: Analysis}>();

	get(document: {version: number; getText(): string}, maxSize = defaultMaxDocumentSize): Analysis {
		const cached = this.#entries.get(document);
		if (cached?.version === document.version && cached.maxSize === maxSize) {
			return cached.analysis;
		}

		const analysis = analyze(document.getText(), maxSize);
		this.#entries.set(document, {version: document.version, maxSize, analysis});
		return analysis;
	}

	/**
	Reuse recovery from validation, or lazily create one snapshot for a valid document.
	*/
	getEditor(document: {version: number; getText(): string}, maxSize = defaultMaxDocumentSize): EditorParseResult | undefined {
		const analysis = this.get(document, maxSize);
		if (analysis.problem?.limited) {
			return undefined;
		}

		analysis.recovered ??= parseForEditor(analysis.text);
		return analysis.recovered;
	}

	// eslint-disable-next-line @typescript-eslint/no-restricted-types -- VS Code document interfaces do not have an index signature.
	delete(document: object): void {
		this.#entries.delete(document);
	}
}

/**
Format valid documents with the reference formatter's minimal edits.
*/
export function formattingEdits(text: string, maxSize = defaultMaxDocumentSize): FormatEdit[] {
	if (text.length > maxSize) {
		return [];
	}

	try {
		return formatEdits(text);
	} catch (error) {
		if (!(error instanceof ParseError)) {
			throw error;
		}

		return [];
	}
}

/**
The direct children of a syntax node, in source order.
*/
function children(node: Node | EditorNode): ReadonlyArray<Node | EditorNode> {
	switch (node.type) {
		case 'Document': {
			return [node.body];
		}

		case 'EditorDocument': {
			return node.children;
		}

		case 'EditorObject':
		case 'Object': {
			return node.members;
		}

		case 'EditorArray':
		case 'Array': {
			return node.elements;
		}

		case 'EditorMember':
		case 'Member': {
			return [node.key, node.value];
		}

		default: {
			return [];
		}
	}
}

/**
Find a child with binary search, including in very wide objects and arrays.
*/
function indexAt(nodes: ReadonlyArray<{range: Span}>, offset: number): number {
	let low = 0;
	let high = nodes.length;
	while (low < high) {
		const middle = Math.floor((low + high) / 2);
		if (nodes[middle]!.range[0] <= offset) {
			low = middle + 1;
		} else {
			high = middle;
		}
	}

	const node = nodes[low - 1];
	return node && offset < node.range[1] ? low - 1 : -1;
}

/**
The enclosing nodes, outermost first, using half-open source ranges.
*/
export function ancestorsAt(tree: DocumentNode, offset: number): Node[];
export function ancestorsAt(tree: EditorDocument, offset: number): EditorNode[];
export function ancestorsAt(tree: DocumentNode | EditorDocument, offset: number): Array<Node | EditorNode>;
export function ancestorsAt(tree: DocumentNode | EditorDocument, offset: number): Array<Node | EditorNode> {
	const result: Array<Node | EditorNode> = [];
	let node: Node | EditorNode | undefined = tree;
	while (node && node.range[0] <= offset && offset < node.range[1]) {
		result.push(node);
		const descendants = children(node);
		node = descendants[indexAt(descendants, offset)];
	}

	return result;
}

/**
The most specific node, token, or comment under the cursor.
*/
function getNodeAt(tree: DocumentNode, offset: number, node: Node | undefined): Node | Token | Comment | undefined {
	const comment = tree.comments[indexAt(tree.comments, offset)];
	if (comment) {
		return comment;
	}

	const token = tree.tokens[indexAt(tree.tokens, offset)];
	return token && (!node || token.range[0] > node.range[0] || token.range[1] < node.range[1]) ? token : node;
}

/**
The CLI-compatible key path at a member or array item.
*/
export function keyPathAt(tree: DocumentNode, offset: number): string | undefined {
	const ancestors = ancestorsAt(tree, offset);
	const path: PathSegment[] = [];
	for (const [index, node] of ancestors.entries()) {
		if (node.type === 'Member') {
			path.push(node.key.value);
		} else if (node.type === 'Array') {
			const child = ancestors[index + 1];
			if (child) {
				path.push(indexAt(node.elements, offset));
			}
		}
	}

	if (path.length === 0) {
		return undefined;
	}

	let result = '';
	// Quote path segments using SOML's own string serializer.
	for (const segment of path) {
		result += typeof segment === 'number' ? `[${segment}]` : `${result === '' ? '' : '.'}${formatKey(segment)}`;
	}

	return result;
}

/**
Hierarchical symbols with separate full-member and key-selection ranges.
*/
export function outline(tree: DocumentNode | EditorDocument, limit = resultLimit): OutlineEntry[] {
	let remaining = limit;
	function visit(node: ValueNode | EditorValue): OutlineEntry[] {
		const result: OutlineEntry[] = [];
		if (node.type !== 'Object' && node.type !== 'Array' && node.type !== 'EditorObject' && node.type !== 'EditorArray') {
			return result;
		}

		const entries = node.type === 'Object' || node.type === 'EditorObject' ? node.members : node.elements;
		for (const [index, entry] of entries.entries()) {
			if (entry.type === 'EditorError' || (entry.type === 'EditorMember' && entry.key.type === 'EditorError')) {
				continue;
			}

			if (remaining-- <= 0) {
				break;
			}

			const member = entry.type === 'Member' || entry.type === 'EditorMember' ? entry : undefined;
			const value = entry.type === 'Member' || entry.type === 'EditorMember' ? entry.value : entry;
			const key = member?.key;
			let name = `[${index}]`;
			if (key?.type === 'Key') {
				name = formatKey(key.value);
			} else if (key?.type === 'EditorKey') {
				name = formatKey(key.key);
			}

			result.push({
				name,
				type: outlineType(value),
				range: entry.range,
				selection: key?.range ?? [entry.range[0], Math.min(entry.range[0] + 1, entry.range[1])],
				children: visit(value),
			});
		}

		return result;
	}

	return tree.type === 'Document' ? visit(tree.body) : tree.children.flatMap(node => visit(node));
}

/**
The display kind of a strict or recovered value, without evaluating recovery nodes.
*/
function outlineType(node: ValueNode | EditorValue): OutlineEntry['type'] {
	switch (node.type) {
		case 'EditorObject': {return 'Object';}
		case 'EditorArray': {return 'Array';}
		case 'EditorMissing':
		case 'EditorError': {return 'Unknown';}
		case 'EditorScalar': {
			const kinds = {
				string: 'String', int: 'Integer', float: 'Float', bool: 'Boolean', null: 'Null', instant: 'Instant', duration: 'Duration',
			} as const;
			return kinds[node.scalarKind];
		}

		default: {return node.type;}
	}
}

/**
Fold structural regions, block strings, and comments while leaving closing lines visible.
*/
export function folds(tree: DocumentNode | EditorParseResult, text: string, limit = resultLimit): Fold[] {
	const isRecovered = 'root' in tree;
	const root = isRecovered ? tree.root : tree;
	const comments = isRecovered ? tree.tokens.filter(token => token.kind === 'lineComment' || token.kind === 'blockComment').map(token => ({range: token.range, block: token.kind === 'blockComment'})) : tree.comments.map(comment => ({range: comment.range, block: comment.type === 'Block'}));
	const lineStarts = [0];
	for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) {
		lineStarts.push(index + 1);
	}

	function lineAt(offset: number): number {
		let low = 0;
		let high = lineStarts.length;
		while (low < high) {
			const middle = Math.floor((low + high) / 2);
			if (lineStarts[middle]! <= offset) {
				low = middle + 1;
			} else {
				high = middle;
			}
		}

		return low - 1;
	}

	const result: Fold[] = [];
	function add(start: number, end: number, isComment = false): void {
		if (end > start) {
			result.push({start, end, comment: isComment});
		}
	}

	function visit(node: Node | EditorNode): void {
		const isCollection = node.type === 'Array' || (node.type === 'Object' && node.braced) || ((node.type === 'EditorArray' || (node.type === 'EditorObject' && node.braced)) && node.closingRange !== undefined);
		const isBlockString = (node.type === 'String' && node.block) || (node.type === 'EditorScalar' && node.scalarKind === 'string' && ['\'\'\'', '"""'].includes(text.slice(node.range[0], node.range[0] + 3)));
		if (isCollection || isBlockString) {
			add(lineAt(node.range[0]), lineAt(node.range[1]) - 1);
		}

		for (const child of children(node)) {
			visit(child);
		}
	}

	visit(root);
	for (const comment of comments) {
		if (comment.block) {
			add(lineAt(comment.range[0]), lineAt(comment.range[1]) - 1, true);
		}
	}

	// A run of adjacent line comments is useful to fold too.
	let first = -1;
	let last = -1;
	for (const comment of comments) {
		const line = lineAt(comment.range[0]);
		const isStandalone = !comment.block && text.slice(lineStarts[line], comment.range[0]).trim() === '';
		if (!isStandalone || first < 0 || line !== last + 1) {
			add(first, last, true);
			first = isStandalone ? line : -1;
		}

		last = isStandalone ? line : -1;
	}

	add(first, last, true);
	return result.toSorted((left, right) => left.start === right.start ? right.end - left.end : left.start - right.start).slice(0, limit);
}

/**
Selection ranges from the innermost token or comment to the entire document.
*/
export function selectionSpans(tree: DocumentNode | EditorParseResult, offset: number): Span[] {
	const isRecovered = 'root' in tree;
	const root = isRecovered ? tree.root : tree;
	// A cursor at EOF still belongs to the syntax immediately before it.
	if (offset === root.range[1]) {
		offset--;
	}

	if (offset < 0 || offset > root.range[1]) {
		return [];
	}

	const context = isRecovered ? getEditorContext(tree, offset) : undefined;
	const ancestors = context?.ancestors ?? ancestorsAt(root, offset);
	const ranges = ancestors.map(node => node.range);
	const leaf = isRecovered ? context?.token : getNodeAt(tree, offset, ancestors.at(-1) as Node | undefined);
	if (leaf) {
		ranges.push(leaf.range);
	}

	ranges.reverse();
	return ranges.filter((range, index) => index === 0 || range[0] !== ranges[index - 1]![0] || range[1] !== ranges[index - 1]![1]);
}

/**
Decompose an exact duration into fixed units without floating-point arithmetic.
*/
function readableDuration(nanoseconds: bigint): string {
	let remaining = nanoseconds < 0n ? -nanoseconds : nanoseconds;
	const parts: string[] = [];
	const units = [['hour', 3_600_000_000_000n], ['minute', 60_000_000_000n], ['second', 1_000_000_000n], ['millisecond', 1_000_000n], ['microsecond', 1000n], ['nanosecond', 1n]] as const;
	for (const [name, size] of units) {
		const count = remaining / size;
		remaining %= size;
		if (count > 0n) {
			parts.push(`${numberFormat.format(count)} ${name}${count === 1n ? '' : 's'}`);
		}
	}

	return `${nanoseconds < 0n ? '-' : ''}${parts.length > 0 ? parts.join(' ') : '0 seconds'}`;
}

/**
Convert a validated instant to UTC while preserving its exact fractional seconds.
*/
export function instantInUtc(raw: string): string {
	const fraction = /\.(?<fraction>\d+)[+\-Z]/v.exec(raw)?.groups?.['fraction'];
	return new Date(raw).toISOString().replace(/\.\d{3}Z$/v, () => `${fraction === undefined ? '' : `.${fraction}`}Z`);
}

/**
Plain text only; the VS Code adapter escapes this before displaying Markdown.
*/
export function hover(tree: DocumentNode, text: string, offset: number): {text: string; range: Span} | undefined {
	const node = getNodeAt(tree, offset, ancestorsAt(tree, offset).at(-1));
	if (!node) {
		return undefined;
	}

	let description: string;
	switch (node.type) {
		case 'Integer': {
			if (typeof node.value !== 'bigint') {
				return undefined;
			}

			description = `Int (signed 64-bit)\n${numberFormat.format(node.value)}`;
			break;
		}

		case 'Float': {
			if (typeof node.value !== 'number') {
				return undefined;
			}

			description = `Float (64-bit)\n${node.value}`;
			break;
		}

		case 'Duration': {
			if (!('parts' in node)) {
				return undefined;
			}

			// Exact validated nanoseconds are available without Temporal or reparsing source parts.
			const {nanoseconds} = node;
			description = `Duration\n${readableDuration(nanoseconds)}\n${numberFormat.format(nanoseconds)} nanoseconds`;
			break;
		}

		case 'Instant': {
			const raw = text.slice(...node.range);
			description = `Instant\nLocal: ${localDateTimeFormat.format(new Date(raw))}\nUTC: ${instantInUtc(raw)}`;
			break;
		}

		case 'String': {
			if (!('block' in node)) {
				return undefined;
			}

			description = `${node.block ? 'Block string' : 'String'} (${node.style === 'literal' ? 'literal, no escapes' : 'escaped'})`;
			break;
		}

		case 'Boolean': {
			description = `Boolean\n${node.value}`;
			break;
		}

		case 'Null': {
			description = 'Null: a present value, distinct from a missing key.';
			break;
		}

		case 'Key': {
			description = `Key\n${keyPathAt(tree, offset) ?? formatKey(node.value)}`;
			break;
		}

		default: {
			return undefined;
		}
	}

	return {text: description, range: node.range};
}

/**
Searchable full paths, bounded by the same limit as Outline.
*/
export function keyPaths(tree: DocumentNode): Array<{path: string; type: OutlineEntry['type']; range: Span}> {
	const result: Array<{path: string; type: OutlineEntry['type']; range: Span}> = [];
	function visit(entries: OutlineEntry[], parent = ''): void {
		for (const entry of entries) {
			const path = `${parent}${parent !== '' && !entry.name.startsWith('[') ? '.' : ''}${entry.name}`;
			result.push({path, type: entry.type, range: entry.selection});
			visit(entry.children, path);
		}
	}

	visit(outline(tree));
	return result;
}

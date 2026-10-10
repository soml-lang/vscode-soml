import {
	editEdits,
	formatCollectionEdits,
	formatString,
	isBareKey,
	type FormatEdit,
	type DocumentNode,
	type Node,
} from 'soml-lang';
import {
	ancestorsAt,
	instantInUtc,
	type Span,
} from './service.ts';

export type Refactor = {title: string; edits: FormatEdit[]};

/**
Write canonical duration units without rounding or requiring Temporal.
*/
// TODO: Once all supported VS Code hosts provide Temporal, replace manual decomposition with Temporal.Duration balancing to hours and adapt its ISO string to SOML. Construct it from whole seconds and remaining nanoseconds to preserve int64 precision.
function normalizedDuration(nanoseconds: bigint): string {
	let remaining = nanoseconds < 0n ? -nanoseconds : nanoseconds;
	let result = nanoseconds < 0n ? '-' : '';
	for (const [unit, size] of [['h', 3_600_000_000_000n], ['m', 60_000_000_000n]] as const) {
		const count = remaining / size;
		remaining %= size;
		if (count > 0n) {
			result += `${count}${unit}`;
		}
	}

	if (nanoseconds === 0n || remaining > 0n) {
		// The fraction has exactly nine digits, so this suffix match is bounded.
		// eslint-disable-next-line regexp/no-super-linear-move
		const fraction = (remaining % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/v, '');
		result += `${remaining / 1_000_000_000n}${fraction === '' ? '' : `.${fraction}`}s`;
	}

	return result;
}

/**
Write an escaped single-line string, rejecting text SOML cannot represent.
*/
export function escapedString(value: string): string {
	return formatString(value, {style: 'escaped'});
}

/**
Offer explicit, value-preserving changes to the innermost selected syntax.
*/
export function refactors(tree: DocumentNode, text: string, selection: Span): Refactor[] {
	let ancestors = ancestorsAt(tree, selection[0]).filter(node => node.range[1] >= selection[1]);
	if (selection[0] === selection[1]) {
		const previous = ancestorsAt(tree, selection[0] - 1);
		if (previous.at(-1)?.range[1] === selection[0] && previous.length > ancestors.length) {
			ancestors = previous;
		}
	}

	const node = ancestors.at(-1);
	const result: Refactor[] = [];
	function add(title: string, target: Node, replacement: string): void {
		if (text.slice(...target.range) !== replacement) {
			result.push({title, edits: [{range: target.range, text: replacement}]});
		}
	}

	if (node?.type === 'String' && !node.block) {
		if (node.style !== 'escaped') {
			result.push({title: 'Convert to escaped string', edits: editEdits(text, node, node.value, {stringStyle: 'escaped'})});
		}

		if (node.style !== 'literal' && !/[\u{0}-\u{8}\u{A}-\u{1F}'\u{7F}]/v.test(node.value)) {
			result.push({title: 'Convert to literal string', edits: editEdits(text, node, node.value, {stringStyle: 'literal'})});
		}
	}

	if (node?.type === 'Key' && node.style !== 'bare' && isBareKey(node.value)) {
		add('Remove key quotes', node, node.value);
	}

	if (node?.type === 'String') {
		if (node.block) {
			result.push({title: 'Convert to single-line string', edits: editEdits(text, node, node.value)});
		} else {
			result.push({title: 'Convert to block string', edits: editEdits(text, node, node.value, {stringStyle: 'block'})});
		}
	}

	if (node?.type === 'Integer' && node.value >= 0n) {
		for (const [radix, prefix, name] of [[10, '', 'decimal'], [16, '0x', 'hexadecimal'], [8, '0o', 'octal'], [2, '0b', 'binary']] as const) {
			if (node.radix !== radix) {
				add(`Convert to ${name}`, node, prefix + node.value.toString(radix).toUpperCase());
			}
		}
	}

	if (node?.type === 'Integer' && node.radix === 10) {
		const digits = text.slice(...node.range).replaceAll('_', '');
		// Valid int64 source has at most 19 digits after removing separators.
		// eslint-disable-next-line regexp/no-super-linear-move
		const grouped = digits.replaceAll(/\d(?=(?:\d{3})+$)/gv, '$&_');
		if (grouped.includes('_')) {
			add('Group decimal digits', node, grouped);
		}

		add('Remove decimal digit grouping', node, digits);
	}

	if (node?.type === 'Duration') {
		add('Normalize duration', node, normalizedDuration(node.nanoseconds));
	}

	if (node?.type === 'Instant') {
		add('Convert instant to UTC', node, instantInUtc(text.slice(...node.range)));
	}

	const collection = ancestors.findLast(candidate => candidate.type === 'Array' || candidate.type === 'Object');
	if (!collection || (collection.type === 'Object' && !collection.braced)) {
		return result;
	}

	const isMultiline = text.slice(...collection.range).includes('\n');
	// Ask the reference formatter to expand only the selected collection, or compact its subtree.
	// The formatter validates the selected collection before offering edits.
	const edits = formatCollectionEdits({text, root: tree}, collection, {layout: isMultiline ? 'compact' : 'multiline'});
	if (edits !== undefined && edits.length > 0) {
		result.push({title: isMultiline ? 'Compact collection' : 'Expand collection', edits});
	}

	return result;
}

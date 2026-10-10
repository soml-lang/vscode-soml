import process from 'node:process';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import {
	applyEdits,
	format,
	visitorKeys,
	parseForEditor,
} from 'soml-lang';
import {
	analyze,
	formattingEdits,
	outline,
	folds,
	selectionSpans,
	hover,
	keyPaths,
	keyPathAt,
} from '../source/service.ts';
import {tokenize} from '../test/grammar-helper.js';
import {completionItems} from '../source/completion.ts';

await using checkout = process.env.SOML_CONFORMANCE ? undefined : await fs.mkdtempDisposable(path.join(tmpdir(), 'soml-conformance-'));
const directory = process.env.SOML_CONFORMANCE ?? path.join(checkout.path, 'conformance');
if (checkout) {
	console.log('Downloading SOML conformance fixtures…');
	await promisify(execFile)('git', ['clone', '--depth', '1', 'https://github.com/soml-lang/soml.git', checkout.path]);
}

const expectedScopes = {
	BareKey: 'support.type.property-name.', String: 'string.quoted.', Integer: 'constant.numeric.integer.', Float: 'constant.numeric.float.', Instant: 'constant.numeric.instant.', Duration: 'constant.numeric.duration.', Keyword: 'constant.language.', Line: 'comment.line.', Block: 'comment.block.',
};
const punctuation = {
	'{': 'punctuation.definition.object.begin.', '}': 'punctuation.definition.object.end.', '[': 'punctuation.definition.array.begin.', ']': 'punctuation.definition.array.end.', ',': 'punctuation.separator.comma.', ':': 'punctuation.separator.key-value.',
};
let validCount = 0;
let invalidCount = 0;
let encodingCount = 0;
let prefixCount = 0;

function visit(node, callback) {
	callback(node);
	for (const key of visitorKeys[node.type]) {
		for (const child of [node[key]].flat()) {
			visit(child, callback);
		}
	}
}

function assertOutlineRanges(entries, enclosing, file) {
	for (const entry of entries) {
		assert.ok(entry.range[0] >= enclosing[0] && entry.range[1] <= enclosing[1], `${file}: symbol outside parent`);
		assert.ok(entry.selection[0] >= entry.range[0] && entry.selection[1] <= entry.range[1] && entry.selection[1] > entry.selection[0], `${file}: invalid symbol selection`);
		assertOutlineRanges(entry.children, entry.range, file);
	}
}

for (const category of ['valid', 'invalid']) {
	const entries = await fs.readdir(path.join(directory, category), {recursive: true});
	const files = entries.filter(file => file.endsWith('.soml'));
	assert.ok(files.length > 100, `Missing conformance fixtures in ${directory}/${category}`);
	for (const file of files) {
		const bytes = await fs.readFile(path.join(directory, category, file));
		let text;
		// eslint-disable-next-line node-test/prefer-assert-throws -- Invalid byte fixtures are counted and skipped, not asserted to throw.
		try {
			text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes);
		} catch {
			// VS Code provides decoded text, so byte-level encoding validation belongs to the file reader.
			assert.equal(category, 'invalid', file);
			encodingCount++;
			continue;
		}

		const analysis = analyze(text);
		if (category === 'invalid') {
			assert.ok(analysis.problem, file);
			assert.deepEqual(formattingEdits(text), [], file);
			invalidCount++;
			continue;
		}

		assert.ok(analysis.tree, `${file}: ${analysis.problem?.message}`);
		const {tree} = analysis;
		const formatted = applyEdits(text, formattingEdits(text));

		assert.equal(formatted, format(text), file);
		if (!file.endsWith('.formatted.soml') && !file.endsWith('.canonical.soml')) {
			const expectedPath = path.join(directory, category, file.replace(/\.soml$/v, '.formatted.soml'));
			try {
				assert.equal(formatted, await fs.readFile(expectedPath, 'utf8'), `${file}: specification formatter fixture`);
			} catch (error) {
				if (error.code !== 'ENOENT') {
					throw error;
				}
			}
		}

		assert.deepEqual(formattingEdits(formatted), [], file);
		assert.ok(analyze(formatted).tree, file);
		assertOutlineRanges(outline(tree), tree.range, file);
		const lineCount = text.split('\n').length;
		for (const fold of folds(tree, text)) {
			assert.ok(fold.start >= 0 && fold.end > fold.start && fold.end < lineCount, `${file}: invalid fold`);
		}

		for (const entry of keyPaths(tree)) {
			assert.equal(keyPathAt(tree, entry.range[0]), entry.path, `${file}: navigation path does not match its target`);
		}

		for (const offset of [0, text.length]) {
			const spans = selectionSpans(tree, offset);
			assert.ok(spans.length > 0, `${file}: no selection at document boundary`);
			for (const [index, [start, end]] of spans.entries()) {
				assert.ok(start <= offset && offset <= end, `${file}: selection does not contain cursor`);
				if (index > 0) {
					assert.ok(start <= spans[index - 1][0] && end >= spans[index - 1][1], `${file}: invalid boundary selection nesting`);
				}
			}
		}

		const keys = new Set();
		visit(tree, node => {
			if (node.type === 'Key') {
				keys.add(node.range[0]);
			}

			hover(tree, text, node.range[0]);
			const spans = selectionSpans(tree, node.range[0]);
			for (let index = 1; index < spans.length; index++) {
				assert.ok(spans[index][0] <= spans[index - 1][0] && spans[index][1] >= spans[index - 1][1], `${file}: invalid selection nesting`);
			}
		});

		const tokens = tokenize(text);
		assert.ok(tokens.every(token => token.scopes.every(scope => !scope.startsWith('invalid.'))), `${file}: valid token marked invalid`);
		for (const token of [...tree.tokens, ...tree.comments]) {
			const expected = keys.has(token.range[0]) ? 'support.type.property-name.' : (token.type === 'Punctuator' ? punctuation[token.value] : expectedScopes[token.type]);
			for (const highlighted of tokens) {
				if (highlighted.end <= token.range[0] || highlighted.start >= token.range[1]) {
					continue;
				}

				assert.ok(highlighted.scopes.some(scope => scope.startsWith(expected)), `${file}: ${JSON.stringify(highlighted.text)} should have ${expected}`);
			}
		}

		validCount++;
		// Typing prefixes exercise incomplete strings, escapes, and collection boundaries.
		if (text.length <= 1000) {
			for (let offset = 0; offset <= text.length; offset++) {
				const prefix = text.slice(0, offset);
				for (const item of completionItems(parseForEditor(prefix), offset)) {
					assert.ok(item.range[0] >= 0 && item.range[0] <= offset && item.range[1] === offset, `${file}:${offset}: invalid completion range`);
					assert.ok(!prefix.slice(...item.range).includes('\n'), `${file}:${offset}: multiline completion range`);
				}

				const {problem} = analyze(prefix);
				if (problem) {
					assert.ok(problem.range[0] >= 0 && problem.range[0] <= problem.range[1] && problem.range[1] <= prefix.length, `${file}:${offset}: invalid diagnostic range`);
				}

				formattingEdits(prefix);
				prefixCount++;
			}
		}
	}
}

console.log(`Conformance passed: ${validCount} valid documents, ${invalidCount} invalid documents, ${prefixCount} typing prefixes; ${encodingCount} byte-encoding fixtures excluded from editor text validation.`);

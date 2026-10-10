import test from 'node:test';
import assert from 'node:assert/strict';
import {
	applyEdits,
	parse,
	parseTree,
	parseForEditor,
	stringify,
	stringifyValue,
	isBareKey,
	visitorKeys,
} from 'soml-lang';
import {completionItems} from '../source/completion.ts';
import {refactors} from '../source/refactor.ts';

const scalars = ['0', '123', '0xFF', '0b101', '0o777', '-123', '9_007_199_254_740_993', '0.0', '-0.0', '1e-3', 'true', 'false', 'null', 'infinity', '-infinity', '\'\'', '""', '\'😀\'', String.raw`"\u{0}\t\n\\\""`, '1h30m', '2026-01-01T01:00:00.123456789+01:00', '\'\'\'\nblock: [true] # text\n\'\'\'', '"""\nescaped\\ncontent\n"""'];
const keyNames = ['404', '2026-01-01', '-dash', '__proto__', 'constructor', '😀', 'a.b', 'key\nline', 'a.$}', '', 'true', 'infinity', '[0]', 'a:b', '\\', '"', '\''];
const blanks = [' ', '\t', '\n', ' /* note */ ', ' /* multiline\nnote */ ', ' # note\n', ''];
const separators = [',', ', ', ',\n', '\n', '\n\t', ', /* note */ ', ' # note\n', '\n/* note */\n'];

for (const quote of ['\'', '"']) {
	for (let width = 4; width <= 8; width++) {
		const delimiter = quote.repeat(width);
		scalars.push(`${delimiter}\n${quote.repeat(width - 1)}\n${quote.repeat(width + 1)}\n# content\n${delimiter}`);
	}
}

function * documents(seed) {
	function pick(values) {
		// eslint-disable-next-line no-bitwise -- Keep the deterministic generator in unsigned 32-bit arithmetic.
		seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
		return values[Math.floor(seed / 0x1_00_00_00_00 * values.length)];
	}

	function value(depth = 0) {
		if (depth >= 3 || pick([false, false, true])) {
			return pick(scalars);
		}

		const object = pick([true, false]);
		const entries = [];
		const count = pick([0, 1, 2, 3]);
		for (let index = 0; index < count; index++) {
			let prefix = '';
			if (object) {
				const name = pick(keyNames) + index;
				const key = isBareKey(name) && pick([true, false]) ? name : stringifyValue(name);
				prefix = `${key}:${pick(blanks)}`;
			}

			entries.push(prefix + value(depth + 1));
		}

		return (object ? '{' : '[') + pick(blanks) + entries.join(pick(separators)) + pick(blanks) + (object ? '}' : ']');
	}

	for (let index = 0; index < 300; index++) {
		yield pick(['', '# before\n', '/* before */ ']) + (pick([true, false]) ? `a: ${value()}` : `[${value()},${value()}]`) + pick(['', '\n', ' # after']);
	}
}

function memberOrder(tree) {
	const result = [];
	const nodes = [tree];

	for (const node of nodes) {
		if (node.type === 'Object') {
			result.push(node.members.map(member => member.key.value));
		}

		for (const key of visitorKeys[node.type]) {
			// eslint-disable-next-line unicorn/no-loop-iterable-mutation -- The growing array is the traversal queue.
			nodes.push(...[node[key]].flat());
		}
	}

	return result;
}

for (const seed of [194_431, 874_521]) {
	test(`generated authoring edits preserve valid documents (seed ${seed})`, () => {
		// The integration suite checks actual snippet expansion; here we apply each template's default value.
		const defaults = {
			integer: '0', float: '0.0', string: '\'text\'', array: '[]', object: '{key: null}', duration: '30s', instant: '2026-01-01T00:00:00Z',
		};
		let completions = 0;
		let actions = 0;
		for (const text of documents(seed)) {
			const tree = parseTree(text);
			const snapshot = parseForEditor(text);
			const original = stringify(parse(text));
			const keys = memberOrder(tree);
			for (let offset = 0; offset <= text.length; offset++) {
				for (const item of completionItems(snapshot, offset)) {
					const replacement = item.snippet && item.detail === 'Key from another object in this array' ? `${item.label}: null` : defaults[item.label] ?? item.insertText;
					const changed = text.slice(0, item.range[0]) + replacement + text.slice(item.range[1]);
					assert.doesNotThrow(() => parseTree(changed), `${item.label} at ${offset} in ${JSON.stringify(text)}`);
					assert.equal(item.range[0] <= offset && offset <= item.range[1], true);
					assert.equal(text.slice(...item.range).includes('\n'), false);
					completions++;
				}

				for (const action of refactors(tree, text, [offset, offset])) {
					const changed = applyEdits(text, action.edits);

					assert.equal(stringify(parse(changed)), original, action.title);
					// JavaScript reorders integer-like object keys, so compare syntax-tree order separately.
					assert.deepEqual(memberOrder(parseTree(changed)), keys, action.title);
					actions++;
				}
			}
		}

		assert.equal(completions > 0, true);
		assert.equal(actions > 0, true);
	});
}

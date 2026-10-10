import test from 'node:test';
import assert from 'node:assert/strict';
import {
	applyEdits,
	format,
	getNodeAtPath,
	parse,
	parseTree,
	stringify,
} from 'soml-lang';
import {escapedString, refactors} from '../source/refactor.ts';

function actions(text, offset = 0, end = offset) {
	return refactors(parseTree(text), text, [offset, end]);
}

function apply(text, action) {
	const result = applyEdits(text, action.edits);
	parseTree(result);
	return result;
}

test('repeated string and collection refactors compose with document formatting', () => {
	for (const value of [
		'plain',
		'😀\ntext with \'\'\' and "quotes"',
		'\t\u{0} trailing spaces  ',
	]) {
		let text = `# before\nvalues: [{value: ${escapedString(value)}, other: 0xFF}] # after\n`;
		const expected = stringify(parse(text));
		for (let round = 0; round < 3; round++) {
			for (const title of [
				'Convert to block string',
				'Convert to single-line string',
				'Compact collection',
				'Expand collection',
			]) {
				const node = getNodeAtPath(parseTree(text), ['values', 0, 'value']);
				const action = actions(text, node.range[0]).find(candidate => candidate.title === title);
				assert.ok(action, title);
				text = format(apply(text, action));
				assert.equal(stringify(parse(text)), expected, title);
				assert.equal(text.includes('other: 0xFF'), true);
				assert.deepEqual(parseTree(text).comments.map(comment => comment.value), [' before', ' after']);
			}
		}
	}
});

test('expand preserves compact children, comment text, number spelling, and unrelated source', () => {
	const text = 'a: [0xFF, /* note */ {x: 1_000}] # tail\nb:  2';
	const action = actions(text, 3).find(candidate => candidate.title === 'Expand collection');
	const result = apply(text, action);
	assert.equal(result.includes('0xFF'), true);
	assert.equal(result.includes('/* note */'), true);
	assert.equal(result.includes('{x: 1_000}'), true);
	assert.equal(result.endsWith('# tail\nb:  2'), true);
	assert.equal(result.includes('\n'), true);
});

test('compact nested collections preserves tokens and member order', () => {
	const text = 'a: [\n{z: 0xFF\na: 1.00}\n-2\n]\nb: 0';
	const action = actions(text, 3).find(candidate => candidate.title === 'Compact collection');
	assert.equal(apply(text, action), 'a: [{z: 0xFF, a: 1.00}, -2]\nb: 0');
});

test('collection layouts preserve signed float zero, infinities, and their source spelling', () => {
	const text = 'values: [-0.0, 0.000, infinity, -infinity]';
	const expected = parse(text);
	const expanded = apply(text, actions(text, text.indexOf('[')).find(candidate => candidate.title === 'Expand collection'));
	assert.equal(expanded, 'values: [\n\t-0.0\n\t0.000\n\tinfinity\n\t-infinity\n]');
	assert.deepEqual(parse(expanded), expected);
	const compacted = apply(expanded, actions(expanded, expanded.indexOf('[')).find(candidate => candidate.title === 'Compact collection'));
	assert.equal(compacted, text);
	assert.deepEqual(parse(compacted), expected);
});

test('compaction refuses comments and block strings anywhere inside the collection', () => {
	for (const text of ['[\n1 # comment\n]', '[\n{a:\n\'\'\'\ntext\n\'\'\'}\n]']) {
		assert.equal(actions(text).some(candidate => candidate.title === 'Compact collection'), false);
	}
});

test('quote conversions preserve escaped controls, backslashes, and Unicode', () => {
	for (const text of [String.raw`a: 'C:\Users\😀'`, String.raw`a: "\u{0}\t\n"`, '\'a.b\': \'hello\'']) {
		const original = parseTree(text).body.members[0];
		for (const offset of [0, original.value.range[0]]) {
			for (const action of actions(text, offset)) {
				const member = parseTree(apply(text, action)).body.members[0];
				assert.equal(member.key.value, original.key.value);
				assert.equal(member.value.value, original.value.value);
			}
		}
	}
});

test('escaped string conversion is available for values but never keys', () => {
	for (const key of ['name', '\'name\'', '"name"']) {
		const text = `${key}: 'value'`;
		for (const [start, end] of [[0, 0], [1, 1], [0, key.length], [key.length, key.length]]) {
			assert.equal(actions(text, start, end).some(candidate => candidate.title === 'Convert to escaped string'), false);
		}

		const action = actions(text, key.length + 2).find(candidate => candidate.title === 'Convert to escaped string');
		assert.ok(action);
		assert.equal(apply(text, action), `${key}: "value"`);
	}
});

test('literal string conversion is available for values but never keys', () => {
	for (const key of ['name', '\'name\'', '"name"']) {
		const text = `${key}: "value"`;
		for (const [start, end] of [[0, 0], [1, 1], [0, key.length], [key.length, key.length]]) {
			assert.equal(actions(text, start, end).some(candidate => candidate.title === 'Convert to literal string'), false);
		}

		const action = actions(text, key.length + 2).find(candidate => candidate.title === 'Convert to literal string');
		assert.ok(action);
		assert.equal(apply(text, action), `${key}: 'value'`);
	}
});

test('literal quotes and bare keys are offered only when representable', () => {
	assert.equal(actions('a: "it\'s"', 4).some(candidate => candidate.title === 'Convert to literal string'), false);
	assert.equal(actions('\'a.b\': 1').some(candidate => candidate.title === 'Remove key quotes'), false);
	assert.equal(actions('\'a\': 1').some(candidate => candidate.title === 'Remove key quotes'), true);
	assert.equal(actions('a:\n\'\'\'\ntext\n\'\'\'', 4).some(candidate => candidate.title === 'Convert to single-line string'), true);
});

test('selection spanning values does not refactor only the first value', () => {
	const text = 'a: \'one\'\nb: \'two\'';
	assert.deepEqual(actions(text, 3, text.length), []);
});

test('refactors remain available at the end of a token or document', () => {
	const text = 'a: \'hello\'';
	assert.equal(actions(text, text.length).some(candidate => candidate.title === 'Convert to escaped string'), true);
	assert.equal(actions('[1]', 3).some(candidate => candidate.title === 'Expand collection'), true);
});

test('radix conversions preserve exact nonnegative int64 values and use uppercase hex digits', () => {
	for (const literal of ['0', '255', '9_007_199_254_740_993', '0x7FFFFFFFFFFFFFFF', '0o644', '0b1010']) {
		const text = `a: ${literal}`;
		const before = parseTree(text).body.members[0].value;
		const conversions = actions(text, 3).filter(candidate => candidate.title.startsWith('Convert to'));
		assert.equal(conversions.length, 3);
		for (const action of conversions) {
			const after = parseTree(apply(text, action)).body.members[0].value;
			assert.equal(after.value, before.value);
			assert.notEqual(after.radix, before.radix);
		}
	}

	assert.equal(actions('a: 255', 3).find(candidate => candidate.title === 'Convert to hexadecimal').edits[0].text, '0xFF');
	for (const text of ['a: -1', 'a: -9223372036854775808', 'a: 1.0']) {
		assert.equal(actions(text, 3).some(candidate => candidate.title.startsWith('Convert to')), false);
	}
});

test('all applicable refactors preserve whole-document values, key order, and comments', () => {
	const texts = [
		'before: 9\na: [{nested: [0x7FFFFFFFFFFFFFFF, \'C:\\path\']}, true]\nafter: false',
		'a: [\n{controls: "\\u{0}\\u{7f}\\t\\n", unicode: \'😀\'}\n[false, 0.0]\n]',
		'a: [1, /* note */ {x: \'value\'}] # tail\nb: 0',
	];
	for (const text of texts) {
		const tree = parseTree(text);
		const original = stringify(parse(text));
		const comments = tree.comments.map(comment => text.slice(...comment.range));
		let count = 0;
		for (let offset = 0; offset <= text.length; offset++) {
			for (const action of refactors(tree, text, [offset, offset])) {
				const changed = apply(text, action);
				assert.equal(stringify(parse(changed)), original, action.title);
				assert.deepEqual(parseTree(changed).comments.map(comment => changed.slice(...comment.range)), comments, action.title);
				count++;
			}
		}

		assert.equal(count > 0, true);
	}
});

test('duration normalization preserves exact values and surrounding source', () => {
	for (const [literal, expected] of [
		['90m', '1h30m'],
		['1500ms', '1.5s'],
		['250us', '0.00025s'],
		['1ns', '0.000000001s'],
		['0.0000000001h', '0.00000036s'],
		['1h120m', '3h'],
		['-90m', '-1h30m'],
		['-1ns', '-0.000000001s'],
		['0h0m0.000s', '0s'],
		['1_500.000000000000ms', '1.5s'],
		['9223372036854775807ns', '2562047h47m16.854775807s'],
		['-9223372036854775808ns', '-2562047h47m16.854775808s'],
	]) {
		const text = `before: '😀'\nvalue: ${literal} # keep\nafter:  1`;
		const start = text.indexOf(literal);
		const action = actions(text, start, start + literal.length).find(candidate => candidate.title === 'Normalize duration');
		assert.ok(action, literal);
		assert.equal(action.edits[0].text, expected);
		const changed = apply(text, action);
		assert.equal(changed, text.replace(literal, () => expected));
		assert.equal(stringify(parse(changed)), stringify(parse(text)));
		assert.equal(actions(changed, start).some(candidate => candidate.title === 'Normalize duration'), false);
	}
});

test('UTC conversion preserves nanoseconds across calendar boundaries', () => {
	for (const [literal, expected] of [
		['2026-10-11T14:00:00.123456789+07:00', '2026-10-11T07:00:00.123456789Z'],
		['2024-03-01T00:15:00+00:30', '2024-02-29T23:45:00Z'],
		['2025-12-31T23:30:00.000000001-01:00', '2026-01-01T00:30:00.000000001Z'],
		['0001-01-01T01:00:00+01:00', '0001-01-01T00:00:00Z'],
		['9999-12-31T22:59:59.999999999-01:00', '9999-12-31T23:59:59.999999999Z'],
		['2026-01-01T00:00:00.1200+00:00', '2026-01-01T00:00:00.1200Z'],
	]) {
		const text = `value: ${literal} # keep\nother: 1`;
		const action = actions(text, 7).find(candidate => candidate.title === 'Convert instant to UTC');
		assert.ok(action, literal);
		assert.equal(action.edits[0].text, expected);
		const changed = apply(text, action);
		assert.equal(changed, text.replace(literal, () => expected));
		assert.equal(Temporal.Instant.from(action.edits[0].text).epochNanoseconds, Temporal.Instant.from(literal).epochNanoseconds);
		assert.equal(actions(changed, 7).some(candidate => candidate.title === 'Convert instant to UTC'), false);
	}
});

test('temporal refactors respect selection boundaries and suppress unchanged values', () => {
	for (const text of ['a: 1h30m', 'a: 0s', 'a: -1.5s', 'a: 2026-01-01T00:00:00.000Z', 'a: \'90m\'', '# 90m\na: 1']) {
		assert.equal(actions(text, 3).some(candidate => candidate.title === 'Normalize duration' || candidate.title === 'Convert instant to UTC'), false);
	}

	const text = 'a: 90m\nb: 120m';
	assert.deepEqual(actions(text, 3, text.length), []);
	assert.equal(actions(text, text.length).some(candidate => candidate.title === 'Normalize duration'), true);
	assert.equal(actions('a: [90m]', 4).some(candidate => candidate.title === 'Normalize duration'), true);
});

test('escaped clipboard strings round-trip without changing decoded text', () => {
	for (const value of ['', String.raw`C:\Users\Alice`, 'one\ntwo\n', '"quotes" and \'quotes\'', '\t\u{0}\u{8}\u{B}\u{C}\u{7F}', '😀\u{FFFF}', '${1:snippet}$TM_FILENAME']) {
		const encoded = escapedString(value);
		assert.equal(encoded.startsWith('"') && encoded.endsWith('"'), true);
		assert.equal(encoded.includes('\n'), false);
		assert.equal(parseTree(`value: ${encoded}`).body.members[0].value.value, value);
	}

	for (const value of ['\r', 'a\r\nb', '\u{D800}', '\u{DC00}', '😀\u{D800}']) {
		assert.throws(() => escapedString(value), TypeError);
	}
});

test('decimal digit grouping preserves exact signed int64 values and surrounding text', () => {
	for (const [literal, grouped] of [
		['1000', '1_000'],
		['1000000', '1_000_000'],
		['9007199254740993', '9_007_199_254_740_993'],
		['9223372036854775807', '9_223_372_036_854_775_807'],
		['-9223372036854775808', '-9_223_372_036_854_775_808'],
		['-1000', '-1_000'],
		['1_00_00', '10_000'],
	]) {
		const text = `value: ${literal} # keep\nother:  0`;
		const action = actions(text, 7, 7 + literal.length).find(candidate => candidate.title === 'Group decimal digits');
		assert.ok(action);
		const changed = apply(text, action);
		assert.equal(changed, text.replace(literal, () => grouped));
		assert.equal(parseTree(changed).body.members[0].value.value, BigInt(literal.replaceAll('_', '')));
		assert.equal(actions(changed, 7).some(candidate => candidate.title === 'Group decimal digits'), false);
		const remove = actions(changed, 7).find(candidate => candidate.title === 'Remove decimal digit grouping');
		assert.equal(apply(changed, remove), text.replace(literal, () => literal.replaceAll('_', '')));
	}
});

test('digit grouping is decimal-integer-only and suppresses no-op edits', () => {
	for (const literal of ['0', '12', '-123', '1.234', '1_000.0', '1e10', '1000ms', '0x1234', '0b1000', '\'1000\'']) {
		assert.equal(actions(`value: ${literal}`, 7).some(candidate => candidate.title.includes('digit')), false);
	}

	assert.equal(actions('value: 1_2', 7).find(candidate => candidate.title === 'Remove decimal digit grouping').edits[0].text, '12');
	assert.equal(actions('value: 1_000', 7).some(candidate => candidate.title === 'Group decimal digits'), false);
	const text = 'a: 1000\nb: 2000';
	assert.equal(actions(text, 3, text.length).some(candidate => candidate.title.includes('digit')), false);
	assert.equal(actions('a: -1000', 8).some(candidate => candidate.title === 'Group decimal digits'), true);
});

for (const value of ['', 'hello\nworld', '\nhello\n', ' \t ', 'before\n\'\'\'\nafter', String.raw`C:\path`, '\u{0}', '😀', 'a\n \t\nb']) {
	test(`string and block-string refactors preserve ${JSON.stringify(value)}`, () => {
		const text = `outer: [{value: ${escapedString(value)}, next: 0xFF}] # keep`;
		const offset = text.indexOf(': ', text.indexOf('value')) + 2;
		const block = actions(text, offset).find(candidate => candidate.title === 'Convert to block string');
		assert.ok(block);
		const changed = apply(text, block);
		assert.deepEqual(parse(changed), parse(text));
		assert.equal(changed.endsWith(', next: 0xFF}] # keep'), true);
		const single = actions(changed, parseTree(changed).body.members[0].value.elements[0].members[0].value.range[0]).find(candidate => candidate.title === 'Convert to single-line string');
		assert.ok(single);
		assert.deepEqual(parse(apply(changed, single)), parse(text));
	});
}

test('single-line conversion moves a block string beside its key', () => {
	const text = 'not-found-page:\n\t\t\'\'\'\n\t\t<!doctype html>\n\t\t<title>Not found</title>\n\t\t<h1>This site does not exist</h1>\n\t\t<p>It may have been removed, or its name may have changed.</p>\n\t\t\'\'\'';
	const action = actions(text, text.indexOf('\'\'\'')).find(candidate => candidate.title === 'Convert to single-line string');
	const changed = apply(text, action);
	assert.equal(changed, String.raw`not-found-page: "<!doctype html>\n<title>Not found</title>\n<h1>This site does not exist</h1>\n<p>It may have been removed, or its name may have changed.</p>"`);
	assert.deepEqual(parse(changed), parse(text));
});

test('single-line conversion preserves surrounding source and comments between key and value', () => {
	for (const [text, expected] of [
		['outer: {\n\tvalue:\n\t\t\'\'\'\n\t\thello\n\t\t\'\'\' # keep\n\tnext:  1\n}', 'outer: {\n\tvalue: \'hello\' # keep\n\tnext:  1\n}'],
		['\'key: with colon\':\n\t\'\'\'\n\thello\n\t\'\'\'', '\'key: with colon\': \'hello\''],
		['value: \'\'\'\nhello\n\'\'\'', 'value: \'hello\''],
		['value: # keep\n\t\'\'\'\n\thello\n\t\'\'\'', 'value: # keep\n\t\'hello\''],
		['value: /* keep */\n\t\'\'\'\n\thello\n\t\'\'\'', 'value: /* keep */\n\t\'hello\''],
		['values: [\n\t\'\'\'\n\thello\n\t\'\'\'\n]', 'values: [\n\t\'hello\'\n]'],
	]) {
		const action = actions(text, text.indexOf('\'\'\'')).find(candidate => candidate.title === 'Convert to single-line string');
		const changed = apply(text, action);
		assert.equal(changed, expected);
		assert.deepEqual(parse(changed), parse(text));
	}
});

test('block-string conversion puts the opening delimiter on the next line', () => {
	const text = 'value: "hello\\nworld" # keep\nnext:  1';
	const action = actions(text, text.indexOf('"')).find(candidate => candidate.title === 'Convert to block string');
	const changed = apply(text, action);
	assert.equal(changed, 'value:\n\t\'\'\'\n\thello\n\tworld\n\t\'\'\' # keep\nnext:  1');
	assert.deepEqual(parse(changed), parse(text));
});

test('block-string conversion preserves existing line breaks and surrounding comments', () => {
	for (const [text, expected] of [
		['value:\n\t"hello"', 'value:\n\t\'\'\'\n\thello\n\t\'\'\''],
		['["hello", 1]', '[\n\t\'\'\'\n\thello\n\t\'\'\', 1]'],
		['[\n\t"hello"\n]', '[\n\t\'\'\'\n\thello\n\t\'\'\'\n]'],
		['value: /* before */ "hello" # after', 'value: /* before */\n\t\'\'\'\n\thello\n\t\'\'\' # after'],
		['value: # before\n\t"hello"', 'value: # before\n\t\'\'\'\n\thello\n\t\'\'\''],
	]) {
		const action = actions(text, text.indexOf('"')).find(candidate => candidate.title === 'Convert to block string');
		const changed = apply(text, action);
		assert.equal(changed, expected);
		assert.deepEqual(parse(changed), parse(text));
	}
});

test('block-string refactors preserve indentation and cannot target keys', () => {
	const text = 'outer: {\n\tvalue: "hello\\nworld"\n}';
	const offset = text.indexOf('"');
	const action = actions(text, offset).find(candidate => candidate.title === 'Convert to block string');
	assert.equal(action.edits[0].text, '\n\t\t\'\'\'\n\t\thello\n\t\tworld\n\t\t\'\'\'');
	assert.deepEqual(parse(apply(text, action)), parse(text));
	assert.equal(actions('\'key\': \'value\'', 1).some(candidate => candidate.title === 'Convert to block string'), false);
});

test('explicit expansion respects a collection starting below its key', () => {
	for (const [text, expected] of [
		['values: # items\n\t[1, 2]', 'values: # items\n\t[\n\t\t1\n\t\t2\n\t]'],
		['values:\n\t[1, 2]', 'values:\n\t[\n\t\t1\n\t\t2\n\t]'],
		['outer: # outer\n\t{\n\t\tvalues: # items\n\t\t\t[1, 2]\n\t}', 'outer: # outer\n\t{\n\t\tvalues: # items\n\t\t\t[\n\t\t\t\t1\n\t\t\t\t2\n\t\t\t]\n\t}'],
	]) {
		const action = actions(text, text.indexOf('[')).find(candidate => candidate.title === 'Expand collection');
		assert.equal(apply(text, action), expected);
		assert.deepEqual(parse(expected), parse(text));
	}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {applyEdits, parse, parseForEditor} from 'soml-lang';
import {typingIndentation} from '../source/indentation.ts';

function afterTyping(source, character = '\n', unit = '\t') {
	const offset = source.indexOf('|');
	const text = source.replace('|', '');
	const edits = typingIndentation(parseForEditor(text), offset, character, unit);
	return applyEdits(text, edits);
}

for (const [source, expected] of [
	['key:\n|', 'key:\n\t'],
	['key: # explanation\n|', 'key: # explanation\n\t'],
	['\'quoted:key\':\n|', '\'quoted:key\':\n\t'],
	['key: /* explanation */\n|', 'key: /* explanation */\n\t'],
	['outer: {\n\tkey:\n\t|', 'outer: {\n\tkey:\n\t\t'],
	['key:\n\ttrue\n\t|', 'key:\n\ttrue\n'],
	['key:\n\ttrue # done\n\t|', 'key:\n\ttrue # done\n'],
	['key:\n\t[1]\n\t|', 'key:\n\t[1]\n'],
	['key: [ # items\n|', 'key: [ # items\n\t'],
	['key: [\n\t1,\n|', 'key: [\n\t1\n\t'],
	['key: [\n|]', 'key: [\n\t]'],
	['key:\n\t\'\'\'\n\tcontent\n\t\'\'\'\n\t|', 'key:\n\t\'\'\'\n\tcontent\n\t\'\'\'\n'],
]) {
	test(`typing indentation ${JSON.stringify(source)}`, () => {
		assert.equal(afterTyping(source), expected);
	});
}

for (const source of [
	'key: \'\'\'\n|',
	'key:\n\t\'\'\'\n\t|',
	'key: \'\'\'\ntext:\n|\n\'\'\'',
	'key: \'\'\'\n[\n|\n\'\'\'',
	'key: \'\'\'\n\ttext\n\t|\n\'\'\'',
	'key: """\ntext:\n|\n"""',
	'# comment:\n|',
	'/* comment:\n|\n*/',
	'key: true\n|',
	'key: "unfinished\n|',
]) {
	test(`preserves content indentation ${JSON.stringify(source)}`, () => {
		assert.equal(afterTyping(source), source.replace('|', ''));
	});
}

test('Enter after a comma expands arrays and objects', () => {
	for (const [source, expected] of [
		['[\'example.com\',\n| \'contractors.example.com\']', '[\n\t\'example.com\'\n\t\'contractors.example.com\'\n]'],
		['from: {address: \'quarry@example.com\',\n| name: \'Quarry\'}', 'from: {\n\taddress: \'quarry@example.com\'\n\tname: \'Quarry\'\n}'],
	]) {
		const result = afterTyping(source);
		assert.equal(result, expected);
		assert.deepEqual(parse(result), parse(source.replace('|', '')));
	}
});

test('Enter removes a separator comma before the new line', () => {
	assert.equal(afterTyping('from: {\n\taddress: \'quarry@example.com\',\n\t|name: \'Quarry\'\n}'), 'from: {\n\taddress: \'quarry@example.com\'\n\tname: \'Quarry\'\n}');
	assert.equal(afterTyping('from: {\n\taddress: \'quarry@example.com\',\n\t| name: \'Quarry\'\n}'), 'from: {\n\taddress: \'quarry@example.com\'\n\tname: \'Quarry\'\n}');
	assert.equal(afterTyping('a: 1,\n|b: 2'), 'a: 1\nb: 2');
	assert.equal(afterTyping('a:\n\t1,\n\t|b: 2'), 'a:\n\t1\nb: 2');
});

test('Enter expands collections while preserving values and comments', () => {
	for (const [source, expected] of [
		['[1,\n|2]', '[\n\t1\n\t2\n]'],
		['[1,\n\t|2]', '[\n\t1\n\t2\n]'],
		['[1, # keep,\n\t|2]', '[\n\t1 # keep,\n\t2\n]'],
		['[1, /* keep, */\n\t|2]', '[\n\t1 /* keep, */\n\t2\n]'],
		['[1 /* keep */,\n\t|2]', '[\n\t1 /* keep */\n\t2\n]'],
		['[[1],\n\t|[2]]', '[\n\t[1]\n\t[2]\n]'],
		['[{a: 1},\n\t|{b: 2}]', '[\n\t{a: 1}\n\t{b: 2}\n]'],
		['outer: {\n\t\tvalue: [1],\n\t\t|next: 2\n}', 'outer: {\n\tvalue: [1]\n\tnext: 2\n}'],
	]) {
		const result = afterTyping(source);
		assert.equal(result, expected);
		assert.deepEqual(parse(result), parse(source.replace('|', '')));
	}
});

test('Enter skips consecutive completed trailing comments without changing their content', () => {
	for (const [source, expected] of [
		['key: /* first, */ /* second: */\n|true', 'key: /* first, */ /* second: */\n\ttrue'],
		['[1, /* first, */ /* second: */\n|2]', '[\n\t1 /* first, */ /* second: */\n\t2\n]'],
	]) {
		const result = afterTyping(source);
		assert.equal(result, expected);
		assert.deepEqual(parse(result), parse(source.replace('|', '')));
	}
});

test('Enter preserves commas in string and comment content', () => {
	for (const source of [
		'value: \'\'\'\ntext,\n|\n\'\'\'',
		'value: """\ntext,\n|\n"""',
		'value: "unfinished,\n|',
		'# comment,\n|',
		'/* comment,\n|\n*/',
		'value: \'text,\' # comment,\n|',
	]) {
		assert.equal(afterTyping(source), source.replace('|', ''));
	}
});

test('Enter formats only the owning collection and preserves unfinished input', () => {
	for (const [source, expected] of [
		['before:  1\nvalues: [1,\n| 2]\nafter:  3', 'before:  1\nvalues: [\n\t1\n\t2\n]\nafter:  3'],
		['outer: {values: [1,\n| 2], other:  3}', 'outer: {values: [\n\t\t1\n\t\t2\n\t], other:  3}'],
		['[{a:1,b:2},\n| {c:3}]', '[\n\t{a: 1, b: 2}\n\t{c: 3}\n]'],
		['[1,\n|', '[1\n\t'],
		['[1,\n|]', '[1\n\t]'],
		['[1,\n|\n2]', '[1\n\t\n2]'],
		['broken: ?\nvalues: {a:1,\n|b:2}', 'broken: ?\nvalues: {\n\ta: 1\n\tb: 2\n}'],
		['values: [1,\n|2]\nbroken:', 'values: [\n\t1\n\t2\n]\nbroken:'],
	]) {
		assert.equal(afterTyping(source), expected);
	}

	assert.equal(afterTyping('[1,\n|2]', '\n', '  '), '[\n\t1\n\t2\n]');
});

test('closing collection delimiters align with their opening line', () => {
	for (const [source, expected] of [['a: [\n\t1\n\t]|', 'a: [\n\t1\n]'], ['a: {\n\tx: 1\n\t}|', 'a: {\n\tx: 1\n}'], ['a: {\n\tb: [\n\t\t1\n\t\t]|\n}', 'a: {\n\tb: [\n\t\t1\n\t]\n}']]) {
		assert.equal(afterTyping(source, source[source.indexOf('|') - 1]), expected);
	}

	for (const source of ['a: \'\'\'\n\t]|\n\'\'\'', '# }|', 'a: [1]|']) {
		assert.equal(afterTyping(source, source[source.indexOf('|') - 1]), source.replace('|', ''));
	}
});

test('typing honors spaces and leaves out-of-range positions alone', () => {
	assert.equal(afterTyping('  key:\n  |', '\n', '  '), '  key:\n    ');
	const snapshot = parseForEditor('a:');
	for (const offset of [-1, 3, 0.5, NaN]) {
		assert.deepEqual(typingIndentation(snapshot, offset, '\n', '\t'), []);
	}
});

test('completed nested array items continue at the enclosing array indentation', () => {
	assert.equal(afterTyping('[[1]\n|]'), '[[1]\n\t]');
	assert.equal(afterTyping('[{key: true}\n|]'), '[{key: true}\n\t]');
});

test('collection expansion respects a value starting on its own indented line', () => {
	assert.equal(afterTyping('values: # items\n\t[1,\n\t|2]'), 'values: # items\n\t[\n\t\t1\n\t\t2\n\t]');
	assert.equal(afterTyping('values:\n\t[1,\n\t|2]'), 'values:\n\t[\n\t\t1\n\t\t2\n\t]');
	assert.equal(afterTyping('broken: ?\nouter: # outer\n\t{\n\t\tvalues: # items\n\t\t\t[1,\n\t\t\t|2]\n\t}'), 'broken: ?\nouter: # outer\n\t{\n\t\tvalues: # items\n\t\t\t[\n\t\t\t\t1\n\t\t\t\t2\n\t\t\t]\n\t}');
});

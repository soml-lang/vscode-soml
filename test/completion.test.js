import test from 'node:test';
import assert from 'node:assert/strict';
import {parseTree, parseForEditor} from 'soml-lang';
import {completionItems as completeSnapshot} from '../source/completion.ts';

function completionItems(text, offset) {
	return completeSnapshot(parseForEditor(text), offset);
}

function atCursor(source) {
	return completionItems(source.replace('|', ''), source.indexOf('|'));
}

function applyCompletion(source, label) {
	const item = atCursor(source).find(item => item.label === label);
	assert.ok(item, source);
	const text = source.replace('|', '');
	const result = text.slice(0, item.range[0]) + item.insertText.replace('${1:null}', 'null') + text.slice(item.range[1]);
	assert.doesNotThrow(() => parseTree(result), source);
	return result;
}

test('a following instant is an existing value rather than a member key', () => {
	for (const source of ['a: |\n2026-01-01T01:00:00Z', 'a: | # note\n2026-01-01T01:00:00.123456789+01:30', 'a: {b: |\n2026-01-01T01:00:00Z}']) {
		assert.deepEqual(atCursor(source), [], source);
	}
});

test('following members retain completion with numeric keys and unspaced instant values', () => {
	for (const member of ['2026-01-01T01: true', '404:80', '12:34', 'b:2026-01-01T01:00:00Z', '\'2026-01-01T01:00\': false']) {
		applyCompletion(`a: |\n${member}`, 'true');
	}

	applyCompletion('[|\n2026-01-01T01:00:00Z]', 'true');
});

test('offers values in incomplete members and arrays', () => {
	for (const source of ['a: |', 'a: tr|', 'a: [|', 'a: [true, |', 'a: [true\n|', 'a: {b: |']) {
		assert.equal(atCursor(source).some(item => item.label === 'true'), true, source);
	}

	assert.deepEqual(atCursor('a: tr|').map(item => item.label), ['true']);
	assert.deepEqual(atCursor('a: tr|ue')[0].range, [3, 7]);
	assert.deepEqual(atCursor('a: |true')[0].range, [3, 7]);
	assert.deepEqual(atCursor('a: -inf|').map(item => item.label), ['-infinity']);
});

test('does not suggest values at key positions or after complete values', () => {
	for (const source of ['|', 'a|', 'a: true |', 'a: {b: true, |}', 'a: [true] |', 'a: /|', 'a: [}\n|']) {
		assert.deepEqual(atCursor(source), [], source);
	}
});

test('suppresses strings and comments, including escaped quotes and arbitrary block delimiters', () => {
	for (const source of ['a: \'te|xt\'', String.raw`a: "te\"|xt"`, 'a: # |', 'a: /* | */', 'a: \'\'\'\ntext : [ |\n\'\'\'', 'a: \'\'\'\'\n\'\'\'\n|\n\'\'\'\'', 'a: "unterminated |']) {
		assert.deepEqual(atCursor(source), [], source);
	}

	assert.equal(atCursor('a: /* note */ |').some(item => item.label === 'true'), true);
	assert.equal(atCursor('a: [\'\'\'\ntext\n\'\'\', |]').some(item => item.label === 'true'), true);
});

test('suggests missing sibling keys with quoted names and snippet escaping', () => {
	const result = atCursor('a: [{name: \'x\', \'a.$}\': true}, {|}]');
	assert.deepEqual(result.map(item => item.label), ['name', '\'a.$}\'']);
	assert.equal(result[0].insertText, 'name: ${1:null}');
	assert.equal(result[1].insertText, '\'a.\\$\\}\': ${1:null}');
	assert.deepEqual(atCursor('a: [{name: \'x\', age: 1}, {name: \'y\', |}]').map(item => item.label), ['age']);
	assert.deepEqual(atCursor('a: [{name: \'x\', names: 1}, {na|me: \'y\'}]').map(item => item.label), ['names']);
	assert.deepEqual(atCursor('a: [{name: \'x\', age: 1}, {|name: \'y\'}]').map(item => item.label), ['age']);
});

test('bounds cursor positions', () => {
	for (const offset of [-1, 4, 0.5, NaN]) {
		assert.deepEqual(completionItems('a: ', offset), []);
	}
});

test('instant colons remain part of scalar tokens without affecting subsequent contexts', () => {
	for (const source of ['a: 2026-01-01T00:00:00Z\nb: |', 'a: [2026-01-01T00:00:00Z, |]', 'a: [2026-01-01T00:00:00Z\n|]', '\'a:b\': 2026-01-01T00:00:00Z\n\'b:c\': |']) {
		assert.equal(atCursor(source).some(item => item.label === 'true'), true, source);
	}

	assert.deepEqual(atCursor('a: [{date: 2026-01-01T00:00:00Z, enabled: true}, {date: 2026-01-01T00:00:00Z, |}]').map(item => item.label), ['enabled']);
});

test('empty completion insertions do not corrupt following values or members', () => {
	for (const source of ['a:| true', 'a: | [1]', 'a: [| true]', 'a: [true, | false]', 'a: [{name: 1}, {| age: 2}]', 'a: [{name: 1}, {| /* note */ age: 2}]', 'a: |\ntrue', 'a: | # note\n\'hello\'', 'a: | /* note\nmore */ true', 'a: [| /* note\nmore */ true]']) {
		assert.deepEqual(atCursor(source), [], source);
	}
});

test('completion boundaries preserve separators and comments', () => {
	for (const source of ['a: | # note', 'a: | /* note */', 'a: [|, false]', 'a: [|\nfalse]', 'a: [| # note\nfalse]', 'a: [| /* note */\nfalse]', 'a: |\nb: false', 'a: |\n\'quoted key\': false', 'a: |\n"escaped\\nkey": false', 'a: tr|ue # note\nb: false']) {
		applyCompletion(source, 'true');
	}

	for (const source of ['a: [{name: 1}, {|\nage: 2}]', 'a: [{name: 1}, {| # note\nage: 2}]', 'a: [{name: 1}, {| /* note */}]']) {
		applyCompletion(source, 'name');
	}
});

for (const source of ['[{name: \'x\'}, {name|}]', '[{name: \'x\'}, {na|}]', '[{name: \'x\'}, {na|', '[{name: \'x\'}, {|', '[{name:}, {na|}]', '[{name: \'x\'}, {other: false, na|}]', '[{name: \'x\'}, {# note\nna|}]']) {
	test(`recovered sibling completion ${JSON.stringify(source)}`, () => {
		const item = atCursor(source).find(item => item.label === 'name');
		assert.ok(item);
		assert.equal(item.insertText, 'name: ${1:null}');
		assert.equal(item.snippet, true);
	});
}

for (const value of ['true', '1ns', '9223372036854775807', '1.0', '\'hello\'', '[1, 2]', '{nested: false}', '2026-01-01T00:00:00.123456789Z']) {
	test(`key completion preserves existing ${value}`, () => {
		const source = `[{names: null}, {na|me: ${value}}]`;
		const item = atCursor(source).find(item => item.label === 'names');
		assert.ok(item);
		assert.equal(item.snippet, false);
		assert.equal(item.insertText, 'names');
		assert.equal(applyCompletion(source, 'names'), `[{names: null}, {names: ${value}}]`);
	});
}

test('sibling completion uses only the immediate array and deduplicates keys', () => {
	assert.deepEqual(atCursor('[{outer: 1, nested: [{inner: 1}, {|}]}]').map(item => item.label), ['inner']);
	assert.deepEqual(atCursor('[{name: 1}, {name: 2, age: 3}, {|}]').map(item => item.label), ['name', 'age']);
	assert.deepEqual(atCursor('[{name: 1}, {name: 2, |}]'), []);
	assert.deepEqual(atCursor('{first: {name: 1}, second: {|}}'), []);
});

test('sibling suggestions are bounded and support prototype-like names', () => {
	const members = Array.from({length: 150}, (_, index) => `key${index}: 1`).join(', ');
	assert.equal(atCursor(`[{${members}}, {|}]`).length, 100);
	assert.deepEqual(atCursor('[{__proto__: 1, constructor: 2, toString: 3}, {|}]').map(item => item.label), ['__proto__', 'constructor', 'toString']);
});

test('repeated sibling keys share suggestions regardless of spelling', () => {
	const result = atCursor('[{name: 1, \'a.$}\': 2}, {"name": 3, "a.$}": 4, age: 5}, {\'name\': 6, age: 7}, {|}]');
	assert.deepEqual(result.map(item => item.label), ['name', '\'a.$}\'', 'age']);
	assert.equal(result[1].insertText, '\'a.\\$\\}\': ${1:null}');
	assert.deepEqual(atCursor('[{name: 1}, {"name": 2, names: 3}, {na|}]').map(item => item.label), ['name', 'names']);
});

test('completion snapshots remain reusable between cursor queries', () => {
	const document = parseForEditor('[{name: 1}, {na}]');
	const original = JSON.stringify(document);
	assert.deepEqual(completeSnapshot(document, 14).map(item => item.label), ['name']);
	assert.deepEqual(completeSnapshot(document, 13).map(item => item.label), ['name']);
	assert.equal(JSON.stringify(document), original);
});

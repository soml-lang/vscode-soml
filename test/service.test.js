import test from 'node:test';
import assert from 'node:assert/strict';
import {applyEdits, parseTree, format} from 'soml-lang';
import {
	analyze,
	diagnosticProblems,
	DocumentCache,
	formattingEdits,
	outline,
	folds,
	selectionSpans,
	hover,
	keyPathAt,
} from '../source/service.ts';

test('selection expands from the end of the document', () => {
	for (const text of ['a: 1', 'a: [1]', 'a: 1 # comment', 'a: 1\n', '{}', '[]', 'a: [{b: 12}]']) {
		const spans = selectionSpans(parseTree(text), text.length);
		assert.equal(spans.length > 0, true, text);
		assert.deepEqual(spans.at(-1), [0, text.length]);
		for (const [start, end] of spans) {
			assert.equal(start <= text.length && end >= text.length, true, text);
		}
	}
});

test('end-of-document selection retains the final token or comment and strict lookup boundaries', () => {
	for (const [text, expected] of [['a: 123', [3, 6]], ['a: 1 # tail', [5, 11]], ['a: 1\n', [0, 5]], ['a: [{b: 12}]', [11, 12]]]) {
		const tree = parseTree(text);
		assert.deepEqual(selectionSpans(tree, text.length)[0], expected);
		assert.equal(keyPathAt(tree, text.length), undefined);
		assert.equal(hover(tree, text, text.length), undefined);
		assert.deepEqual(selectionSpans(tree, text.length + 1), []);
		assert.deepEqual(selectionSpans(tree, -1), []);
	}

	assert.equal(analyze('').tree, undefined);
});

test('validates every scalar type without losing int64 or nanosecond precision', () => {
	const text = 'text: \'hello\'\nint: 9223372036854775807\nfloat: 1.0\nbool: true\nempty: null\ntime: 2026-01-01T00:00:00.123456789Z\nduration: 1ns\n';
	assert.ok(analyze(text).tree);
});

for (const text of ['a: 0xff', 'a: 9223372036854775808', 'a: 1e999', 'a: 1e-400', 'a: 0.1ns', 'a: 30m1h', 'a: 2026-02-30T00:00:00Z', 'a: [1 2]', 'a: 1\na: 2', '\u{FEFF}a: 1', 'a: 1\r\n', 'a : 1', 'a.b: 1', '/* nested /* */ a: 1', String.raw`a: "\u{d}"`]) {
	test(`rejects ${JSON.stringify(text)}`, () => {
		assert.ok(analyze(text).problem);
		assert.deepEqual(formattingEdits(text), []);
	});
}

test('diagnostics use UTF-16 offsets after astral characters', () => {
	const text = '\'😀\': no';
	assert.deepEqual(analyze(text).problem.range, [6, 7]);
});

test('end-of-file errors stay within the document', () => {
	const text = 'a:';
	assert.deepEqual(analyze(text).problem.range, [2, 2]);
});

test('size limit is inclusive and bypasses parsing', () => {
	assert.ok(analyze('a: 1', 4).tree);
	assert.equal(analyze('a: 1', 3).problem.limited, true);
	assert.deepEqual(formattingEdits('a: 1', 3), []);
});

test('cache reuses versions, invalidates edits and settings, and can release a document', () => {
	let reads = 0;
	const document = {
		version: 1, getText() {
			reads++;
			return 'a: 1';
		},
	};
	const cache = new DocumentCache();
	const first = cache.get(document);
	assert.equal(cache.get(document), first);
	assert.equal(reads, 1);
	document.version++;
	assert.notEqual(cache.get(document), first);
	assert.equal(cache.get(document, 3).problem.limited, true);
	cache.delete(document);
	cache.get(document);
	assert.equal(reads, 4);
});

test('cache isolates documents with matching versions and preserves other documents when one closes', () => {
	const cache = new DocumentCache();
	const firstDocument = {version: 1, getText: () => 'first: true'};
	const secondDocument = {version: 1, getText: () => 'second:'};
	const first = cache.get(firstDocument);
	const second = cache.get(secondDocument);
	const firstEditor = cache.getEditor(firstDocument);
	const secondEditor = cache.getEditor(secondDocument);
	assert.ok(first.tree);
	assert.ok(second.problem);
	assert.notEqual(first, second);
	assert.equal(firstEditor.text, 'first: true');
	assert.equal(secondEditor.text, 'second:');
	assert.equal(cache.get(firstDocument), first);
	assert.equal(cache.getEditor(firstDocument), firstEditor);
	cache.delete(firstDocument);
	assert.equal(cache.get(secondDocument), second);
	assert.equal(cache.getEditor(secondDocument), secondEditor);
	assert.notEqual(cache.get(firstDocument), first);
});

test('formatter preserves comments, scalar spelling, member order, and block-string spaces', () => {
	const text = 'z: 0xFF # bytes\na: [1,\n 2]\ns: \'\'\'\ntext  \n\'\'\'\n';
	const edits = formattingEdits(text);
	const formatted = applyEdits(text, edits);
	assert.equal(formatted, format(text));
	assert.equal(formatted.includes('text  \n'), true);
	assert.equal(formatted.startsWith('z: 0xFF # bytes\n'), true);
	assert.deepEqual(formattingEdits(formatted), []);
	assert.equal(edits.every(edit => edit.range[1] - edit.range[0] < text.length), true);
});

test('outline includes nested members and array indices with key selection ranges', () => {
	const text = 'servers: [{host: \'api\'}]\n\'\': 1';
	const entries = outline(parseTree(text));
	assert.equal(entries[0].name, 'servers');
	assert.deepEqual(entries[0].selection, [0, 7]);
	assert.equal(entries[0].children[0].name, '[0]');
	assert.equal(entries[0].children[0].children[0].name, 'host');
	assert.equal(entries[1].name, '\'\'');
	assert.equal(outline(parseTree(text), 1).length, 1);
	assert.deepEqual(outline(parseTree(text), 1)[0].children, []);
});

test('key paths quote special keys and distinguish indices from numeric keys', () => {
	const text = 'servers: [{\'a.b\': {\'0\': 1}}]\n\'\': true';
	const tree = parseTree(text);
	assert.equal(keyPathAt(tree, text.indexOf('1')), 'servers[0].\'a.b\'.0');
	assert.equal(keyPathAt(tree, text.indexOf('true')), '\'\'');
	assert.equal(keyPathAt(tree, text.length), undefined);
});

test('selection grows from value through member, object, array, and document', () => {
	const text = 'a: [{b: 12}]\n';
	const spans = selectionSpans(parseTree(text), text.indexOf('12'));
	assert.deepEqual(spans[0], [8, 10]);
	assert.deepEqual(spans.at(-1), [0, text.length]);
	for (let index = 1; index < spans.length; index++) {
		assert.equal(spans[index][0] <= spans[index - 1][0], true);
		assert.equal(spans[index][1] >= spans[index - 1][1], true);
	}
});

test('comment selection includes the complete comment', () => {
	const text = 'a: [1 /* words */]\n';
	assert.deepEqual(selectionSpans(parseTree(text), text.indexOf('words'))[0], [6, 17]);
});

test('folds multiline containers and block strings without hiding their closing line', () => {
	const text = 'a: [\n1\n2\n]\ns: \'\'\'\ntext\n\'\'\'\n';
	assert.deepEqual(folds(parseTree(text), text), [{start: 0, end: 2, comment: false}, {start: 4, end: 5, comment: false}]);
});

for (const [value, expected] of [
	['0x7FFFFFFFFFFFFFFF', '9,223,372,036,854,775,807'],
	['-9223372036854775808ns', '-9,223,372,036,854,775,808 nanoseconds'],
	['0.0000000001h', '360 nanoseconds'],
	['1h30m', '5,400,000,000,000 nanoseconds'],
	['2026-01-01T01:00:00.123456789+01:00', 'UTC: 2026-01-01T00:00:00.123456789Z'],
	['0001-01-01T00:00:00Z', 'UTC: 0001-01-01T00:00:00Z'],
]) {
	test(`hover explains ${value} exactly`, () => {
		const text = `a: ${value}`;
		assert.equal(hover(parseTree(text), text, 3).text.includes(expected), true);
	});
}

test('no value hover on comments, separators, or whitespace', () => {
	const text = 'a: [1, 2] # hello';
	const tree = parseTree(text);
	for (const offset of [2, 3, 5, 6, 10, 13]) {
		assert.equal(hover(tree, text, offset), undefined);
	}
});

test('diagnostics span a complete astral character and reject raw controls', () => {
	assert.deepEqual(analyze('a: 😀').problem.range, [3, 5]);
	for (const character of ['\u{0}', '\u{8}', '\u{B}', '\u{1F}', '\u{7F}', '\r']) {
		assert.ok(analyze(`a: '${character}'`).problem);
		assert.ok(analyze(`a: 1 # ${character}`).problem);
	}
});

test('Unicode line separators inside strings do not alter UTF-16 line offsets', () => {
	const text = 'a: \'😀\u{2028}text\'\nb: no';
	assert.deepEqual(analyze(text).problem.range, [text.indexOf('no'), text.indexOf('no') + 1]);
});

test('formatting changes preserve scalar tokens including block string payloads', () => {
	const text = 'b: "\\u{1f600}"\na: """\n  first  \n  \\t\n  last\n  """ # end\n';
	const formatted = applyEdits(text, formattingEdits(text));
	const before = parseTree(text);
	const after = parseTree(formatted);
	assert.deepEqual(before.body.members.map(member => member.value.value), after.body.members.map(member => member.value.value));
	assert.deepEqual(before.comments.map(comment => comment.value), after.comments.map(comment => comment.value));
	assert.equal(formatted.includes(String.raw`"\u{1f600}"`), true);
});

test('formatted documents need no edit and invalid block indentation is left untouched', () => {
	assert.deepEqual(formattingEdits('a: [1, 2]\n'), []);
	assert.deepEqual(formattingEdits('a: \'\'\'\n x\n  \'\'\''), []);
});

test('folds leading line comments but never folds code with trailing comments', () => {
	const text = '# first\n# second\na: 1 # one\nb: 2 # two\n';
	assert.deepEqual(folds(parseTree(text), text), [{start: 0, end: 1, comment: true}]);
});

test('key paths preserve quotes and escaped control characters', () => {
	const text = String.raw`"a'b\n": [1]`;
	assert.equal(keyPathAt(parseTree(text), text.indexOf('1')), String.raw`"a'b\n"[0]`);
});

test('selection on a colon includes punctuation before the containing member', () => {
	const text = 'a: 1';
	assert.deepEqual(selectionSpans(parseTree(text), 1), [[1, 2], [0, 4]]);
});

test('duration hover tolerates long insignificant fractional zeros', () => {
	const text = `a: 1.${'0'.repeat(100_000)}s`;
	const tree = parseTree(text);
	const start = performance.now();
	assert.equal(hover(tree, text, 3).text.includes('1,000,000,000 nanoseconds'), true);
	assert.equal(performance.now() - start < 500, true);
});

test('key paths work at the end of a wide array and within nested arrays', () => {
	const text = `items: [${'0,'.repeat(50_000)}[123]]`;
	const tree = parseTree(text);
	assert.equal(keyPathAt(tree, text.indexOf('123')), 'items[50000][0]');
	assert.equal(keyPathAt(tree, text.indexOf('123') + 3), 'items[50000]');
});

test('selection retains comment and punctuation precedence within nested collections', () => {
	const text = 'a: [{b: 12 /* note */}]';
	const tree = parseTree(text);
	for (let offset = 0; offset < text.length; offset++) {
		const spans = selectionSpans(tree, offset);
		for (let index = 1; index < spans.length; index++) {
			assert.equal(spans[index][0] <= spans[index - 1][0] && spans[index][1] >= spans[index - 1][1], true);
		}
	}

	assert.deepEqual(selectionSpans(tree, text.indexOf('note'))[0], [11, 21]);
});

test('cached analysis carries the matching source snapshot', () => {
	let source = 'a: 1';
	const document = {version: 1, getText: () => source};
	const cache = new DocumentCache();
	const initial = cache.get(document);
	assert.equal(initial.text, 'a: 1');
	source = 'a: 2';
	document.version++;
	assert.equal(cache.get(document).text, 'a: 2');
	assert.equal(initial.text, 'a: 1');
});

test('float hovers describe the parsed binary64 value instead of arbitrary source padding', () => {
	for (const [literal, expected] of [['1e3', '1000'], ['1.0000000000000001', '1'], [`1.${'0'.repeat(100_000)}`, '1']]) {
		const text = `a: ${literal}`;
		assert.equal(hover(parseTree(text), text, 3).text, `Float (64-bit)\n${expected}`);
	}
});

test('float hovers normalize signed zero as required by SOML', () => {
	for (const literal of [
		'-0.0',
		'-0e5',
		'0.0',
	]) {
		const text = `a: ${literal}`;
		assert.equal(hover(parseTree(text), text, 3).text, 'Float (64-bit)\n0');
	}
});

test('repeated numeric hovers retain exact signs, grouping, and duration units', () => {
	const text = 'minimum: -9223372036854775808\nmaximum: 9223372036854775807\nduration: -1h2m3s4ms5us6ns';
	const tree = parseTree(text);
	for (let round = 0; round < 3; round++) {
		assert.equal(hover(tree, text, text.indexOf('-922')).text, 'Int (signed 64-bit)\n-9,223,372,036,854,775,808');
		assert.equal(hover(tree, text, text.indexOf('922', text.indexOf('maximum'))).text, 'Int (signed 64-bit)\n9,223,372,036,854,775,807');
		assert.equal(hover(tree, text, text.indexOf('-1h')).text, 'Duration\n-1 hour 2 minutes 3 seconds 4 milliseconds 5 microseconds 6 nanoseconds\n-3,723,004,005,006 nanoseconds');
	}
});

test('outline limits count descendants, not just top-level members', () => {
	const entries = outline(parseTree('a: {b: {c: 1}}\nd: 2'), 2);
	assert.equal(entries.length, 1);
	assert.equal(entries[0].children.length, 1);
	assert.deepEqual(entries[0].children[0].children, []);
});

test('folding limits retain the earliest regions in source order', () => {
	const text = '# first\n# second\na: [\n1\n2\n]\nb: [\n3\n4\n]';
	const tree = parseTree(text);
	assert.deepEqual(folds(tree, text, 1), [{start: 0, end: 1, comment: true}]);
	assert.deepEqual(folds(tree, text, 0), []);
});

test('searchable key paths disambiguate nested names and quote special keys', async () => {
	const {keyPaths} = await import('../source/service.ts');
	const text = 'servers: [{host: \'a\'}, {host: \'b\'}]\n\'example.com\': {\'0\': 1}';
	const entries = keyPaths(parseTree(text));
	assert.deepEqual(entries.map(entry => entry.path), ['servers', 'servers[0]', 'servers[0].host', 'servers[1]', 'servers[1].host', '\'example.com\'', '\'example.com\'.0']);
	for (const entry of entries) {
		assert.equal(keyPathAt(parseTree(text), entry.range[0]), entry.path);
	}
});

test('duration hovers show nanoseconds last', () => {
	const text = 'duration: 90m';
	assert.equal(hover(parseTree(text), text, text.indexOf('90m')).text, 'Duration\n1 hour 30 minutes\n5,400,000,000,000 nanoseconds');
});

test('duration hovers add readable fixed units without losing nanoseconds', () => {
	for (const [literal, readable] of [['90m', '1 hour 30 minutes'], ['1500ms', '1 second 500 milliseconds'], ['1001ns', '1 microsecond 1 nanosecond'], ['-1h30m', '-1 hour 30 minutes'], ['0s', '0 seconds'], ['-9223372036854775808ns', '-2,562,047 hours 47 minutes 16 seconds 854 milliseconds 775 microseconds 808 nanoseconds']]) {
		const text = `a: ${literal}`;
		assert.equal(hover(parseTree(text), text, 3).text.split('\n', 2)[1], readable, literal);
	}
});

test('instant hovers show a readable local date and time before exact UTC', () => {
	const local = new Intl.DateTimeFormat(undefined, {dateStyle: 'long', timeStyle: 'long'}).format(new Date(Date.UTC(2026, 0, 1, 0, 30, 45)));
	for (const literal of ['2026-01-01T00:30:45.123456789Z', '2026-01-01T07:30:45.123456789+07:00', '2025-12-31T19:30:45.123456789-05:00']) {
		const text = `a: ${literal}`;
		assert.equal(hover(parseTree(text), text, 3).text, `Instant\nLocal: ${local}\nUTC: 2026-01-01T00:30:45.123456789Z`);
	}
});

test('instant hovers match Temporal across calendar, offset, and fractional boundaries', () => {
	for (const date of ['0001-01-02', '0099-12-31', '1900-02-28', '1969-12-31', '2000-02-29', '2026-12-31', '9999-12-30']) {
		for (const offset of ['-23:59', 'Z', '+05:45', '+23:59']) {
			for (const fraction of ['', '.000000001', '.999999999']) {
				const literal = `${date}T00:00:00${fraction}${offset}`;
				const expected = Temporal.Instant.from(literal).toString({fractionalSecondDigits: fraction ? fraction.length - 1 : 0});
				const text = `a: ${literal}`;
				assert.equal(hover(parseTree(text), text, 3).text.split('\n').at(-1), `UTC: ${expected}`, literal);
			}
		}
	}
});

test('instant local hovers follow daylight saving transitions', () => {
	const formatter = new Intl.DateTimeFormat(undefined, {dateStyle: 'long', timeStyle: 'long'});
	for (const literal of ['2026-03-08T06:59:59Z', '2026-03-08T07:00:00Z', '2026-11-01T05:59:59Z', '2026-11-01T06:00:00Z']) {
		const text = `a: ${literal}`;
		assert.equal(hover(parseTree(text), text, 3).text, `Instant\nLocal: ${formatter.format(new Date(literal))}\nUTC: ${literal}`);
	}
});

test('fractional duration hovers match independently generated nanosecond values', () => {
	for (const [unit, size] of [['h', 3_600_000_000_000n], ['m', 60_000_000_000n], ['s', 1_000_000_000n], ['ms', 1_000_000n], ['us', 1000n], ['ns', 1n]]) {
		for (const numerator of [0n, 1n, 125n, 999n]) {
			if (numerator * size % 1000n !== 0n) {
				continue;
			}

			const expected = (2n * size) + ((numerator * size) / 1000n);
			for (const isNegative of [false, true]) {
				const literal = `${isNegative ? '-' : ''}2.${numerator.toString().padStart(3, '0')}${unit}`;
				const text = `a: ${literal}`;
				assert.equal(hover(parseTree(text), text, 3).text.split('\n').at(-1), `${(isNegative ? -expected : expected).toLocaleString('en-US')} nanoseconds`, literal);
			}
		}
	}

	for (const [literal, expected] of [['0.0000000001h', 360n], ['2562047h47m16s854ms775us807ns', 9_223_372_036_854_775_807n], ['-2562047h47m16s854ms775us808ns', -9_223_372_036_854_775_808n]]) {
		const text = `a: ${literal}`;
		assert.equal(hover(parseTree(text), text, 3).text.split('\n').at(-1), `${expected.toLocaleString('en-US')} nanoseconds`, literal);
	}
});

test('invalid analysis retains recovered structure without exposing a strict tree', () => {
	const text = 'host: \'local\'\nport:\nsecure: true';
	const analysis = analyze(text);
	assert.equal(analysis.tree, undefined);
	assert.ok(analysis.problem);
	assert.deepEqual(outline(analysis.recovered.root).map(entry => [entry.name, entry.type]), [['host', 'String'], ['port', 'Unknown'], ['secure', 'Boolean']]);
	assert.deepEqual(formattingEdits(text), []);
	assert.equal(analyze(text, 3).recovered, undefined);
	assert.equal(analyze('a: true').recovered, undefined);
});

test('recovered outline retains duplicates, valid descendants, and original array positions', () => {
	const text = 'a: [1, bad, {b: true}]\na: 2\nbroken';
	const entries = outline(analyze(text).recovered.root);
	assert.deepEqual(entries.map(entry => entry.name), ['a', 'a', 'broken']);
	assert.deepEqual(entries[0].children.map(entry => entry.name), ['[0]', '[2]']);
	assert.equal(entries[0].children[1].children[0].name, 'b');
	assert.equal(outline(analyze(text).recovered.root, 2)[0].children.length, 1);
});

test('folds and selections survive an unrelated missing value', () => {
	const text = 'missing:\n# first\n# second\na: [\n1\n{b: true}\n]\n';
	const {recovered} = analyze(text);
	assert.deepEqual(folds(recovered, text), [{start: 1, end: 2, comment: true}, {start: 3, end: 5, comment: false}]);
	const offset = text.indexOf('true');
	const spans = selectionSpans(recovered, offset);
	assert.deepEqual(spans[0], [offset, offset + 4]);
	assert.deepEqual(spans.at(-1), [0, text.length]);
	for (let index = 1; index < spans.length; index++) {
		assert.equal(spans[index][0] <= spans[index - 1][0], true);
		assert.equal(spans[index][1] >= spans[index - 1][1], true);
	}

	assert.deepEqual(selectionSpans(recovered, -1), []);
	assert.deepEqual(selectionSpans(recovered, text.length + 1), []);
});

test('recovered navigation uses UTF-16 offsets and skips invalid decoded keys', () => {
	const text = '\'😀\': [{value: \'😀\'}]\ninvalid.key: false';
	const {recovered} = analyze(text);
	const entries = outline(recovered.root);
	assert.equal(entries.length, 1);
	assert.deepEqual(entries[0].selection, [0, 4]);
	const start = text.lastIndexOf('\'😀\'');
	assert.deepEqual(selectionSpans(recovered, start + 2)[0], [start, start + 4]);
	assert.deepEqual(selectionSpans(recovered, text.length).at(-1), [0, text.length]);
});

test('recovered navigation keeps nested ranges within deterministically corrupted documents', () => {
	function checkOutline(entries, parentRange, text) {
		for (const entry of entries) {
			assert.equal(entry.range[0] >= parentRange[0] && entry.range[1] <= parentRange[1], true, text);
			assert.equal(entry.selection[0] >= entry.range[0] && entry.selection[1] <= entry.range[1], true, text);
			assert.equal(entry.range[0] <= entry.range[1] && entry.selection[0] <= entry.selection[1], true, text);
			checkOutline(entry.children, entry.range, text);
		}
	}

	const documents = new Set();
	for (const source of ['a: [{b: 12 /* note */}]', '\'😀\': [\'text\', {bad: null}]', '# first\n# second\na: {\nb: [1, 2]\n}']) {
		for (let index = 0; index < source.length; index++) {
			documents.add(source.slice(0, index));
			documents.add(`${source.slice(0, index)}?${source.slice(index + 1)}`);
		}
	}

	let checked = 0;
	for (const text of documents) {
		const {recovered} = analyze(text);
		if (!recovered) {
			continue;
		}

		checked++;
		checkOutline(outline(recovered.root), [0, text.length], text);
		for (let offset = 0; offset <= text.length; offset++) {
			const spans = selectionSpans(recovered, offset);
			assert.deepEqual(spans.at(-1), text === '' ? undefined : [0, text.length], text);
			for (const [start, end] of spans) {
				assert.equal(start >= 0 && start <= offset && offset <= end && end <= text.length, true, text);
			}

			for (let spanIndex = 1; spanIndex < spans.length; spanIndex++) {
				const inner = spans[spanIndex - 1];
				const outer = spans[spanIndex];
				assert.equal(outer[0] <= inner[0] && outer[1] >= inner[1], true, text);
			}
		}
	}

	assert.equal(checked > 100, true);
});

test('unclosed recovered containers never fold away an ancestor closing delimiter', () => {
	const text = 'a: {\nb: [\n1\n}';
	assert.deepEqual(folds(analyze(text).recovered, text), [{start: 0, end: 2, comment: false}]);
});

test('cache reuses recovered snapshots and replaces them when syntax becomes valid', () => {
	let text = 'a:';
	const document = {version: 1, getText: () => text};
	const cache = new DocumentCache();
	const first = cache.get(document);
	assert.ok(first.recovered);
	assert.equal(cache.get(document).recovered, first.recovered);
	text = 'a: true';
	document.version++;
	const next = cache.get(document);
	assert.ok(next.tree);
	assert.equal(next.recovered, undefined);
	assert.equal(first.recovered.text, 'a:');
});

test('editor snapshots are lazy, cached, size-limited, and invalidated with document versions', () => {
	let reads = 0;
	let text = 'a: true';
	const document = {
		version: 1, getText() {
			reads++;
			return text;
		},
	};
	const cache = new DocumentCache();
	const analysis = cache.get(document);
	assert.equal(analysis.recovered, undefined);
	const first = cache.getEditor(document);
	assert.ok(first);
	assert.equal(cache.getEditor(document), first);
	assert.equal(analysis.recovered, first);
	assert.equal(reads, 1);
	text = 'a:';
	document.version++;
	const invalid = cache.get(document);
	assert.equal(cache.getEditor(document), invalid.recovered);
	assert.notEqual(invalid.recovered, first);
	assert.equal(cache.getEditor(document, 1), undefined);
	assert.ok(cache.getEditor(document, 2));
	cache.delete(document);
	assert.notEqual(cache.getEditor(document), invalid.recovered);
});

test('reports independent errors once while preserving the strict first message', () => {
	const analysis = analyze('a: nope\nb: nope\nc: nope');
	const problems = diagnosticProblems(analysis);
	assert.equal(problems.length, 3);
	assert.equal(problems[0].message, analysis.problem.message);
	assert.deepEqual(problems.map(problem => problem.code), ['invalid-value', 'invalid-value', 'invalid-value']);
	assert.deepEqual(problems.map(problem => problem.range), [[3, 7], [11, 15], [19, 23]]);
	assert.deepEqual(diagnosticProblems(analyze('a: true')), []);
});

test('duplicate diagnostics link to the original decoded key in the same object', () => {
	const text = 'a: 1\n\'a\': 2\nb: {a: 3, a: 4}';
	const problems = diagnosticProblems(analyze(text));
	assert.equal(problems.length, 2);
	assert.equal(problems.every(problem => problem.code === 'duplicate-key'), true);
	assert.deepEqual(problems[0].related[0].range, [0, 1]);
	assert.equal(text.slice(...problems[1].related[0].range), 'a');
	assert.equal(problems[1].related[0].range[0] > problems[0].range[0], true);
});

test('diagnostic limits and source positions remain bounded', () => {
	const text = Array.from({length: 200}, (_, index) => `key${index}: nope`).join('\n');
	const problems = diagnosticProblems(analyze(text));
	assert.equal(problems.length <= 100, true);
	assert.equal(problems.length > 1, true);
	assert.deepEqual(diagnosticProblems(analyze(text, 1)), [analyze(text, 1).problem]);
	for (const source of ['', 'a:', 'a: [', '\'😀\': nope\nb: nope', 'a: 1\r\nb: nope']) {
		for (const problem of diagnosticProblems(analyze(source))) {
			assert.equal(problem.range[0] >= 0 && problem.range[1] <= source.length, true);
		}
	}
});

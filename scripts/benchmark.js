import assert from 'node:assert/strict';
import {bench} from 'node:bench';
import {parseForEditor} from 'soml-lang';
import {completionItems} from '../source/completion.ts';
import {
	analyze,
	DocumentCache,
	formattingEdits,
	hover,
	outline,
	selectionSpans,
	keyPathAt,
} from '../source/service.ts';

const text = Array.from({length: 20_000}, (_, index) => `key-${index}: ${index}\n`).join('');
const {tree} = analyze(text);
const cache = new DocumentCache();
const document = {version: 1, getText: () => text};
const cached = cache.get(document);
const arrayText = `[${'0,'.repeat(100_000)}1]`;
const arrayTree = analyze(arrayText).tree;
const incomplete = `${text}pending:`;
const {recovered} = analyze(incomplete);
const durationText = 'duration: -1h2m3s4ms5us6ns';
const durationTree = analyze(durationText).tree;
const siblingsText = `[${'{host: 1, port: 2, enabled: true},'.repeat(10_000)}{}]`;
const siblings = parseForEditor(siblingsText);
const longStringText = `content: '${'x'.repeat(600_000)}'\n`;

bench('parse 20,000 members', context => {
	context.start();
	const result = analyze(text);
	context.end(1);
	assert.equal(result.tree.body.members.length, 20_000);
});

bench('format 20,000 members', context => {
	context.start();
	const edits = formattingEdits(text);
	context.end(1);
	assert.deepEqual(edits, []);
});

bench('outline bounded to 5,000 symbols', context => {
	context.start();
	const entries = outline(tree);
	context.end(1);
	assert.equal(entries.length, 5000);
});

bench('end-of-document hover and selection', context => {
	let total = 0;
	context.start();
	for (let index = 0; index < 1000; index++) {
		total += hover(tree, text, text.length - 3).text.length;
		total += selectionSpans(tree, text.length - 3).length;
	}

	context.end(1000);
	assert.ok(total > 0);
});

bench('cached analysis', context => {
	let matches = 0;
	context.start();
	for (let index = 0; index < 10_000; index++) {
		matches += Number(cache.get(document) === cached);
	}

	context.end(10_000);
	assert.equal(matches, 10_000);
});

bench('key path at end of 100,001-item array', context => {
	let matches = 0;
	context.start();
	for (let index = 0; index < 1000; index++) {
		matches += Number(keyPathAt(arrayTree, arrayText.length - 2) === '[100000]');
	}

	context.end(1000);
	assert.equal(matches, 1000);
});

bench('recover 20,001 members with a missing value', context => {
	context.start();
	const result = analyze(incomplete);
	context.end(1);
	assert.ok(result.problem);
	assert.equal(result.recovered.root.children[0].members.length, 20_001);
});

bench('recovered outline bounded to 5,000 symbols', context => {
	context.start();
	const entries = outline(recovered.root);
	context.end(1);
	assert.equal(entries.length, 5000);
});

bench('recovered selection near EOF', context => {
	let total = 0;
	context.start();
	for (let index = 0; index < 1000; index++) {
		total += selectionSpans(recovered, incomplete.length - 1).length;
	}

	context.end(1000);
	assert.ok(total > 0);
});

bench('completion from cached incomplete snapshot', context => {
	let total = 0;
	context.start();
	for (let index = 0; index < 10_000; index++) {
		total += completionItems(recovered, incomplete.length).length;
	}

	context.end(10_000);
	assert.ok(total > 0);
});

bench('duration hover with all six units', context => {
	let total = 0;
	context.start();
	for (let index = 0; index < 1000; index++) {
		total += hover(durationTree, durationText, 10).text.length;
	}

	context.end(1000);
	assert.ok(total > 0);
});

bench('completion across 10,000 repeated sibling objects', context => {
	context.start();
	const items = completionItems(siblings, siblingsText.length - 2);
	context.end(1);
	assert.deepEqual(items.map(item => item.label), ['host', 'port', 'enabled']);
});

bench('format unchanged 600 KB string', context => {
	context.start();
	const edits = formattingEdits(longStringText);
	context.end(1);
	assert.deepEqual(edits, []);
});

bench('editor parse of 600 KB literal string', context => {
	context.start();
	const snapshot = parseForEditor(longStringText);
	context.end(1);
	assert.deepEqual(snapshot.diagnostics, []);
	assert.equal(snapshot.tokens.at(-1).kind, 'string');
});

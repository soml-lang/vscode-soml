import test from 'node:test';
import assert from 'node:assert/strict';
import {parseTree} from 'soml-lang';
import {tokenize, markdownGrammar} from './grammar-helper.js';

test('Markdown SOML fences do not interrupt embedded JavaScript template strings', () => {
	const tokens = tokenize('<script>\nconst example = `\n~~~soml\na: 1\n~~~\n`;\n</script>\n\nprose', markdownGrammar);
	assert.equal(tokens.some(token => token.scopes.includes('meta.embedded.block.soml')), false);
	assert.equal(tokens.find(token => token.text.includes('a: 1'))?.scopes.includes('string.template.js'), true);
});

test('Markdown does not start SOML fences inside HTML comments', () => {
	const tokens = tokenize('<!--\n```soml\na: 1\n-->\nprose', markdownGrammar);
	assert.equal(tokens.some(token => token.scopes.includes('meta.embedded.block.soml')), false);
	assert.equal(tokens.at(-1).scopes.some(scope => scope.startsWith('comment.')), false);
});

test('Markdown tilde fences accept backticks in their info strings', () => {
	const tokens = tokenize('~~~soml `example`\na: 1\n~~~\nprose', markdownGrammar);
	assert.equal(tokens.find(token => token.text === 'a')?.scopes.includes('support.type.property-name.soml'), true);
	assert.equal(tokens.at(-1).scopes.includes('meta.embedded.block.soml'), false);
});

test('Markdown SOML fences allow at most three spaces of indentation', () => {
	for (const fence of ['```', '~~~']) {
		for (const indentation of [' '.repeat(4), '\t']) {
			const openingTokens = tokenize(`${indentation}${fence}soml\n${indentation}a: 1\n${indentation}${fence}\n\nprose`, markdownGrammar);
			assert.equal(openingTokens.some(token => token.scopes.includes('meta.embedded.block.soml')), false);
			const closingTokens = tokenize(`${fence}soml\na: 1\n${indentation}${fence}\nb: 2\n${fence}\nprose`, markdownGrammar);
			assert.equal(closingTokens.find(token => token.text === 'b')?.scopes.includes('support.type.property-name.soml'), true);
			assert.equal(closingTokens.at(-1).scopes.includes('markup.fenced_code.block.markdown'), false);
		}
	}
});

for (const key of ['404', 'true', '2024-01-01', '\'a.b\'', String.raw`"escaped\tkey"`, 'x-forwarded-for']) {
	test(`highlights key ${key}`, () => {
		const tokens = tokenize(`${key}: 1`);
		assert.equal(tokens[0].scopes.includes('support.type.property-name.soml'), true);
	});
}

for (const [value, scope] of [['1ns', 'constant.numeric.duration.soml'], ['2026-01-01T00:00:00Z', 'constant.numeric.instant.soml'], ['1.0', 'constant.numeric.float.soml'], ['0xFF', 'constant.numeric.integer.hexadecimal.soml'], ['false', 'constant.language.boolean.soml']]) {
	test(`highlights ${value} in objects and arrays`, () => {
		for (const text of [`a: ${value}`, `[1, ${value}]`]) {
			assert.equal(tokenize(text).some(token => token.text === value && token.scopes.includes(scope)), true);
		}
	});
}

test('block strings use an exact-length closing delimiter', () => {
	const text = 'a: \'\'\'\n\'\'\'\'\n# content\n\'\'\'\nb: 1';
	const tokens = tokenize(text);
	assert.equal(tokens.find(token => token.text === '# content').scopes.includes('string.quoted.single.block.soml'), true);
	assert.equal(tokens.find(token => token.text === 'b').scopes.includes('support.type.property-name.soml'), true);
});

test('unterminated single-line strings recover on the next line', () => {
	assert.equal(tokenize('a: \'oops\nb: 1').find(token => token.text === 'b').scopes.includes('support.type.property-name.soml'), true);
});

test('valid escapes and invalid Unicode scalars have distinct scopes', () => {
	const tokens = tokenize(String.raw`a: "\n\u{1f600}\u{d}\u{d800}\q"`);
	assert.equal(tokens.find(token => token.text === String.raw`\u{1f600}`).scopes.includes('constant.character.escape.soml'), true);
	for (const escape of [String.raw`\u{d}`, String.raw`\u{d800}`, String.raw`\q`]) {
		assert.equal(tokens.find(token => token.text === escape).scopes.some(scope => scope.startsWith('invalid.')), true);
	}
});

test('Markdown fences highlight SOML without leaking into following prose', () => {
	const tokens = tokenize('```soml\na: 1\n```\nb: 2', markdownGrammar);
	assert.equal(tokens.find(token => token.text === 'a').scopes.includes('support.type.property-name.soml'), true);
	assert.equal(tokens.filter(token => token.start > 19).some(token => token.scopes.includes('meta.embedded.block.soml')), false);
});

test('Markdown shorter and mismatched fences do not end a SOML block', () => {
	for (const inner of ['```', '~~~']) {
		const tokens = tokenize(`\`\`\`\`soml\na: 1\n${inner}\nb: 2\n\`\`\`\`\nprose`, markdownGrammar);
		assert.equal(tokens.find(token => token.text === 'b')?.scopes.includes('support.type.property-name.soml'), true);
		assert.equal(tokens.at(-1).scopes.includes('meta.embedded.block.soml'), false);
	}
});

test('Markdown accepts a closing fence longer than its opening fence', () => {
	const tokens = tokenize('```soml\na: 1\n````\nprose', markdownGrammar);
	assert.equal(tokens.at(-1).scopes.includes('meta.embedded.block.soml'), false);
});

test('nested Markdown block strings close before the next SOML key', () => {
	for (const prefix of ['  ', '> ']) {
		const lines = ['```soml', 'a: \'\'\'', '\ttext', '\t\'\'\'', 'b: 1', '```'];
		const tokens = tokenize(`- list\n\n${lines.map(line => prefix + line).join('\n')}`, markdownGrammar);
		assert.equal(tokens.find(token => token.text === 'b')?.scopes.includes('support.type.property-name.soml'), true);
	}
});

test('adversarial editor-length lines tokenize within a generous time bound', () => {
	for (const text of [`a: ${'a.'.repeat(10_000)}`, `a: -${'0.'.repeat(10_000)}`, `a: ${'1.1'.repeat(6000)}`, `"${String.raw`\"`.repeat(10_000)}`]) {
		tokenize(text.slice(0, 100));
		const start = performance.now();
		tokenize(text);
		assert.equal(performance.now() - start < 1000, true);
	}
});

test('shorter and mismatched Markdown fences preserve block string and comment state', () => {
	for (const inner of ['```', '~~~']) {
		for (const [opening, closing, scope] of [['\'\'\'', '\'\'\'', 'string.quoted.single.block.soml'], ['/*', '*/', 'comment.block.soml']]) {
			const tokens = tokenize(`\`\`\`\`soml\na: ${opening}\n${inner}\nb: text\n${closing}\nc: 1\n\`\`\`\`\nprose`, markdownGrammar);
			assert.equal(tokens.find(token => token.text.includes('b: text'))?.scopes.includes(scope), true);
			assert.equal(tokens.find(token => token.text === 'c')?.scopes.includes('support.type.property-name.soml'), true);
			assert.equal(tokens.at(-1).scopes.includes('meta.embedded.block.soml'), false);
		}
	}
});

test('Markdown accepts independently indented opening and closing SOML fences', () => {
	for (const fence of ['```', '~~~']) {
		for (let openingIndent = 0; openingIndent <= 3; openingIndent++) {
			for (let closingIndent = 0; closingIndent <= 3; closingIndent++) {
				const tokens = tokenize(`${' '.repeat(openingIndent)}${fence}soml\na: 1\n${' '.repeat(closingIndent)}${fence}\nprose`, markdownGrammar);
				assert.equal(tokens.find(token => token.text === 'a')?.scopes.includes('support.type.property-name.soml'), true);
				assert.equal(tokens.at(-1).scopes.includes('markup.fenced_code.block.markdown'), false);
			}
		}
	}
});

test('Markdown SOML fence indentation is relative to its list or blockquote container', () => {
	for (const [before, prefix] of [['- list\n\n', '  '], ['123. list\n\n', ' '.repeat(5)], ['', '> '], ['> - list\n>\n', '>   ']]) {
		for (const fence of ['```', '~~~']) {
			const lines = [`${fence}soml`, 'a: 1', 'b: 2', fence];
			const tokens = tokenize(`${before}${lines.map(line => prefix + line).join('\n')}\n\nprose`, markdownGrammar);
			for (const key of ['a', 'b']) {
				assert.equal(tokens.find(token => token.text === key)?.scopes.includes('support.type.property-name.soml'), true);
			}

			assert.equal(tokens.at(-1).scopes.includes('markup.fenced_code.block.markdown'), false);
		}
	}
});

test('Markdown fence info strings preserve language attributes and delimiter restrictions', () => {
	for (const fence of ['```', '````', '~~~', '~~~~']) {
		for (const attributes of [' title="example"', '\tkey=value', ':example', ',example', '{.example}', '?example']) {
			const tokens = tokenize(`${fence}SoMl${attributes}\na: 1\n${fence}\nprose`, markdownGrammar);
			assert.equal(tokens.find(token => token.text === 'a')?.scopes.includes('support.type.property-name.soml'), true);
			assert.equal(tokens.some(token => token.scopes.includes('fenced_code.block.language.attributes.markdown')), true);
			assert.equal(tokens.at(-1).scopes.includes('markup.fenced_code.block.markdown'), false);
		}

		for (const attributes of [' `example`', ' title="`example`"', '`']) {
			const tokens = tokenize(`${fence}soml${attributes}\na: 1\n${fence}\nprose`, markdownGrammar);
			const shouldEmbed = fence.startsWith('~') && attributes.startsWith(' ');
			assert.equal(tokens.some(token => token.scopes.includes('meta.embedded.block.soml')), shouldEmbed);
			if (shouldEmbed) {
				assert.equal(tokens.at(-1).scopes.includes('markup.fenced_code.block.markdown'), false);
			}
		}
	}
});

test('Markdown comments and raw code preserve their boundaries before real SOML fences', () => {
	for (const fence of ['```', '~~~']) {
		for (const ignored of [
			`<!--\n${fence}soml\nhidden: 1\n-->`,
			`<!--\n${fence}soml\nhidden: 1\n${fence}\n-->`,
			`    raw code\n    ${fence}soml\n    hidden: 1`,
			`\tcode\n\t${fence}soml\n\thidden: 1`,
			`\`\`\`\`text\n${fence}soml\nhidden: 1\n\`\`\`\``,
		]) {
			const visible = `${fence}soml\nvisible: 2\n${fence}\nprose`;
			const text = `${ignored}\n\n${visible}`;
			const tokens = tokenize(text, markdownGrammar);
			assert.equal(tokens.filter(token => token.start < ignored.length).some(token => token.scopes.includes('meta.embedded.block.soml')), false);
			assert.equal(tokens.find(token => token.text === 'visible')?.scopes.includes('support.type.property-name.soml'), true);
			assert.equal(tokens.at(-1).scopes.some(scope => scope.startsWith('comment.') || scope === 'markup.fenced_code.block.markdown'), false);
		}
	}
});

test('Markdown resumes SOML fences after embedded scripts and styles', () => {
	for (const embedded of [
		'<script>\nconst example = `\n~~~soml\nhidden: 1\n`;\n</script>',
		'<style>\n/*\n```soml\nhidden: 1\n*/\nbody { color: red; }\n</style>',
	]) {
		const tokens = tokenize(`${embedded}\n\n\`\`\`soml\nvisible: 2\n\`\`\`\nprose`, markdownGrammar);
		assert.equal(tokens.filter(token => token.start < embedded.length).some(token => token.scopes.includes('meta.embedded.block.soml')), false);
		const hidden = tokens.find(token => token.text.includes('hidden: 1'));
		assert.equal(hidden?.scopes.includes(embedded.startsWith('<script>') ? 'string.template.js' : 'comment.block.css'), true);
		assert.equal(tokens.find(token => token.text === 'visible')?.scopes.includes('support.type.property-name.soml'), true);
		assert.equal(tokens.at(-1).scopes.includes('meta.embedded.block.soml'), false);
		assert.equal(tokens.at(-1).scopes.includes('meta.embedded.block.html'), false);
	}
});

test('valid keys and scalar values keep their scopes across comment and collection boundaries', () => {
	const keys = ['name', 'true', '404', '2026-01-01', '\'\'', '\'a:b\'', String.raw`"escaped\nkey"`, '\'😀\''];
	const values = ['0x7FFFFFFFFFFFFFFF', '-1e-1', '-infinity', '1h30m0.1s', '2026-01-01T01:00:00.123456789+01:00', 'true', 'null', String.raw`"text\u{1f600}"`];
	const scopes = {
		Integer: 'constant.numeric.integer.', Float: 'constant.numeric.float.', Duration: 'constant.numeric.duration.', Instant: 'constant.numeric.instant.', Boolean: 'constant.language.boolean.', Null: 'constant.language.null.', String: 'string.quoted.',
	};
	const contexts = [
		(key, value) => `${key}:${value}`,
		(key, value) => `{${key}:\t${value}}`,
		(key, value) => `[{${key}: ${value}}]`,
		(key, value) => `{other: 0,${key}:/* before */${value}/* after */}`,
		(key, value) => `other: 0\n/* before key */${key}:# before value\n${value}# after value`,
		(key, value) => `{\n\t${key}:\n\t/* before value */ ${value},\n}`,
	];
	for (const key of keys) {
		for (const value of values) {
			for (const context of contexts) {
				const text = context(key, value);
				const {body} = parseTree(text);
				const object = body.type === 'Array' ? body.elements[0] : body;
				const member = object.members.at(-1);
				const tokens = tokenize(text);
				for (const [node, scope] of [[member.key, 'support.type.property-name.'], [member.value, scopes[member.value.type]]]) {
					const highlighted = tokens.filter(token => token.start < node.range[1] && token.end > node.range[0]);
					assert.equal(highlighted.length > 0, true, text);
					assert.equal(highlighted.every(token => token.scopes.some(actual => actual.startsWith(scope))), true, text);
				}
			}
		}
	}
});

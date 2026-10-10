import fs from 'node:fs/promises';
import textmate from 'vscode-textmate';
import oniguruma from 'vscode-oniguruma';

// eslint-disable-next-line unicorn/no-top-level-side-effects -- Initialize the shared tokenizer before exporting grammars.
await oniguruma.loadWASM(await fs.readFile(new URL(import.meta.resolve('vscode-oniguruma/release/onig.wasm'))));

const paths = {
	'source.soml': new URL('../syntaxes/soml.tmLanguage.json', import.meta.url),
	'markdown.soml.codeblock': new URL('../syntaxes/markdown.tmLanguage.json', import.meta.url),
	'text.html.markdown': new URL(import.meta.resolve('tm-grammars/grammars/markdown.json')),
	'text.html.basic': new URL(import.meta.resolve('tm-grammars/grammars/html.json')),
	'text.html.derivative': new URL(import.meta.resolve('tm-grammars/grammars/html-derivative.json')),
	'source.js': new URL(import.meta.resolve('tm-grammars/grammars/javascript.json')),
	'source.css': new URL(import.meta.resolve('tm-grammars/grammars/css.json')),
};

const registry = new textmate.Registry({
	onigLib: Promise.resolve({
		createOnigScanner: patterns => new oniguruma.OnigScanner(patterns),
		createOnigString: text => new oniguruma.OnigString(text),
	}),
	async loadGrammar(scope) {
		const path = paths[scope];
		return path ? textmate.parseRawGrammar(await fs.readFile(path, 'utf8'), path.pathname) : undefined;
	},
	getInjections: scope => scope === 'text.html.markdown' ? ['markdown.soml.codeblock'] : [],
});

export const grammar = await registry.loadGrammar('source.soml');
export const markdownGrammar = await registry.loadGrammar('text.html.markdown');

export function tokenize(text, language = grammar) {
	const tokens = [];
	let stack = textmate.INITIAL;
	let offset = 0;
	for (const line of text.split('\n')) {
		const result = language.tokenizeLine(line, stack);
		for (const token of result.tokens) {
			const start = offset + token.startIndex;
			const end = offset + Math.min(token.endIndex, line.length);
			if (end > start) {
				tokens.push({
					start, end, text: text.slice(start, end), scopes: token.scopes,
				});
			}
		}

		stack = result.ruleStack;
		offset += line.length + 1;
	}

	return tokens;
}

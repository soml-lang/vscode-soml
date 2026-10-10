import * as vscode from 'vscode';
import {parseTree, stringifyValue} from 'soml-lang';

function assert(condition, message) {
	if (!condition) {
		throw new Error(message);
	}
}

export async function run() {
	assert(globalThis.WorkerGlobalScope !== undefined && globalThis instanceof globalThis.WorkerGlobalScope, 'Tests must run in the web worker extension host.');
	const extension = vscode.extensions.getExtension('sindresorhus.soml');
	assert(extension, 'Extension must be available in the web worker.');
	await extension.activate();
	const document = await vscode.workspace.openTextDocument({language: 'soml', content: 'integer: 9223372036854775807\nduration: 1ns\ninstant: 2026-01-01T01:00:00.123456789+01:00'});
	const editor = await vscode.window.showTextDocument(document);
	async function replace(text) {
		assert(await editor.edit(edit => edit.replace(new vscode.Range(0, 0, document.lineCount, 0), text)), 'Document replacement must succeed.');
	}

	try {
		for (const [line, expected] of [[0, '9,223,372,036,854,775,807'], [1, '1 nanosecond'], [2, '2026-01-01T00:00:00.123456789Z']]) {
			const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', document.uri, new vscode.Position(line, document.lineAt(line).text.indexOf(':') + 2));
			assert(hovers.some(hover => hover.contents.some(content => content.value.replaceAll('\\', '').replaceAll('&nbsp;', ' ').includes(expected))), `Hover must retain ${expected}.`);
		}

		await replace('a: [1,\n 2]\n');
		const edits = await vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', document.uri, {tabSize: 4, insertSpaces: false});
		const formatting = new vscode.WorkspaceEdit();
		formatting.set(document.uri, edits);
		assert(edits.length > 0 && await vscode.workspace.applyEdit(formatting), 'Formatting must produce applicable edits.');
		assert(document.getText() === 'a: [\n\t1\n\t2\n]\n', 'Formatting must use SOML layout.');
		const symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', document.uri);
		assert(symbols[0].name === 'a' && symbols[0].children.length === 2, 'Outline must include array elements.');

		await replace('wait: 90m');
		const actions = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', document.uri, new vscode.Range(0, 6, 0, 6), 'refactor.rewrite');
		const normalize = actions.find(action => action.title === 'Normalize duration');
		assert(normalize?.edit && await vscode.workspace.applyEdit(normalize.edit), 'Duration normalization must apply.');
		assert(document.getText() === 'wait: 1h30m', 'Duration normalization must preserve its exact value.');

		await replace('\'😀\': nope');
		const deadline = Date.now() + 10_000;
		while (vscode.languages.getDiagnostics(document.uri).length === 0) {
			assert(Date.now() < deadline, 'Timed out waiting for web diagnostics.');
			await new Promise(resolve => {
				setTimeout(resolve, 50);
			});
		}

		const [diagnostic] = vscode.languages.getDiagnostics(document.uri);
		assert(diagnostic.source === 'SOML' && diagnostic.code.value === 'invalid-value' && diagnostic.range.start.character === 6, 'Diagnostics must report UTF-16 offsets and recovery codes.');
		await replace('enabled: tr');
		const completions = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, new vscode.Position(0, 11));
		const completion = completions.items.find(item => item.label === 'true');
		assert(completion && await editor.edit(edit => edit.replace(completion.range, completion.insertText)), 'Value completion must apply.');
		assert(document.getText() === 'enabled: true', 'Value completion must replace the incomplete token.');

		const key = String.raw`a.$}\path`;
		const text = `a: [{${stringifyValue(key)}: true}, {}]`;
		await replace(text);
		const position = document.positionAt(text.lastIndexOf('{}') + 1);
		const siblings = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, position);
		const sibling = siblings.items.find(item => item.detail === 'Key from another object in this array');
		assert(sibling && await editor.insertSnippet(sibling.insertText, sibling.range), 'Sibling-key snippet must expand.');
		assert(parseTree(document.getText()).body.members[0].value.elements[1].members[0].key.value === key, 'Snippet expansion must preserve escaped keys.');
		await vscode.commands.executeCommand('leaveSnippet');
		console.log('Web worker integration passed: activation, exact hovers, formatting, Outline, refactors, UTF-16 diagnostics, completion, and escaped snippets.');
	} finally {
		await vscode.window.showTextDocument(document);
		await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
	}
}

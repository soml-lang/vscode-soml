import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {parse, parseTree, stringifyValue} from 'soml-lang';
import * as vscode from 'vscode';

async function waitFor(predicate, description) {
	const end = Date.now() + 10_000;
	while (!predicate()) {
		assert.ok(Date.now() < end, `Timed out: ${description}`);
		await new Promise(resolve => {
			setTimeout(resolve, 50);
		});
	}
}

export async function run() {
	const extension = vscode.extensions.getExtension('sindresorhus.soml');
	assert.ok(extension);
	await extension.activate();
	const document = await vscode.workspace.openTextDocument({language: 'soml', content: 'servers: [{port: 0x1F90}]\nwait: 1ns\n'});
	const editor = await vscode.window.showTextDocument(document);
	try {
		const symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', document.uri);
		assert.equal(symbols[0].name, 'servers');
		assert.equal(symbols[0].children[0].children[0].name, 'port');
		const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', document.uri, new vscode.Position(0, 17));
		assert.ok(hovers[0].contents[0].value.includes('8,080'));
		const durationHovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', document.uri, new vscode.Position(1, 7));
		assert.match(durationHovers[0].contents[0].value, /^[^1]*1.*nanoseconds/sv);
		const selections = await vscode.commands.executeCommand('vscode.executeSelectionRangeProvider', document.uri, [new vscode.Position(0, 17)]);
		assert.ok(selections[0].parent);
		for (const key of ['not-found-page', 'x-forwarded-for', '_private', '404', '-foo', '2024-01-01', '7zip-bin']) {
			await editor.edit(edit => edit.replace(new vscode.Range(0, 0, document.lineCount, 0), `${key}: true`));
			editor.selection = new vscode.Selection(0, 0, 0, 0);
			await vscode.commands.executeCommand('cursorWordEndRightSelect');
			assert.equal(document.getText(editor.selection), key);
		}

		await editor.edit(edit => edit.replace(new vscode.Range(0, 0, document.lineCount, 0), 'a: [1,\n 2]\n'));
		const edits = await vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', document.uri, {tabSize: 4, insertSpaces: false});
		assert.ok(edits.length > 0);
		const workspaceEdit = new vscode.WorkspaceEdit();
		workspaceEdit.set(document.uri, edits);
		assert.ok(await vscode.workspace.applyEdit(workspaceEdit));
		assert.equal(document.getText(), 'a: [\n\t1\n\t2\n]\n');
		const folding = await vscode.commands.executeCommand('vscode.executeFoldingRangeProvider', document.uri);
		assert.ok(folding.some(fold => fold.start === 0 && fold.end === 2));

		await editor.edit(edit => edit.replace(new vscode.Range(0, 0, document.lineCount, 0), '\'😀\': no'));
		await waitFor(() => vscode.languages.getDiagnostics(document.uri).length > 0, 'invalid document diagnostic');
		const [diagnostic] = vscode.languages.getDiagnostics(document.uri);
		assert.equal(diagnostic.source, 'SOML');
		assert.equal(diagnostic.code.value, 'invalid-value');
		assert.equal(diagnostic.code.target.toString(), 'https://github.com/soml-lang/soml/blob/main/spec.md');
		assert.equal(diagnostic.range.start.character, 6);
		assert.deepEqual(await vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', document.uri, {tabSize: 4, insertSpaces: true}) ?? [], []);
		await editor.edit(edit => edit.replace(new vscode.Range(0, 0, document.lineCount, 0), 'missing:\nitems: [\n{enabled: true}\n]'));
		const recoveredSymbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', document.uri);
		assert.deepEqual(recoveredSymbols.map(symbol => symbol.name), ['missing', 'items']);
		assert.equal(recoveredSymbols[1].children[0].children[0].name, 'enabled');
		const recoveredFolds = await vscode.commands.executeCommand('vscode.executeFoldingRangeProvider', document.uri);
		assert.ok(recoveredFolds.some(fold => fold.start === 1 && fold.end === 2));
		const recoveredSelections = await vscode.commands.executeCommand('vscode.executeSelectionRangeProvider', document.uri, [new vscode.Position(2, 11)]);
		assert.ok(recoveredSelections[0].parent);
		assert.equal(document.getText(recoveredSelections[0].range), 'true');
		assert.deepEqual(await vscode.commands.executeCommand('vscode.executeFormatDocumentProvider', document.uri, {tabSize: 4, insertSpaces: true}) ?? [], []);
		assert.deepEqual(await vscode.commands.executeCommand('vscode.executeCodeActionProvider', document.uri, new vscode.Range(2, 11, 2, 11), 'refactor.rewrite') ?? [], []);
		await editor.edit(edit => edit.replace(new vscode.Range(0, 0, document.lineCount, 0), 'a: true'));
		await waitFor(() => vscode.languages.getDiagnostics(document.uri).length === 0, 'diagnostics clear after fixing');
		for (const bracket of ['[', '{']) {
			const initial = 'a: \'text\'';
			await editor.edit(edit => edit.replace(new vscode.Range(0, 0, document.lineCount, 0), initial));
			editor.selection = new vscode.Selection(0, initial.length - 1, 0, initial.length - 1);
			await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
			await vscode.commands.executeCommand('type', {text: bracket});
			assert.equal(document.getText(), `a: 'text${bracket}'`, 'Brackets inside strings must not auto-close');
		}

		await editor.edit(edit => edit.replace(new vscode.Range(0, 0, document.lineCount, 0), 'a: 1\na: 2\nb: nope'));
		await waitFor(() => vscode.languages.getDiagnostics(document.uri).length === 2, 'multiple independent diagnostics');
		const problems = vscode.languages.getDiagnostics(document.uri);
		const duplicate = problems.find(problem => problem.code.value === 'duplicate-key');
		assert.ok(duplicate);
		assert.equal(duplicate.relatedInformation[0].location.uri.toString(), document.uri.toString());
		assert.equal(duplicate.relatedInformation[0].location.range.start.line, 0);
		assert.equal(duplicate.range.start.line, 1);
		assert.ok(problems.some(problem => problem.code.value === 'invalid-value' && problem.range.start.line === 2));

		await editor.edit(edit => edit.replace(new vscode.Range(0, 0, document.lineCount, 0), String.raw`value: "hello\nworld" # keep`));
		for (const title of ['Convert to block string', 'Convert to single-line string']) {
			const position = document.positionAt(document.getText().search(/["']/v));
			const actions = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', document.uri, new vscode.Range(position, position), 'refactor.rewrite');
			const action = actions.find(action => action.title === title);
			assert.ok(action?.edit, title);
			assert.ok(await vscode.workspace.applyEdit(action.edit));
			assert.equal(parse(document.getText()).value, 'hello\nworld');
			assert.ok(document.getText().endsWith('# keep'));
			if (title === 'Convert to block string') {
				assert.equal(document.getText(), 'value:\n\t\'\'\'\n\thello\n\tworld\n\t\'\'\' # keep');
			} else {
				assert.equal(document.getText(), String.raw`value: "hello\nworld" # keep`);
			}
		}

		await editor.edit(edit => edit.replace(new vscode.Range(0, 0, document.lineCount, 0), 'ports: [0x50, 443]'));
		const refactorActions = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', document.uri, new vscode.Range(0, 8, 0, 8), 'refactor.rewrite');
		const expand = refactorActions.find(action => action.title === 'Expand collection');
		assert.ok(expand?.edit);
		assert.ok(await vscode.workspace.applyEdit(expand.edit));
		assert.equal(document.getText(), 'ports: [\n\t0x50\n\t443\n]');
		const compactActions = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', document.uri, new vscode.Range(0, 8, 0, 8), 'refactor.rewrite');
		assert.ok(await vscode.workspace.applyEdit(compactActions.find(action => action.title === 'Compact collection').edit));
		assert.equal(document.getText(), 'ports: [0x50, 443]');

		await editor.edit(edit => edit.replace(new vscode.Range(0, 0, document.lineCount, 0), 'name: \'hello\''));
		const quoteActions = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', document.uri, new vscode.Range(0, 9, 0, 9), 'refactor.rewrite');
		assert.ok(await vscode.workspace.applyEdit(quoteActions.find(action => action.title === 'Convert to escaped string').edit));
		assert.equal(document.getText(), 'name: "hello"');

		await editor.edit(edit => edit.replace(new vscode.Range(0, 0, document.lineCount, 0), 'enabled: tr'));
		const completionResult = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, new vscode.Position(0, 11));
		const completion = completionResult.items.find(item => item.label === 'true');
		assert.ok(completion);
		assert.equal(completion.range.start.character, 9);
		assert.equal(completion.range.end.character, 11);
		await editor.edit(edit => edit.replace(completion.range, completion.insertText));
		assert.equal(document.getText(), 'enabled: true');

		await editor.edit(edit => edit.replace(new vscode.Range(0, 0, document.lineCount, 0), 'a: '));
		const valueCompletions = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, new vscode.Position(0, 3));
		const contextualValues = valueCompletions.items.filter(item => typeof item.label === 'string' && item.detail);
		assert.equal(contextualValues.length, 12);
		for (const item of contextualValues) {
			await editor.edit(edit => edit.replace(new vscode.Range(0, 0, document.lineCount, 0), 'a: '));
			if (typeof item.insertText === 'string') {
				await editor.edit(edit => edit.insert(new vscode.Position(0, 3), item.insertText));
			} else {
				await editor.insertSnippet(item.insertText, new vscode.Position(0, 3));
			}

			assert.doesNotThrow(() => parseTree(document.getText()), `${item.label} completion must insert valid SOML`);
			await vscode.commands.executeCommand('leaveSnippet');
		}

		await editor.edit(edit => edit.replace(new vscode.Range(0, 0, document.lineCount, 0), 'mask: 255'));
		const radixActions = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', document.uri, new vscode.Range(0, 6, 0, 6), 'refactor.rewrite');
		assert.ok(await vscode.workspace.applyEdit(radixActions.find(action => action.title === 'Convert to hexadecimal').edit));
		assert.equal(document.getText(), 'mask: 0xFF');
		await editor.edit(edit => edit.replace(new vscode.Range(0, 0, document.lineCount, 0), 'limit: -9223372036854775808 # keep'));
		for (const [title, expected] of [['Group decimal digits', '-9_223_372_036_854_775_808'], ['Remove decimal digit grouping', '-9223372036854775808']]) {
			const actions = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', document.uri, new vscode.Range(0, 8, 0, 8), 'refactor.rewrite');
			assert.ok(await vscode.workspace.applyEdit(actions.find(action => action.title === title).edit));
			assert.equal(document.getText(), `limit: ${expected} # keep`);
		}

		const previousClipboard = await vscode.env.clipboard.readText();
		try {
			const value = 'C:\\Users\\Alice\n"😀"\t${1:literal}';
			await vscode.env.clipboard.writeText(value);
			for (const initial of ['value: ', 'value: false']) {
				await editor.edit(edit => edit.replace(new vscode.Range(0, 0, document.lineCount, 0), initial));
				editor.selection = new vscode.Selection(0, 7, 0, initial.length);
				await vscode.commands.executeCommand('soml.pasteAsString');
				assert.equal(parseTree(document.getText()).body.members[0].value.value, value);
				assert.equal(document.lineCount, 1);
				await vscode.commands.executeCommand('undo');
				assert.equal(document.getText(), initial);
			}
		} finally {
			await vscode.env.clipboard.writeText(previousClipboard);
		}

		await editor.edit(edit => edit.replace(new vscode.Range(0, 0, document.lineCount, 0), 'created: '));
		editor.selection = new vscode.Selection(0, 9, 0, 9);
		const beforeInstant = Date.now();
		await vscode.commands.executeCommand('soml.insertCurrentInstant');
		const instant = document.getText().slice(9);
		assert.ok(Date.parse(instant) >= beforeInstant);
		assert.ok(Date.parse(instant) <= Date.now());
		assert.doesNotThrow(() => parseTree(document.getText()));
		await editor.edit(edit => edit.replace(new vscode.Range(0, 0, document.lineCount, 0), 'wait: 90m'));
		const readableHovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', document.uri, new vscode.Position(0, 6));
		assert.match(readableHovers[0].contents[0].value.replaceAll('&nbsp;', ' '), /1 hour 30 minutes/v);
		for (const [literal, title, expected] of [
			['90m', 'Normalize duration', '1h30m'],
			['2026-10-11T14:00:00.123456789+07:00', 'Convert instant to UTC', '2026-10-11T07:00:00.123456789Z'],
		]) {
			await editor.edit(edit => edit.replace(new vscode.Range(0, 0, document.lineCount, 0), `value: ${literal} # keep`));
			const actions = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', document.uri, new vscode.Range(0, 7, 0, 7), 'refactor.rewrite');
			const action = actions.find(action => action.title === title);
			assert.ok(action?.edit);
			assert.ok(await vscode.workspace.applyEdit(action.edit));
			assert.equal(document.getText(), `value: ${expected} # keep`);
			const remaining = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', document.uri, new vscode.Range(0, 7, 0, 7), 'refactor.rewrite');
			assert.ok(remaining.every(candidate => candidate.title !== title));
		}

		for (const key of ['a.$}', '$TM_FILENAME', '${1:boom}', String.raw`C:\path`, 'line\nnext', 'tab\tkey', '\u{0}', '\'single\' and "double"', '😀']) {
			const text = `a: [{${stringifyValue(key)}: true}, {}]`;
			await editor.edit(edit => edit.replace(new vscode.Range(0, 0, document.lineCount, 0), text));
			const position = document.positionAt(text.lastIndexOf('{}') + 1);
			const completions = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, position);
			const item = completions.items.find(item => item.detail === 'Key from another object in this array');
			assert.ok(item, key);
			assert.ok(item.range.isSingleLine);
			assert.ok(item.range.contains(position));
			assert.ok(await editor.insertSnippet(item.insertText, item.range));
			assert.equal(Object.keys(parse(document.getText()).a[1])[0], key);
			await vscode.commands.executeCommand('leaveSnippet');
		}

		for (const [source, expected] of [['[{name: 1}, {na|}]', '[{name: 1}, {name: null}]'], ['[{names: 1}, {na|me: 1ns}]', '[{names: 1}, {names: 1ns}]'], ['[{name: 1}, {na|', '[{name: 1}, {name: null']]) {
			const offset = source.indexOf('|');
			await editor.edit(edit => edit.replace(new vscode.Range(0, 0, document.lineCount, 0), source.replace('|', '')));
			const completions = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', document.uri, document.positionAt(offset));
			const item = completions.items.find(item => item.detail === 'Key from another object in this array');
			assert.ok(item);
			if (typeof item.insertText === 'string') {
				assert.ok(await editor.edit(edit => edit.replace(item.range, item.insertText)));
			} else {
				assert.ok(await editor.insertSnippet(item.insertText, item.range));
			}

			assert.equal(document.getText(), expected);
			await vscode.commands.executeCommand('leaveSnippet');
		}

		await editor.edit(edit => edit.replace(new vscode.Range(0, 0, document.lineCount, 0), 'a: 255'));
		const selection = new vscode.Range(0, 4, 0, 4);
		const generic = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', document.uri, selection, 'refactor');
		assert.ok(generic.some(item => item.title === 'Convert to hexadecimal'));
		for (const kind of ['quickfix', 'refactor.extract', 'source']) {
			const actions = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', document.uri, selection, kind);
			assert.ok(actions.every(item => item.title !== 'Convert to hexadecimal'));
		}

		await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
		for (const quote of ['\'', '"']) {
			await editor.edit(edit => edit.replace(new vscode.Range(0, 0, document.lineCount, 0), 'a: '));
			editor.selection = new vscode.Selection(0, 3, 0, 3);
			for (let index = 0; index < 3; index++) {
				await vscode.commands.executeCommand('type', {text: quote});
			}

			assert.equal(document.getText(), `a: ${quote.repeat(3)}`);
			await vscode.commands.executeCommand('type', {text: '\n'});

			assert.equal(document.getText(), `a: ${quote.repeat(3)}\n`);
			await vscode.commands.executeCommand('type', {text: 'content\n'});
			for (let index = 0; index < 3; index++) {
				await vscode.commands.executeCommand('type', {text: quote});
			}

			assert.equal(document.getText(), `a: ${quote.repeat(3)}\ncontent\n${quote.repeat(3)}`);

			assert.equal(parseTree(document.getText()).body.members[0].value.value, 'content');
		}

		for (const [source, typed, expected, cursorBefore] of [
			['a:|', '\n', 'a:\n\t'],
			['a: # note|', '\n', 'a: # note\n\t'],
			['a: [|]', '\n', 'a: [\n\t\n]'],
			['a: {|}', '\n', 'a: {\n\t\n}'],
			['a: [ # note|', '\n', 'a: [ # note\n\t'],
			['a: [[1]|', '\n', 'a: [[1]\n\t'],
			['from: {\n\taddress: \'quarry@example.com\',| name: \'Quarry\'\n}', '\n', 'from: {\n\taddress: \'quarry@example.com\'\n\tname: \'Quarry\'\n}'],
			['a: [1,| 2]\nbroken:', '\n', 'a: [\n\t1\n\t2\n]\nbroken:', '2'],
			['a: [1,| 2]', '\n', 'a: [\n\t1\n\t2\n]', '2'],
			['deny-networks: [\'10.0.0.0/8\',| \'172.16.0.0/12\', \'192.168.0.0/16\', \'169.254.0.0/16\', \'fd00::/8\']', '\n', 'deny-networks: [\n\t\'10.0.0.0/8\'\n\t\'172.16.0.0/12\'\n\t\'192.168.0.0/16\'\n\t\'169.254.0.0/16\'\n\t\'fd00::/8\'\n]', '\'172.16.0.0/12\''],
			['[\'example.com\',| \'contractors.example.com\']', '\n', '[\n\t\'example.com\'\n\t\'contractors.example.com\'\n]', '\'contractors.example.com\''],
			['from: {address: \'quarry@example.com\',| name: \'Quarry\'}', '\n', 'from: {\n\taddress: \'quarry@example.com\'\n\tname: \'Quarry\'\n}', 'name'],
			['a: [\n\t1, # keep|\n]', '\n', 'a: [\n\t1 # keep\n\t\n]'],
			['a:\n\ttrue|', '\n', 'a:\n\ttrue\n'],
			['a: [\n\t1\n\t|', ']', 'a: [\n\t1\n]'],
			['a: {\n\tb: 1\n\t|', '}', 'a: {\n\tb: 1\n}'],
		]) {
			const offset = source.indexOf('|');
			await editor.edit(edit => edit.replace(new vscode.Range(0, 0, document.lineCount, 0), source.replace('|', '')));
			editor.selection = new vscode.Selection(document.positionAt(offset), document.positionAt(offset));
			await vscode.commands.executeCommand('type', {text: typed});
			await waitFor(() => document.getText() === expected, `typing indentation ${JSON.stringify(source)}: ${JSON.stringify(document.getText())}`);
			if (cursorBefore === undefined) {
				continue;
			}

			assert.equal(document.offsetAt(editor.selection.active), expected.indexOf(cursorBefore));
			await vscode.commands.executeCommand('undo');
			assert.equal(document.getText(), source.replace('|', ''));
			await vscode.commands.executeCommand('redo');
			assert.equal(document.getText(), expected);
		}

		for (const source of ['a: \'\'\'\ntext:|\n\'\'\'', 'a: \'\'\'\n[|\n\'\'\'', 'a: \'\'\'\ntext,|\n\'\'\'', 'a: """\ntext:|\n"""', '/* note:|\n*/', '# note:|', '# note,|']) {
			const offset = source.indexOf('|');
			const expected = source.replace('|', '\n');
			await editor.edit(edit => edit.replace(new vscode.Range(0, 0, document.lineCount, 0), source.replace('|', '')));
			editor.selection = new vscode.Selection(document.positionAt(offset), document.positionAt(offset));
			await vscode.commands.executeCommand('type', {text: '\n'});
			assert.equal(document.getText(), expected, source);
		}

		const originalOptions = editor.options;
		editor.options = {
			...originalOptions, insertSpaces: true, tabSize: 2, indentSize: 2,
		};
		await waitFor(() => editor.options.insertSpaces === true && editor.options.tabSize === 2 && editor.options.indentSize === 2, 'editor options updated');
		await editor.edit(edit => edit.replace(new vscode.Range(0, 0, document.lineCount, 0), 'key:'));
		editor.selection = new vscode.Selection(0, 4, 0, 4);
		await vscode.commands.executeCommand('type', {text: '\n'});
		await waitFor(() => document.getText() === 'key:\n  ', `typing respects two-space indentation: ${JSON.stringify(document.getText())}, ${JSON.stringify(editor.options)}`);
		editor.options = originalOptions;

		const editorConfiguration = vscode.workspace.getConfiguration('editor', document);
		await editorConfiguration.update('formatOnType', false, vscode.ConfigurationTarget.Global, true);
		try {
			await editor.edit(edit => edit.replace(new vscode.Range(0, 0, document.lineCount, 0), 'key:'));
			editor.selection = new vscode.Selection(0, 4, 0, 4);
			await vscode.commands.executeCommand('type', {text: '\n'});
			await new Promise(resolve => {
				setTimeout(resolve, 100);
			});
			assert.equal(document.getText(), 'key:\n');
		} finally {
			await editorConfiguration.update('formatOnType', undefined, vscode.ConfigurationTarget.Global, true);
		}

		const snippets = JSON.parse(await fs.readFile(path.join(extension.extensionPath, 'snippets/soml.json'), 'utf8'));
		for (const [name, snippet] of Object.entries(snippets)) {
			await editor.edit(edit => edit.replace(new vscode.Range(0, 0, document.lineCount, 0), ''));
			const body = Array.isArray(snippet.body) ? snippet.body.join('\n') : snippet.body;
			assert.ok(await editor.insertSnippet(new vscode.SnippetString(body), new vscode.Position(0, 0)));
			assert.doesNotThrow(() => parseTree(document.getText()), `${name} snippet must insert valid SOML`);
			await vscode.commands.executeCommand('leaveSnippet');
		}

		console.log('VS Code integration passed: activation, symbols, numeric and duration hovers, selections, minimal formatting, folding, UTF-16 diagnostics, edit recovery, bracket pairing, refactors, contextual completion, and every bundled snippet.');
	} finally {
		await vscode.window.showTextDocument(document);
		await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
	}
}

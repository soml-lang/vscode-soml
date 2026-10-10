import test, {suite} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';

const metafile = JSON.parse(await fs.readFile(new URL('../distribution/metafile.json', import.meta.url), 'utf8'));
const manifest = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));

for (const [format, filename] of [['esm', 'extension.js'], ['cjs', 'extension.cjs']]) {
	const bundle = await fs.readFile(new URL(`../distribution/${filename}`, import.meta.url), 'utf8');

	suite(format, () => {
		async function runtime(documents = []) {
			const providers = new Map();
			const commands = new Map();
			const window = {};
			const clipboard = {};
			const listeners = new Map();
			const timers = new Map();
			let nextTimer = 0;
			const diagnostics = new Map();
			const configuration = new Map();
			const dispose = {dispose() {}};
			class Range {
				constructor(start, end) {
					this.start = start;
					this.end = end;
				}
			}

			class Diagnostic {
				constructor(range, message, severity) {
					Object.assign(this, {range, message, severity});
				}
			}

			class MarkdownString {
				value;

				appendText(text) {
					this.value = text;
				}
			}

			class Hover {
				constructor(contents, range) {
					Object.assign(this, {contents, range});
				}
			}

			class SelectionRange {
				constructor(range, parent) {
					Object.assign(this, {range, parent});
				}
			}

			const vscode = {
				env: {clipboard},
				Uri: {parse: value => new URL(value)},
				CodeAction: class {
					constructor(title, kind) {
						Object.assign(this, {title, kind});
					}
				},
				WorkspaceEdit: class {
					replace(uri, range, text) {
						Object.assign(this, {uri, range, text});
					}
				},
				SymbolKind: {},
				CodeActionKind: {RefactorRewrite: {}},
				Selection: Range,
				SelectionRange,
				FoldingRange: class {
					constructor(start, end, kind) {
						Object.assign(this, {start, end, kind});
					}
				},
				TextEditorRevealType: {InCenterIfOutsideViewport: 1},
				window,
				DiagnosticSeverity: {Error: 0, Information: 2},
				Range,
				TextEdit: {replace: (range, newText) => ({range, newText})},
				Diagnostic,
				Location: class {
					constructor(uri, range) {
						Object.assign(this, {uri, range});
					}
				},
				DiagnosticRelatedInformation: class {
					constructor(location, message) {
						Object.assign(this, {location, message});
					}
				},
				MarkdownString,
				Hover,
				languages: {
					createDiagnosticCollection() {
						return {set: (uri, entries) => diagnostics.set(uri, entries), delete: uri => diagnostics.delete(uri), dispose() {}};
					},
				},
				workspace: {
					textDocuments: documents,
					getConfiguration() {
						return {get: (key, fallback) => configuration.get(key) ?? fallback};
					},
				},
				commands: {
					registerCommand(name, callback) {
						commands.set(name, callback);
						return dispose;
					},
				},
			};
			for (const name of ['OnTypeFormattingEdit', 'DocumentFormattingEdit', 'DocumentSymbol', 'FoldingRange', 'SelectionRange', 'Hover', 'CodeActions', 'CompletionItem']) {
				vscode.languages[`register${name}Provider`] = (_selector, provider) => {
					providers.set(name, provider);
					return dispose;
				};
			}

			for (const name of ['OpenTextDocument', 'ChangeTextDocument', 'CloseTextDocument', 'ChangeConfiguration']) {
				vscode.workspace[`onDid${name}`] = listener => {
					listeners.set(name, listener);
					return dispose;
				};
			}

			const context = vm.createContext({
				Temporal: undefined,
				setTimeout(callback) {
					timers.set(++nextTimer, callback);
					return nextTimer;
				},
				clearTimeout: identifier => timers.delete(identifier),
			});
			let activate;
			if (format === 'esm') {
				const extension = new vm.SourceTextModule(bundle, {context});
				await extension.link(name => {
					assert.equal(name, 'vscode');
					return new vm.SyntheticModule(Object.keys(vscode), function () {
						for (const [key, value] of Object.entries(vscode)) {
							this.setExport(key, value);
						}
					}, {context});
				});
				await extension.evaluate();
				activate = extension.namespace.activate;
			} else {
				context.module = {exports: {}};
				context.require = name => {
					assert.equal(name, 'vscode');
					return vscode;
				};

				vm.runInContext(bundle, context);
				({activate} = context.module.exports);
			}

			const extensionContext = {subscriptions: []};
			activate(extensionContext);
			return {
				providers, commands, window, clipboard, listeners, timers, diagnostics, extensionContext, configuration, documents: vscode.workspace.textDocuments,
			};
		}

		test('bundle has only the host API import and activates without Temporal', async () => {
			const output = metafile.outputs[`distribution/${filename}`];
			assert.deepEqual(output.imports.map(entry => [entry.path, entry.kind]), [['vscode', format === 'esm' ? 'import-statement' : 'require-call']]);
			assert.deepEqual(output.exports, format === 'esm' ? ['activate'] : []);
			assert.equal(manifest[format === 'esm' ? 'main' : 'browser'], `./distribution/${filename}`);

			const environment = await runtime();
			assert.equal(environment.providers.size, 8);
			const declaredCommands = manifest.contributes.commands.map(command => command.command);
			assert.deepEqual(new Set(environment.commands.keys()), new Set(declaredCommands));
		});

		test('bundled scalar hovers preserve precision without Temporal', async () => {
			const {providers} = await runtime();
			const literals = [
				['1ns', '1 nanoseconds'],
				['2026-01-01T01:00:00.123456789+01:00', 'UTC: 2026-01-01T00:00:00.123456789Z'],
				['9223372036854775807', '9,223,372,036,854,775,807'],
			];
			for (const [literal, expected] of literals) {
				const document = {
					version: 1, getText: () => `a: ${literal}`, offsetAt: position => position.character, positionAt: offset => ({line: 0, character: offset}),
				};
				const hover = providers.get('Hover').provideHover(document, {line: 0, character: 3}, {isCancellationRequested: false});
				assert.equal(hover.contents.value.includes(expected), true);
				assert.equal(hover.range.start.character, 3);
				assert.equal(hover.range.end.character, literal.length + 3);
			}
		});

		test('activation validates existing SOML documents without reading unrelated documents', async () => {
			let reads = 0;
			const document = {
				uri: 'virtual:existing', languageId: 'soml', version: 1, getText() {
					reads++;
					return 'enabled: nope';
				}, positionAt: offset => ({line: 0, character: offset}),
			};
			const other = {
				languageId: 'plaintext', getText() {
					assert.fail('Unrelated documents must not be read');
				},
			};
			const {timers, diagnostics} = await runtime([document, other]);
			assert.equal(reads, 0);
			assert.equal(timers.size, 1);
			timers.values().next().value();
			assert.equal(reads, 1);
			assert.equal(diagnostics.get(document.uri)[0].code.value, 'invalid-value');
		});

		test('commands ignore missing editors and other languages', async () => {
			const {commands, window} = await runtime();
			for (const editor of [undefined, {document: {languageId: 'plaintext'}}]) {
				window.activeTextEditor = editor;
				for (const command of commands.values()) {
					await command();
				}
			}
		});

		test('Copy Key Path writes quoted nested paths and leaves the clipboard alone outside a member', async () => {
			const {commands, window, clipboard} = await runtime();
			const text = 'servers: [{"a.b": true}]';
			const selection = {active: text.indexOf('true')};
			window.activeTextEditor = {
				document: {
					languageId: 'soml', version: 1, getText: () => text, offsetAt: position => position,
				}, selection,
			};
			const copied = [];
			clipboard.writeText = async value => {
				copied.push(value);
			};

			const messages = [];
			window.showInformationMessage = async value => {
				messages.push(value);
			};

			await commands.get('soml.copyKeyPath')();
			assert.deepEqual(copied, ['servers[0].\'a.b\'']);
			selection.active = text.length;
			await commands.get('soml.copyKeyPath')();
			assert.equal(copied.length, 1);
			assert.equal(messages.length, 1);
		});

		test('oversized documents disable every structural provider until the size limit is raised', async () => {
			const {providers, configuration} = await runtime();
			const text = 'values: [\n 255\n]\nenabled: true';
			const lines = text.split('\n');
			const cursor = {line: 3, character: 9};
			const integer = {line: 1, character: 1};
			const token = {isCancellationRequested: false};
			const document = {
				version: 1,
				getText: () => text,
				offsetAt: position => lines.slice(0, position.line).join('\n').length + (position.line > 0 ? 1 : 0) + position.character,
				positionAt(offset) {
					const prefix = text.slice(0, offset).split('\n');
					return {line: prefix.length - 1, character: prefix.at(-1).length};
				},
			};
			configuration.set('maxDocumentSize', text.length - 1);
			assert.equal(providers.get('DocumentFormattingEdit').provideDocumentFormattingEdits(document, {}, token).length, 0);
			assert.equal(providers.get('DocumentSymbol').provideDocumentSymbols(document, token).length, 0);
			assert.equal(providers.get('FoldingRange').provideFoldingRanges(document, {}, token).length, 0);
			assert.equal(providers.get('CompletionItem').provideCompletionItems(document, cursor, token).length, 0);
			assert.equal(providers.get('CodeActions').provideCodeActions(document, {start: integer, end: integer}, {}, token).length, 0);
			assert.equal(providers.get('Hover').provideHover(document, cursor, token), undefined);
			const selections = providers.get('SelectionRange').provideSelectionRanges(document, [cursor], token);
			assert.equal(selections.length, 1);
			assert.equal(selections[0].range.start, cursor);
			assert.equal(selections[0].parent, undefined);
			configuration.set('maxDocumentSize', text.length);
			assert.ok(providers.get('DocumentFormattingEdit').provideDocumentFormattingEdits(document, {}, token).length > 0);
			assert.ok(providers.get('FoldingRange').provideFoldingRanges(document, {}, token).length > 0);
			assert.ok(providers.get('CodeActions').provideCodeActions(document, {start: integer, end: integer}, {}, token).length > 0);
			assert.ok(providers.get('SelectionRange').provideSelectionRanges(document, [cursor], token)[0].parent);
			assert.equal(providers.get('Hover').provideHover(document, cursor, token).contents.value, 'Boolean\ntrue');
		});

		test('canceled provider requests never read or parse the document', async () => {
			const {providers} = await runtime();
			const document = {
				getText() {
					throw new Error('Canceled request read the document');
				},
			};
			const token = {isCancellationRequested: true};
			for (const [name, provider] of providers) {
				const method = Object.values(provider)[0];
				const argumentCounts = {OnTypeFormattingEdit: 5, DocumentSymbol: 2, CodeActions: 4};
				const arguments_ = Array.from({length: argumentCounts[name] ?? 3});
				arguments_[0] = document;
				arguments_[arguments_.length - 1] = token;
				const result = await method(...arguments_);
				assert.equal(result === undefined || result.length === 0, true);
			}
		});

		test('on-type formatting joins the typing undo step and applies minimal edits', async () => {
			const {providers, window} = await runtime();
			let text = 'a: [1,\n 2]';
			const document = {
				version: 1, getText: () => text, positionAt: offset => offset, offsetAt: position => position,
			};
			let editCount = 0;
			window.activeTextEditor = {
				document, async edit(callback, options) {
					assert.deepEqual({...options}, {undoStopBefore: false, undoStopAfter: true});
					const edits = [];
					callback({
						replace(range, value) {
							edits.push({range, value});
						},
					});
					editCount = edits.length;
					for (const edit of edits.toReversed()) {
						text = text.slice(0, edit.range.start) + edit.value + text.slice(edit.range.end);
					}

					return true;
				},
			};
			const result = await providers.get('OnTypeFormattingEdit').provideOnTypeFormattingEdits(document, 7, '\n', {insertSpaces: false, tabSize: 4}, {isCancellationRequested: false});
			assert.equal(result.length, 0);
			assert.equal(editCount > 1, true);
			assert.equal(text, 'a: [\n\t1\n\t2\n]');
		});

		test('on-type formatting ignores documents outside the active editor', async () => {
			const {providers, window} = await runtime();
			const document = {
				getText() {
					assert.fail('An inactive document must not be read');
				},
			};
			window.activeTextEditor = {document: {}};
			const result = await providers.get('OnTypeFormattingEdit').provideOnTypeFormattingEdits(document, 0, '\n', {}, {isCancellationRequested: false});
			assert.equal(result.length, 0);
		});

		test('diagnostic debounce coalesces changes, reads the latest text, and clears on close', async () => {
			const {listeners, timers, diagnostics} = await runtime();
			let text = 'a: no';
			let reads = 0;
			const document = {
				uri: 'untitled:test', languageId: 'soml', version: 1, isClosed: false, getText() {
					reads++;
					return text;
				}, positionAt: offset => ({line: 0, character: offset}),
			};
			listeners.get('OpenTextDocument')(document);
			for (let index = 0; index < 10; index++) {
				listeners.get('ChangeTextDocument')({document});
			}

			assert.equal(timers.size, 1);
			assert.equal(reads, 0);
			timers.values().next().value();
			assert.equal(reads, 1);
			assert.equal(diagnostics.get(document.uri)[0].source, 'SOML');
			assert.equal(diagnostics.get(document.uri)[0].code.value, 'invalid-value');
			assert.equal(diagnostics.get(document.uri)[0].code.target.href, 'https://github.com/soml-lang/soml/blob/main/spec.md');
			text = 'a: 1ns';
			document.version++;
			listeners.get('ChangeTextDocument')({document});
			timers.values().next().value();
			assert.equal(diagnostics.has(document.uri), false);
			listeners.get('ChangeTextDocument')({document});
			listeners.get('CloseTextDocument')(document);
			assert.equal(timers.size, 0);
		});

		test('deactivation cancels pending work', async () => {
			const {listeners, timers, extensionContext} = await runtime();
			listeners.get('OpenTextDocument')({languageId: 'soml'});
			assert.equal(timers.size, 1);
			for (const disposable of extensionContext.subscriptions) {
				disposable.dispose();
			}

			assert.equal(timers.size, 0);
		});

		test('changing validation settings clears and restores existing errors', async () => {
			const {listeners, timers, diagnostics, configuration, documents} = await runtime();
			const document = {
				uri: 'untitled:settings', languageId: 'soml', version: 1, getText: () => 'a: no', positionAt: offset => ({line: 0, character: offset}),
			};
			documents.push(document);
			listeners.get('OpenTextDocument')(document);
			timers.values().next().value();
			assert.equal(diagnostics.has(document.uri), true);
			configuration.set('validation.enabled', false);
			listeners.get('ChangeConfiguration')({affectsConfiguration: key => key === 'soml'});
			timers.values().next().value();
			assert.equal(diagnostics.has(document.uri), false);
			configuration.set('validation.enabled', true);
			listeners.get('ChangeConfiguration')({affectsConfiguration: key => key === 'soml'});
			timers.values().next().value();
			assert.equal(diagnostics.has(document.uri), true);
		});

		test('raising the size limit revalidates the same document version', async () => {
			const {listeners, timers, diagnostics, configuration, documents} = await runtime();
			const document = {
				uri: 'untitled:size', languageId: 'soml', version: 1, getText: () => 'a: 123', positionAt: offset => ({line: 0, character: offset}),
			};
			documents.push(document);
			configuration.set('maxDocumentSize', 5);
			listeners.get('OpenTextDocument')(document);
			timers.values().next().value();
			assert.equal(diagnostics.get(document.uri)[0].code.value, 'document-size-limit');
			assert.equal(diagnostics.get(document.uri)[0].code.target.href, 'https://github.com/soml-lang/vscode-soml#settings');
			configuration.set('maxDocumentSize', 6);
			listeners.get('ChangeConfiguration')({affectsConfiguration: () => true});
			timers.values().next().value();
			assert.equal(diagnostics.has(document.uri), false);
		});

		test('Go to Key Path reveals the selected full path and ignores stale selections', async () => {
			const {commands, window} = await runtime();
			const text = 'servers: [{port: 80}, {port: 443}]';
			const document = {
				languageId: 'soml', version: 1, getText: () => text, positionAt: offset => ({line: 0, character: offset}),
			};
			let revealed;
			const editor = {
				document, revealRange(range) {
					revealed = range;
				},
			};
			window.activeTextEditor = editor;
			window.showTextDocument = async target => {
				assert.equal(target, document);
				return editor;
			};

			window.showQuickPick = async items => items.find(item => item.label === 'servers[1].port');
			await commands.get('soml.goToKeyPath')();
			assert.equal(revealed.start.character, text.lastIndexOf('port'));
			assert.equal(editor.selection.end.character, text.lastIndexOf('port') + 4);
			revealed = undefined;
			window.showQuickPick = async items => {
				document.version++;
				return items[0];
			};

			await commands.get('soml.goToKeyPath')();
			assert.equal(revealed, undefined);
		});

		test('current instant insertion replaces every selection with the same UTC timestamp', async () => {
			const {commands, window} = await runtime();
			const selections = [{start: 3, end: 3}, {start: 10, end: 13}];
			const edits = [];
			window.activeTextEditor = {
				document: {languageId: 'soml'}, selections, async edit(callback) {
					callback({
						replace(selection, text) {
							edits.push({selection, text});
						},
					});
					return true;
				},
			};
			const before = Date.now();
			await commands.get('soml.insertCurrentInstant')();
			assert.equal(edits.length, 2);
			assert.deepEqual(edits.map(edit => edit.selection), selections);
			assert.equal(edits[0].text, edits[1].text);
			assert.match(edits[0].text, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/v);
			assert.equal(Date.parse(edits[0].text) >= before && Date.parse(edits[0].text) <= Date.now(), true);
		});

		test('Go to Key Path discards a target changed while opening the editor', async () => {
			const {commands, window} = await runtime();
			let convertedPositions = 0;
			const document = {
				languageId: 'soml', version: 1, getText: () => 'a: 1', positionAt(offset) {
					convertedPositions++;
					return {line: 0, character: offset};
				},
			};
			let isRevealed = false;
			const editor = {
				document, revealRange() {
					isRevealed = true;
				},
			};
			window.activeTextEditor = editor;
			window.showQuickPick = async items => items[0];
			window.showTextDocument = async () => {
				document.version++;
				return editor;
			};

			await commands.get('soml.goToKeyPath')();
			assert.equal(isRevealed, false);
			assert.equal(editor.selection, undefined);
			assert.equal(convertedPositions, 0);
		});

		test('bundled temporal refactors preserve exact values without Temporal', async () => {
			const {providers} = await runtime();
			for (const [literal, title, expected] of [
				['-9223372036854775808ns', 'Normalize duration', '-2562047h47m16.854775808s'],
				['2026-01-01T01:00:00.123456789+01:00', 'Convert instant to UTC', '2026-01-01T00:00:00.123456789Z'],
			]) {
				const document = {
					uri: 'untitled:temporal', version: 1, getText: () => `a: ${literal}`, offsetAt: position => position.character, positionAt: offset => ({line: 0, character: offset}),
				};
				const position = {line: 0, character: 3};
				const actions = providers.get('CodeActions').provideCodeActions(document, {start: position, end: position}, {}, {isCancellationRequested: false});
				const action = actions.find(action => action.title === title);
				assert.equal(action.edit.text, expected);
				assert.equal(action.edit.range.start.character, 3);
				assert.equal(action.edit.range.end.character, 3 + literal.length);
				assert.equal(action.edit.uri, document.uri);
			}
		});

		async function pasteRuntime(text = 'value: ', selectedLength = 0) {
			const environment = await runtime();
			const document = {
				languageId: 'soml', version: 1, isClosed: false, getText: () => text, offsetAt: position => position,
			};
			const selection = {
				start: text.length - selectedLength, end: text.length, isEqual(other) {
					return this.start === other.start && this.end === other.end;
				},
			};
			const edits = [];
			const messages = [];
			const editor = {
				document, selection, selections: [selection], async edit(callback) {
					callback({
						replace(range, value) {
							edits.push({range, value});
						},
					});
					return true;
				},
			};
			environment.window.activeTextEditor = editor;
			environment.window.showInformationMessage = async message => {
				messages.push(message);
			};

			environment.window.showErrorMessage = async message => {
				messages.push(message);
			};

			return {
				...environment, document, editor, edits, messages, paste: environment.commands.get('soml.pasteAsString'),
			};
		}

		test('Paste as String inserts a complete escaped value and replaces a whole selection', async () => {
			for (const selectedLength of [0, 5]) {
				const environment = await pasteRuntime(selectedLength ? 'value: false' : 'value: ', selectedLength);
				environment.clipboard.readText = async () => 'C:\\path\n"😀"\t${1:literal}';
				await environment.paste();
				assert.equal(environment.edits.length, 1);
				assert.equal(environment.edits[0].range, environment.editor.selection);
				assert.equal(environment.edits[0].value, '"C:\\\\path\\n\\"😀\\"\\t${1:literal}"');
				assert.deepEqual(environment.messages, []);
			}
		});

		test('Paste as String rejects unrepresentable text and size expansion without editing', async () => {
			for (const [value, message] of [['a\r\nb', /carriage returns/v], ['\u{D800}', /surrogates/v], ['x'.repeat(1001), /maxDocumentSize/v], ['\u{0}'.repeat(200), /maxDocumentSize/v]]) {
				const environment = await pasteRuntime();
				environment.configuration.set('maxDocumentSize', 1000);
				environment.clipboard.readText = async () => value;
				await environment.paste();
				assert.deepEqual(environment.edits, []);
				assert.match(environment.messages[0], message);
			}
		});

		test('Paste as String honors resulting size after removing the selected value', async () => {
			const environment = await pasteRuntime(`value: "${'x'.repeat(990)}"`, 992);
			environment.configuration.set('maxDocumentSize', 1000);
			environment.clipboard.readText = async () => 'y'.repeat(991);
			await environment.paste();
			assert.equal(environment.edits.length, 1);
			assert.equal(environment.edits[0].value.length, 993);
			assert.deepEqual(environment.messages, []);
		});

		test('Paste as String ignores stale targets and does not read the clipboard for multiple selections', async () => {
			for (const change of [
				environment => {environment.document.version++;},
				environment => {environment.document.isClosed = true;},
				environment => {environment.window.activeTextEditor = {};},
				environment => {environment.editor.selection = {isEqual: () => false};},
				environment => {environment.editor.selections.push({});},
			]) {
				const environment = await pasteRuntime();
				environment.clipboard.readText = async () => {
					change(environment);
					return 'text';
				};

				await environment.paste();
				assert.deepEqual(environment.edits, []);
			}

			const environment = await pasteRuntime();
			environment.editor.selections.push({});
			environment.clipboard.readText = async () => assert.fail('Clipboard must not be read for multiple selections');
			await environment.paste();
			assert.deepEqual(environment.edits, []);
			assert.match(environment.messages[0], /single selection/v);
		});

		test('Paste as String reports clipboard failure without editing', async () => {
			const environment = await pasteRuntime();
			environment.clipboard.readText = async () => {
				throw new Error('Clipboard unavailable');
			};

			await environment.paste();
			assert.deepEqual(environment.edits, []);
			assert.equal(environment.messages[0], 'Could not read text from the clipboard.');
		});

		test('runtime publishes multiple diagnostics and duplicate-key related locations', async () => {
			const {listeners, timers, diagnostics} = await runtime();
			const document = {
				uri: 'untitled:diagnostics', languageId: 'soml', version: 1, isClosed: false, getText: () => 'a: 1\na: 2\nb: nope', positionAt: offset => ({line: 0, character: offset}),
			};
			listeners.get('OpenTextDocument')(document);
			timers.values().next().value();
			const results = diagnostics.get(document.uri);
			assert.equal(results.length, 2);
			assert.equal(results[0].code.value, 'duplicate-key');
			assert.equal(results[0].relatedInformation[0].location.uri, document.uri);
			assert.equal(results[0].relatedInformation[0].location.range.start.character, 0);
			assert.equal(results[1].code.value, 'invalid-value');
		});
	});
}

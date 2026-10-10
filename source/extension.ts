import * as vscode from 'vscode';
import {
	DocumentCache,
	diagnosticProblems,
	defaultMaxDocumentSize,
	formattingEdits,
	outline,
	folds,
	selectionSpans,
	hover,
	keyPathAt,
	keyPaths,
	type Span,
	type OutlineEntry,
} from './service.ts';
import {escapedString, refactors} from './refactor.ts';
import {typingIndentation} from './indentation.ts';
import {completionItems} from './completion.ts';

const selector: vscode.DocumentSelector = {language: 'soml'};

function range(document: vscode.TextDocument, span: Span): vscode.Range {
	return new vscode.Range(document.positionAt(span[0]), document.positionAt(span[1]));
}

function maxSize(document: vscode.TextDocument): number {
	return vscode.workspace.getConfiguration('soml', document).get<number>('maxDocumentSize', defaultMaxDocumentSize);
}

/* eslint-disable @typescript-eslint/naming-convention -- Keys match the parser node types. */
const symbolKinds = {
	Unknown: vscode.SymbolKind.Variable,
	Object: vscode.SymbolKind.Object,
	Array: vscode.SymbolKind.Array,
	String: vscode.SymbolKind.String,
	Integer: vscode.SymbolKind.Number,
	Float: vscode.SymbolKind.Number,
	Boolean: vscode.SymbolKind.Boolean,
	Null: vscode.SymbolKind.Null,
	Instant: vscode.SymbolKind.Constant,
	Duration: vscode.SymbolKind.Constant,
};
/* eslint-enable @typescript-eslint/naming-convention */

function symbols(document: vscode.TextDocument, entries: OutlineEntry[]): vscode.DocumentSymbol[] {
	return entries.map(entry => {
		const symbol = new vscode.DocumentSymbol(entry.name, entry.type, symbolKinds[entry.type], range(document, entry.range), range(document, entry.selection));
		symbol.children = symbols(document, entry.children);
		return symbol;
	});
}

export function activate(context: vscode.ExtensionContext): void {
	const cache = new DocumentCache();
	const diagnostics = vscode.languages.createDiagnosticCollection('soml');
	const pending = new Map<vscode.TextDocument, ReturnType<typeof setTimeout>>();

	function cancel(document: vscode.TextDocument): void {
		clearTimeout(pending.get(document));
		pending.delete(document);
	}

	function validate(document: vscode.TextDocument): void {
		cancel(document);
		if (document.isClosed || document.languageId !== 'soml') {
			return;
		}

		if (!vscode.workspace.getConfiguration('soml', document).get('validation.enabled', true)) {
			diagnostics.delete(document.uri);
			return;
		}

		const problems = diagnosticProblems(cache.get(document, maxSize(document)));
		if (problems.length === 0) {
			diagnostics.delete(document.uri);
			return;
		}

		diagnostics.set(document.uri, problems.map(problem => {
			const diagnostic = new vscode.Diagnostic(range(document, problem.range), problem.message, problem.limited ? vscode.DiagnosticSeverity.Information : vscode.DiagnosticSeverity.Error);
			diagnostic.source = 'SOML';
			diagnostic.code = {
				value: problem.limited ? 'document-size-limit' : problem.code ?? 'invalid-soml',
				target: vscode.Uri.parse(problem.limited ? 'https://github.com/soml-lang/vscode-soml#settings' : 'https://github.com/soml-lang/soml/blob/main/spec.md'),
			};
			diagnostic.relatedInformation = problem.related?.map(related => new vscode.DiagnosticRelatedInformation(new vscode.Location(document.uri, range(document, related.range)), related.message));
			return diagnostic;
		}));
	}

	function schedule(document: vscode.TextDocument): void {
		cancel(document);
		if (document.languageId === 'soml') {
			pending.set(document, setTimeout(() => {
				validate(document);
			}, 200));
		}
	}

	context.subscriptions.push(
		diagnostics,
		{
			dispose() {
				for (const document of pending.keys()) {
					cancel(document);
				}
			},
		},
		vscode.workspace.onDidOpenTextDocument(schedule),
		vscode.workspace.onDidChangeTextDocument(event => {
			schedule(event.document);
		}),
		vscode.workspace.onDidCloseTextDocument(document => {
			cancel(document);
			cache.delete(document);
			diagnostics.delete(document.uri);
		}),
		vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('soml')) {
				for (const document of vscode.workspace.textDocuments) {
					schedule(document);
				}
			}
		}),
		vscode.languages.registerOnTypeFormattingEditProvider(selector, {
			async provideOnTypeFormattingEdits(document, position, character, options, token) {
				const editor = vscode.window.activeTextEditor;
				if (token.isCancellationRequested || editor?.document !== document) {
					return [];
				}

				const snapshot = cache.getEditor(document, maxSize(document));
				const unit = options.insertSpaces ? ' '.repeat(options.tabSize) : '\t';
				const edits = snapshot ? typingIndentation(snapshot, document.offsetAt(position), character, unit) : [];
				if (edits.length > 0) {
					// Returning provider edits makes VS Code add a separate undo step; apply directly to keep typing and formatting together.
					await editor.edit(builder => {
						for (const edit of edits) {
							builder.replace(range(document, edit.range), edit.text);
						}
					}, {undoStopBefore: false, undoStopAfter: true});
				}

				return [];
			},
		}, '\n', '}', ']'),
		vscode.languages.registerDocumentFormattingEditProvider(selector, {
			provideDocumentFormattingEdits(document, _options, token) {
				return token.isCancellationRequested ? [] : formattingEdits(document.getText(), maxSize(document)).map(edit => vscode.TextEdit.replace(range(document, edit.range), edit.text));
			},
		}),
		vscode.languages.registerDocumentSymbolProvider(selector, {
			provideDocumentSymbols(document, token) {
				if (token.isCancellationRequested) {
					return [];
				}

				const {tree, recovered} = cache.get(document, maxSize(document));
				const structure = tree ?? recovered?.root;
				return structure ? symbols(document, outline(structure)) : [];
			},
		}),
		vscode.languages.registerFoldingRangeProvider(selector, {
			provideFoldingRanges(document, _foldingContext, token) {
				if (token.isCancellationRequested) {
					return [];
				}

				const {tree, recovered, text} = cache.get(document, maxSize(document));
				const structure = tree ?? recovered;
				return structure ? folds(structure, text).map(fold => new vscode.FoldingRange(fold.start, fold.end, fold.comment ? vscode.FoldingRangeKind.Comment : undefined)) : [];
			},
		}),
		vscode.languages.registerSelectionRangeProvider(selector, {
			provideSelectionRanges(document, positions, token) {
				if (token.isCancellationRequested) {
					return [];
				}

				const {tree, recovered} = cache.get(document, maxSize(document));
				const structure = tree ?? recovered;
				return positions.map(position => {
					const spans = structure ? selectionSpans(structure, document.offsetAt(position)) : [];
					let parent: vscode.SelectionRange | undefined;
					for (const span of spans.toReversed()) {
						parent = new vscode.SelectionRange(range(document, span), parent);
					}

					return parent ?? new vscode.SelectionRange(new vscode.Range(position, position));
				});
			},
		}),
		vscode.languages.registerHoverProvider(selector, {
			provideHover(document, position, token) {
				if (token.isCancellationRequested) {
					return undefined;
				}

				const {tree, text} = cache.get(document, maxSize(document));
				const result = tree ? hover(tree, text, document.offsetAt(position)) : undefined;
				if (!result) {
					return undefined;
				}

				const markdown = new vscode.MarkdownString();
				markdown.appendText(result.text);
				return new vscode.Hover(markdown, range(document, result.range));
			},
		}),
		vscode.languages.registerCompletionItemProvider(selector, {
			provideCompletionItems(document, position, token) {
				if (token.isCancellationRequested) {
					return [];
				}

				const snapshot = cache.getEditor(document, maxSize(document));
				if (!snapshot) {
					return [];
				}

				return completionItems(snapshot, document.offsetAt(position)).map(completion => {
					const item = new vscode.CompletionItem(completion.label, completion.snippet ? vscode.CompletionItemKind.Snippet : vscode.CompletionItemKind.Keyword);
					item.insertText = completion.snippet ? new vscode.SnippetString(completion.insertText) : completion.insertText;
					item.detail = completion.detail;
					item.range = range(document, completion.range);
					return item;
				});
			},
		}, ':', '[', ',', ' '),
		vscode.languages.registerCodeActionsProvider(selector, {
			provideCodeActions(document, selection, actionContext, token) {
				if (token.isCancellationRequested || (actionContext.only && !actionContext.only.contains(vscode.CodeActionKind.RefactorRewrite))) {
					return [];
				}

				const {tree, text} = cache.get(document, maxSize(document));
				return tree
					? refactors(tree, text, [document.offsetAt(selection.start), document.offsetAt(selection.end)]).map(refactor => {
						const action = new vscode.CodeAction(refactor.title, vscode.CodeActionKind.RefactorRewrite);
						action.edit = new vscode.WorkspaceEdit();
						for (const edit of refactor.edits) {
							action.edit.replace(document.uri, range(document, edit.range), edit.text);
						}

						return action;
					})
					: [];
			},
		}, {providedCodeActionKinds: [vscode.CodeActionKind.RefactorRewrite]}),
		vscode.commands.registerCommand('soml.pasteAsString', async () => {
			const editor = vscode.window.activeTextEditor;
			if (editor?.document.languageId !== 'soml') {
				return;
			}

			if (editor.selections.length !== 1) {
				await vscode.window.showInformationMessage('Paste as String requires a single selection.');
				return;
			}

			const {document, selection} = editor;
			const {version} = document;
			let text: string;
			try {
				text = await vscode.env.clipboard.readText();
			} catch {
				await vscode.window.showErrorMessage('Could not read text from the clipboard.');
				return;
			}

			if (document.isClosed || document.version !== version || vscode.window.activeTextEditor !== editor || editor.selections.length !== 1 || !editor.selection.isEqual(selection)) {
				return;
			}

			const limit = maxSize(document);
			if (text.length > limit || document.getText().length > limit) {
				await vscode.window.showInformationMessage('Paste as String exceeds soml.maxDocumentSize.');
				return;
			}

			let replacement: string;
			try {
				replacement = escapedString(text);
			} catch {
				await vscode.window.showErrorMessage('SOML strings cannot contain carriage returns or unpaired Unicode surrogates.');
				return;
			}

			const selectedLength = document.offsetAt(selection.end) - document.offsetAt(selection.start);
			if (document.getText().length - selectedLength + replacement.length > limit) {
				await vscode.window.showInformationMessage('Paste as String exceeds soml.maxDocumentSize.');
				return;
			}

			await editor.edit(edit => {
				edit.replace(selection, replacement);
			});
		}),
		vscode.commands.registerCommand('soml.insertCurrentInstant', async () => {
			const editor = vscode.window.activeTextEditor;
			if (editor?.document.languageId !== 'soml') {
				return;
			}

			const instant = new Date().toISOString();
			await editor.edit(edit => {
				for (const selection of editor.selections) {
					edit.replace(selection, instant);
				}
			});
		}),
		vscode.commands.registerCommand('soml.goToKeyPath', async () => {
			const editor = vscode.window.activeTextEditor;
			if (editor?.document.languageId !== 'soml') {
				return;
			}

			const {document} = editor;
			const {tree} = cache.get(document, maxSize(document));
			if (!tree) {
				await vscode.window.showInformationMessage('Go to Key Path requires a valid SOML document within the size limit.');
				return;
			}

			const {version} = document;
			const selected = await vscode.window.showQuickPick(keyPaths(tree).map(entry => ({label: entry.path, description: entry.type, span: entry.range})), {title: 'SOML: Go to Key Path', placeHolder: 'Search a full key path'});
			if (!selected || document.isClosed || document.version !== version) {
				return;
			}

			const targetEditor = await vscode.window.showTextDocument(document);
			if (document.version !== version) {
				return;
			}

			const target = range(document, selected.span);
			targetEditor.selection = new vscode.Selection(target.start, target.end);
			targetEditor.revealRange(target, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
		}),
		vscode.commands.registerCommand('soml.copyKeyPath', async () => {
			const editor = vscode.window.activeTextEditor;
			if (editor?.document.languageId !== 'soml') {
				return;
			}

			const {tree} = cache.get(editor.document, maxSize(editor.document));
			const path = tree ? keyPathAt(tree, editor.document.offsetAt(editor.selection.active)) : undefined;
			if (path === undefined) {
				await vscode.window.showInformationMessage('Place the cursor on a key or value in a valid SOML document to copy its path.');
				return;
			}

			await vscode.env.clipboard.writeText(path);
		}),
	);

	for (const document of vscode.workspace.textDocuments) {
		schedule(document);
	}
}

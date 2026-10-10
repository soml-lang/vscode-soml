# SOML for Visual Studio Code

[SOML](https://soml.sh) language support for VS Code, including VS Code for the Web.

> [!NOTE]
> SOML is a draft format.

## Features

- Syntax highlighting for `.soml` files and SOML fences in Markdown.
- Live diagnostics for syntax and value errors, with duplicate-key links to the original declaration and links to language rules.
- Format Document and format-on-save with minimal edits, preserving comments, member order, value spelling, and block-string content.
- Hierarchical Outline and breadcrumbs, including objects inside arrays.
- Folding for objects, arrays, block strings, and comments.
- Expand Selection through values, members, and enclosing collections.
- Hovers show exact int64 values, 64-bit floats, readable durations, and instants in local time followed by exact UTC with nanosecond precision.
- **SOML: Copy Key Path** copies the active cursor's path, such as `servers[0].host` or `'example.com'.port`.
- **SOML: Insert Current UTC Instant** inserts a timestamp at every cursor, replacing selections.
- **SOML: Paste as String** inserts clipboard text as a complete escaped string at one selection.
- **SOML: Go to Key Path** searches full paths and jumps to keys or array items.
- Refactor actions to expand/compact collections, convert single-line string quotes, remove unnecessary key quotes, and convert nonnegative integers between decimal, hexadecimal, octal, and binary.
- Value-preserving refactors for block strings, duration normalization, UTC conversion, and decimal digit grouping.
- Contextual value completion and missing-key suggestions from sibling objects, including in incomplete documents.
- Syntax-aware indentation for member values and collections, preserving block-string content.
- Comment toggling, bracket matching, quote pairing, and snippets for objects, arrays, block strings, durations, and instants.

The parser is bundled, with no external executable, workspace code execution, telemetry, or network access. Remote, virtual, and untrusted workspaces are supported.

## Install

Install it from [the marketplace](https://marketplace.visualstudio.com/items?itemName=sindresorhus.soml).

## Formatting

Use **Format Document**, or enable format on save:

```json
{
	"[soml]": {
		"editor.defaultFormatter": "sindresorhus.soml",
		"editor.formatOnSave": true
	}
}
```

SOML defines the layout: tabs, LF, and one entry per line in multiline collections; compact collections stay on one line. Formatting ignores editor indentation preferences and leaves invalid documents unchanged. Convert CRLF to LF using the status bar's line ending selector.

> [!IMPORTANT]
> Block-string trailing spaces can be significant, so generic trailing-whitespace trimming is disabled by default. Use Format Document to remove unnecessary whitespace safely.

## Editing

Double-click selects an entire bare key, including dashes.

Use **Refactor…** at a value or key. Actions preserve decoded values and target the innermost selected value. Expansion preserves comments; compaction requires no comments or block strings. Radix conversion supports nonnegative integers only.

Pressing Enter between comma-separated entries expands and formats the containing array or object using SOML’s tab indentation. In incomplete collections, it removes the comma and adjusts indentation. Ordinary typing indentation respects the editor’s tabs/spaces setting. Disable `[soml].editor.formatOnType` to keep native typing behavior.

Value suggestions appear after `:`, `[`, and commas, or through **Trigger Suggest**, outside strings and comments. Sibling-key suggestions never copy other objects’ values and preserve existing values. Malformed context can suppress suggestions.

**Normalize duration** converts `90m` to `1h30m` and `1500ms` to `1.5s`. **Convert instant to UTC** changes the offset to `Z`, preserving every fractional digit.

**Group decimal digits** turns `9007199254740993` into `9_007_199_254_740_993`; **Remove decimal digit grouping** reverses it. Both apply only to decimal integers and preserve the exact value.

Run **SOML: Paste as String** at an empty value position, or select a whole value including its quotes. It inserts an escaped, double-quoted string and supports one selection, even in incomplete documents. It does not detect insertion inside existing strings. Carriage returns and unpaired Unicode surrogates are rejected. The clipboard text and document before and after insertion must fit `soml.maxDocumentSize`.

## Settings

| Setting | Default | Description |
|---|---|---|
| `soml.validation.enabled` | `true` | Report errors as you type. |
| `soml.maxDocumentSize` | `1000000` | Maximum UTF-16 code units for validation, formatting, and structural features. Configurable from 1,000 to 10,000,000. |

Diagnostics update after a short typing pause. Oversized files retain highlighting and receive a size-limit notice. Outline, folding, and Go to Key Path return at most 5,000 entries.

## Boundaries

- Diagnostics report up to 100 errors before deduplication. Recovery is conservative and may not find every error.
- Highlighting is lexical and may color invalid text. Problems is the authoritative validation result.
- Validation checks decoded text, not file encoding or a UTF-8 BOM. Save as UTF-8 without BOM for conforming files.
- Markdown fences receive highlighting only; detection inside raw HTML such as `<pre>` is best-effort.
- Schemas, cross-file references, JSON/TOML conversion, and range formatting are not provided.

Incomplete documents retain best-effort completion, Outline, folding, and selection expansion. Missing or invalid values appear as `Unknown`. Formatting, value hovers, refactors, and key-path commands require a valid document.

## Development

Requires Node.js 26.9 or later:

```sh
npm ci
npm test
npm run test:integration
npm run test:integration:web
npm run package
```

Run `npm run benchmark` for sampled performance measurements with `node:bench`, including warmup runs.

For local parser development, run `npm run build` in `../soml-javascript`, then `npm link ../soml-javascript --no-save --package-lock=false` here. Rebuild the parser after changing its source.

`npm test` runs XO, checks TypeScript, builds, and tests the language service, TextMate tokenizer, and runtime bundle using `node:test`. Run `npm run lint` to lint separately, or `npx xo --fix` to apply automatic fixes. Press F5 to launch an Extension Development Host.

Run `npm run test:conformance` for optional specification conformance checks. The command automatically downloads the latest fixtures using Git and removes the temporary checkout when finished. Set `SOML_CONFORMANCE` to use an existing local conformance directory instead. The suite checks decoded documents, formatting idempotence, highlighting, and structural ranges. Invalid byte encodings are excluded.

`test:integration` downloads VS Code 1.105.0 by default and runs isolated extension-host tests. `test:integration:web` runs browser-safe tests in its web worker extension host. Set `VSCODE_EXECUTABLE_PATH` to use an existing executable, or `VSCODE_VERSION` to test another release. User data and extensions stay under `.ai-temporary`. Linux CI uses `xvfb-run`.

Desktop uses native ESM; the web extension host still requires a CJS bundle. Both are built from the same source, with no Node.js runtime imports. Runtime tests exercise both formats without Temporal.

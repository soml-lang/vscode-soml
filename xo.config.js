export default [
	{
		ignores: [
			'.vscode-test/**',
			'distribution/**',
			'syntaxes/**',
		],
	},
	{
		rules: {
			// VS Code snippets deliberately contain ${...}, and syntax nodes are not DOM nodes.
			'no-template-curly-in-string': 'off',
			'unicorn/better-dom-traversing': 'off',
			// Traversal loops are clearer inline than split solely to avoid continue.
			'unicorn/no-break-in-nested-loop': 'off',
			'@typescript-eslint/switch-exhaustiveness-check': [
				'error',
				{considerDefaultExhaustiveForUnions: true},
			],
		},
	},
	{
		files: [
			'test/**',
			'scripts/conformance.js',
		],
		rules: {
			// Fixture loops and shared assertion helpers are intentional.
			'node-test/no-conditional-assertion': 'off',
			'node-test/no-compound-assertion': 'off',
			'node-test/require-assertion': 'off',
			'node-test/no-import-test-files': 'off',
			'node-test/no-useless-assertion': 'off',
			'unicorn/max-nested-calls': 'off',
		},
	},
	{
		files: [
			'test/integration.js',
			'test/web-integration.js',
			'test/runtime.test.js',
			'scripts/conformance.js',
		],
		rules: {
			// Editor actions and fixture processing must run in sequence.
			'no-await-in-loop': 'off',
		},
	},
	{
		files: [
			'test/integration.js',
			'test/web-integration.js',
		],
		rules: {
			// TextEditorEdit.replace is not String.replace.
			'unicorn/no-unsafe-string-replacement': 'off',
		},
	},
	{
		files: [
			'source/refactor.ts',
		],
		rules: {
			// String escaping must identify forbidden control characters.
			'no-control-regex': 'off',
			'regexp/no-control-character': 'off',
		},
	},
	{
		files: [
			'package.json',
		],
		rules: {
			// This is a VS Code extension: entry points, engines, and packaging use its manifest contract.
			'package-json/prefer-files-field': 'off',
			'package-json/prefer-exports': 'off',
			'package-json/require-engines': 'off',
			'package-json/prefer-engines-range': 'off',
			'package-json/no-orphan-types': 'off',
			// Pin the parser and minimum-host API types for reproducible extension behavior.
			'package-json/dependency-version-range': 'off',
		},
	},
];

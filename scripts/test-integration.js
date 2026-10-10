import process from 'node:process';
import path from 'node:path';
import fs from 'node:fs/promises';
import {build} from 'esbuild';
import {runTests} from '@vscode/test-electron';

await fs.mkdir('.ai-temporary', {recursive: true});
const runDirectory = await fs.mkdtemp(path.resolve('.ai-temporary/vscode-'));
const isWeb = process.argv.includes('--web');
const testsPath = path.join(runDirectory, isWeb ? 'integration.cjs' : 'integration.mjs');
await build({
	entryPoints: [isWeb ? 'test/web-integration.js' : 'test/integration.js'],
	outfile: testsPath,
	bundle: true,
	platform: isWeb ? 'browser' : 'node',
	format: isWeb ? 'cjs' : 'esm',
	external: ['vscode'],
});
await runTests({
	vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH,
	version: process.env.VSCODE_VERSION ?? '1.105.0',
	extensionDevelopmentPath: path.resolve('.'),
	extensionTestsPath: testsPath,
	launchArgs: [
		...(isWeb ? ['--extensionDevelopmentKind=web'] : []),
		'--disable-extensions',
		'--skip-welcome',
		'--skip-release-notes',
		'--user-data-dir',
		path.join(runDirectory, 'user'),
		'--extensions-dir',
		path.join(runDirectory, 'extensions'),
	],
});

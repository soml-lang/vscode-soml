import {writeFile} from 'node:fs/promises';
import {build} from 'esbuild';

const options = {
	entryPoints: ['source/extension.ts'],
	bundle: true,
	platform: 'browser',
	target: 'es2024',
	external: ['vscode'],
	legalComments: 'eof',
	minify: true,
	sourcemap: true,
	metafile: true,
};

const results = await Promise.all([
	build({...options, outfile: 'distribution/extension.js', format: 'esm'}),
	build({...options, outfile: 'distribution/extension.cjs', format: 'cjs'}),
]);
const metafile = {inputs: {}, outputs: {}};
for (const result of results) {
	Object.assign(metafile.inputs, result.metafile.inputs);
	Object.assign(metafile.outputs, result.metafile.outputs);
}

await writeFile('distribution/metafile.json', JSON.stringify(metafile, undefined, '\t'));


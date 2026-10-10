import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';

const execute = promisify(execFile);

test('conformance downloads fixtures automatically and honors an explicit local directory', async () => {
	await using temporary = await fs.mkdtempDisposable(path.join(tmpdir(), 'soml-conformance-test-'));
	const repository = path.join(temporary.path, 'repository');
	const fixtures = path.join(repository, 'conformance');
	await fs.mkdir(path.join(fixtures, 'valid'), {recursive: true});
	await fs.mkdir(path.join(fixtures, 'invalid'));
	await Promise.all(Array.from({length: 101}, async (_, index) => {
		await fs.writeFile(path.join(fixtures, 'valid', `${index}.soml`), 'a: true\n');
		await fs.writeFile(path.join(fixtures, 'invalid', `${index}.soml`), 'a: nope\n');
	}));
	await execute('git', ['init', repository]);
	await execute('git', ['-C', repository, 'add', '.']);
	await execute('git', ['-C', repository, '-c', 'user.name=Conformance test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgSign=false', 'commit', '-m', 'Fixtures']);
	const environment = {
		...process.env,
		GIT_CONFIG_COUNT: '1',
		GIT_CONFIG_KEY_0: `url.${pathToFileURL(repository).href}.insteadOf`,
		GIT_CONFIG_VALUE_0: 'https://github.com/soml-lang/soml.git',
	};
	delete environment.SOML_CONFORMANCE;
	const downloaded = await execute(process.execPath, ['scripts/conformance.js'], {env: environment});
	assert.match(downloaded.stdout, /Conformance passed: 101 valid documents, 101 invalid documents,/v);
	const local = await execute(process.execPath, ['scripts/conformance.js'], {
		env: {...environment, SOML_CONFORMANCE: fixtures, GIT_CONFIG_KEY_0: `url.${pathToFileURL(path.join(temporary.path, 'missing')).href}.insteadOf`},
	});
	assert.match(local.stdout, /Conformance passed: 101 valid documents, 101 invalid documents,/v);
});

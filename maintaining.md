# Maintaining

## Development

1. Run `npm ci` and open this folder in VS Code.
2. Press **F5** to build and launch an Extension Development Host. Open a `.soml` file there to test.
3. After changing the code, stop debugging and press **F5** again to rebuild and relaunch. No VSIX packaging or installation is needed.

## Publishing

Requires Node.js 26.9+ and conformance fixtures at `../soml/conformance` (or `SOML_CONFORMANCE`).

1. Update the README’s VSIX filename, then run these commands with the release version:

	```sh
	npm ci
	npm version '<version>' --no-git-tag-version
	npm test
	npm run test:conformance
	npm run test:integration
	npm run package
	```

2. Install `soml-<version>.vsix` using **Extensions: Install from VSIX…** and smoke-test it.
3. Upload the VSIX under `sindresorhus` on the [Marketplace publisher page](https://marketplace.visualstudio.com/manage).
4. Commit and tag the release, and attach the VSIX to a GitHub release.

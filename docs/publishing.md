# Publishing to npm

Proof & Replay is configured for the public npm registry only:

```text
https://registry.npmjs.org/
```

The package name is `proof-and-replay`, public access is declared in `package.json`, and provenance is enabled. A GitHub personal access token can push source code and tags to GitHub, but it cannot authenticate a publish to npmjs.com.

## First release

The first release establishes ownership of the npm package name. Sign in to the npm account that should own the package, enable two-factor authentication, and run these checks from a clean clone:

```bash
npm ci --ignore-scripts
npm run check
npm pack --dry-run
npm publish --access public
```

Do not commit an npm token or add one to `.npmrc`.

## Trusted publishing from GitHub

After the first package version exists on npmjs.com, configure its trusted publisher in the npm package settings:

- Provider: GitHub Actions
- Organization or user: `kundanray1`
- Repository: `proof-and-replay`
- Workflow filename: `publish.yml`
- Allowed action: `npm publish`

The checked-in `publish.yml` workflow uses GitHub-hosted runners and OpenID Connect. It requests `id-token: write`, publishes to `https://registry.npmjs.org`, and produces npm provenance without storing a long-lived npm publishing token in GitHub.

For later releases:

1. Update the version in `package.json` and `package-lock.json`.
2. Move changelog entries from `Unreleased` into the new version.
3. Merge the release commit into `main`.
4. Create and publish a matching GitHub release such as `v0.2.0`.
5. Confirm the `Publish to npm` workflow completed and inspect the provenance link on npmjs.com.

The version is immutable after publication. Never reuse or overwrite an existing npm version.

Reference: [npm trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/).

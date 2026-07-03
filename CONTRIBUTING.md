# Contributing

Thanks for helping improve `mcp-api-translator`.

## Local development

```bash
npm install
npm run build       # tsup → dist/
npm test            # unit + integration
npm run typecheck
npm run e2e         # generate a sample project, then compile it
npm run format      # prettier write
```

CI runs `format:check`, `check:docs`, `typecheck`, `test`, `build`, `e2e`,
`e2e:python`, and `smoke:serve`, and it compiles the generated projects — the
same commands you can run locally. A separate DCO check runs on pull requests.

## Pull requests

- Keep PRs focused. One logical change per PR.
- Add tests for behaviour changes. Snapshot tests live under `test/`.
- Update `docs/usage-workflow.md` if you change the end-to-end journey; the
  `check:docs` CI job asserts that documented tool names still exist.
- Follow the existing code style (Prettier config is in `.prettierrc.json`).

## Contributor License Agreement (CLA)

This project is **dual-licensed** — AGPL-3.0 **and** a separate commercial license
(see [LICENSING.md](LICENSING.md)). For the maintainer to be able to offer your
work under **both** licenses, contributions must be made under the
[Contributor License Agreement](CLA.md). Please state in your first pull request
that you have read and agree to the CLA.

## Developer Certificate of Origin (DCO)

In addition to the CLA, all commits must be signed off under the
[Developer Certificate of Origin 1.1](https://developercertificate.org/) — a
lightweight, per-commit statement certifying you have the right to submit the
contribution.

Add a `Signed-off-by` trailer to every commit:

```bash
git commit -s -m "your message"
```

CI rejects unsigned commits. If you forget, amend or rebase with:

```bash
git commit --amend -s --no-edit
# or, for multiple commits:
git rebase --signoff HEAD~<N>
```

## Releasing

Releases are automated by [`.github/workflows/release.yml`](.github/workflows/release.yml),
triggered by pushing a semver tag. Publishing to npm uses **OIDC trusted
publishing** — there is no `NPM_TOKEN` secret.

**One-time bootstrap (first publish of a new package name only).** npm won't let
you configure a trusted publisher until the package already exists, so the very
first version must be published manually by a maintainer signed in to npm
(`npm login`):

```bash
npm run build
# --no-provenance: provenance requires the OIDC CI environment, so a local bootstrap
# publish can't generate it. CI releases (below) attach provenance automatically.
npm publish --access public --no-provenance
```

If npm still rejects the publish with a provenance error (`publishConfig.provenance` in
`package.json` can take precedence over the CLI flag), temporarily set that field to `false` for
the bootstrap publish and restore it before committing.

Then, on npmjs.com, open the package → **Settings → Trusted Publisher** and add:

- **Organization or user:** `krishgok`
- **Repository:** `mcp-api-translator`
- **Workflow filename:** `release.yml`
- **Environment:** (leave blank)

**Every release after that is token-free:**

```bash
npm version <patch|minor|major>   # bumps package.json and creates a vX.Y.Z tag
git push --follow-tags            # triggers release.yml
```

Pre-release tags (e.g. `v1.2.0-rc.1`) publish under the npm `next` dist-tag, so
`npm install mcp-api-translator` keeps resolving to the last stable release. The
workflow also pushes a multi-arch Docker image to GHCR, generates an SBOM, and
creates a GitHub Release.

Notes:

- Trusted publishing requires the runner to use Node ≥ 22.14 and npm ≥ 11.5.1
  (handled in the workflow).
- **Provenance requires a _public_ source repository.** It is enabled via
  `publishConfig.provenance` in `package.json`. If the repository is private the
  publish will fail — either make the repo public or set that field to `false`.

## Reporting bugs

Open an issue with a minimal reproducer: the spec (or a redacted excerpt), the
exact command / tool call you made, and the observed vs. expected output. If
the bug is security-sensitive, follow [SECURITY.md](SECURITY.md) instead.

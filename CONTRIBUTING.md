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

CI runs `format:check`, `check:docs`, `typecheck`, `test`, `build`, and `e2e`
against every push and PR — the same commands you can run locally.

## Pull requests

- Keep PRs focused. One logical change per PR.
- Add tests for behaviour changes. Snapshot tests live under `test/`.
- Update `docs/usage-workflow.md` if you change the end-to-end journey; the
  `check:docs` CI job asserts that documented tool names still exist.
- Follow the existing code style (Prettier config is in `.prettierrc.json`).

## Developer Certificate of Origin (DCO)

To keep the provenance of the codebase clean, all commits must be signed off
under the [Developer Certificate of Origin 1.1](https://developercertificate.org/).
This is a lightweight, per-commit statement — not a Contributor License
Agreement — that certifies you have the right to submit the contribution.

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

## Reporting bugs

Open an issue with a minimal reproducer: the spec (or a redacted excerpt), the
exact command / tool call you made, and the observed vs. expected output. If
the bug is security-sensitive, follow [SECURITY.md](SECURITY.md) instead.

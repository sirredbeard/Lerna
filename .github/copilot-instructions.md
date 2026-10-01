# Copilot instructions for Lerna

Read `README.md` before changing behavior. It is the user-facing reference for installation, Copilot CLI integration, HydraFusion routing, configuration, supported platforms, and troubleshooting. Do not copy the README into this file or rewrite it here.

## Project goals

- Keep Lerna a small, reliable GitHub Copilot CLI plugin.
- Preserve verbose HydraFusion reporting independently from optional model routing.
- Keep routing limited to model IDs HydraFusion already accepts.
- Ship self-contained native binaries for the platforms listed in `README.md`.
- Treat plugin version, native binary version, release assets, checksums, and marketplace metadata as one versioned release.

## Repository map

- `integration/` contains the Copilot CLI plugin manifest, extension, installer, bridge, setup, and reporting code.
- `src/Lerna/` contains the native .NET AOT helper and its JSON-lines bridge.
- `tests/` contains Node tests for integration and installer behavior.
- `.github/workflows/build.yml` builds native binaries and publishes the release consumed by the installer.
- `.github/workflows/copilot-cli-sync.yml` checks Copilot CLI compatibility and opens review work when model support changes.

## Coding standards

- Make focused changes. Preserve existing behavior unless the issue explicitly requires a behavior change.
- Follow the surrounding JavaScript, C#, YAML, and JSON conventions. Use existing helpers rather than duplicating protocol or release logic.
- Keep errors explicit. Do not swallow failures, return success-shaped fallbacks, or add broad catches that hide corrupted downloads, invalid manifests, failed handshakes, or release problems.
- Validate downloaded binaries with the published `SHA256SUMS` before reuse or installation. Handle stale-cache replacement on Linux, macOS, and Windows.
- Do not hard-code a Copilot CLI version as a proxy for compatibility. Prefer the actual SDK handshake or capability result, and report a mismatch only when it causes a real failure.
- Keep cloud-provider routing optional. Verbose reporting and native plugin operation must remain usable without routing configuration.
- Do not put credentials, tokens, deployment secrets, or machine-specific paths in source, tests, logs, fixtures, or documentation.
- Update directly related tests and documentation. Do not make unrelated cleanup changes.

## Validation

Run the smallest relevant checks, normally:

```text
node --test tests/*.test.mjs
dotnet build src/Lerna -c Release --no-restore -p:TreatWarningsAsErrors=true
git diff --check
```

For workflow changes, run `actionlint` when available. For installer changes, include tests for checksum changes, corrupted caches, failed downloads, and Windows asset paths.

## Pull requests and commits

- Explain the root cause, the user-visible effect, and the validation performed.
- Address every review finding or explain why a finding does not apply. Do not leave known correctness issues unresolved.
- Do not add a co-author trailer or co-author attribution to commits.
- Keep release notes accurate and product-neutral. Do not add unrelated provider or marketing language.

# Release Process

The project uses GitHub Actions to verify changes, package desktop bundles, and
publish GitHub Releases on version tags.

## Trigger

Push a tag matching `vX.Y.Z`:

```bash
git tag v0.1.0
git push origin v0.1.0
```

GitHub Actions runs:

1. `frontend-build`: runs the TypeScript and Vite build.
2. `rust-tests`: runs the Rust test suite.
3. `create-release`: creates or updates a draft GitHub Release.
4. `package-release`: builds macOS, Windows, and Linux bundles and uploads them
   to the draft Release.
5. `publish-release`: publishes the Release after all required package jobs
   complete.

## Default Artifacts

The release workflow uploads Tauri bundles directly to the GitHub Release and
also stores matching workflow artifacts for debugging failed or partial runs.

Release asset names follow this pattern:

```text
orbit-browser-<tag>-<platform>-<arch><setup><ext>
```

The exact bundle types are produced by Tauri on each runner and commonly
include:

- macOS: `.dmg` and `.app` outputs.
- Windows: `.msi` and `.exe` outputs.
- Linux: AppImage, deb, or rpm outputs.

Experimental matrix entries are allowed to fail without blocking the final
Release publication. Required matrix entries must pass before the draft Release
is published.

## Pre-Release Checklist

Before releasing:

- Versions in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` match.
- `CHANGELOG.md` is updated.
- `pnpm build` and `pnpm test:rust` pass locally or in CI.
- Profiles, cookies, screenshots, databases, proxy credentials, and run artifacts are not committed.

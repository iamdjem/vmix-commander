---
description: Bump app version, update all version references, commit changes with a detailed message, push to remote, build the Electron app DMG, and open the dist folder.
user-invocable: true
---

# /build — Version Bump, Commit & Build

Increment the app version, commit all changes with a detailed description, push to remote, build the DMG, and open the dist folder.

## Arguments

- No argument or `patch`: bump patch version (e.g., 0.2.0 → 0.2.1)
- `minor`: bump minor version (e.g., 0.2.1 → 0.3.0)
- `major`: bump major version (e.g., 0.3.0 → 1.0.0)

## Steps

1. Read the current version from `package.json` (`"version"` field).
2. Parse it as semver (MAJOR.MINOR.PATCH). Determine the bump type from the argument (default: patch).
3. Compute the new version string.
4. Update the version in **all** of these locations:
   - `package.json` — the `"version"` field
   - `renderer/index.html` — all occurrences of the old `vX.Y.Z` version string (use replace_all)
5. Run `git diff --stat` and `git log --oneline -5` to understand what changed since last commit.
6. Stage all changed files with `git add` (list specific files — do NOT use `git add -A`). Never stage files in `dist/`, `node_modules/`, or `.env`.
7. Create a commit with a detailed message that:
   - Starts with a concise summary line (e.g., "v0.4.1 — Add conference switcher, recording timer, connection health")
   - Includes a bullet list of all features/changes since the last commit
   - Ends with the Co-Authored-By trailer
8. Push to the remote with `git push`.
9. Run `npm run build` to produce the DMG.
10. Run `open dist/` to open the output folder in Finder.
11. Report the old version, new version, commit hash, and DMG filename to the user.

## Important

- The DMG filename includes the version (e.g., `vMix Commander-0.4.0-arm64.dmg`).
- If the build fails, report the error and do not open the dist folder.
- If the push fails (e.g., no remote, auth issue), warn the user but continue with the build.
- Always write a descriptive commit message — this is the project's changelog.
- Never stage `dist/` directory contents.

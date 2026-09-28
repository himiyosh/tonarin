# Release notes

Each release has its notes here, written by hand: `vX.Y.Z.md` in English and `vX.Y.Z.ja.md` in Japanese. The
release workflow puts them on [GitHub Releases](https://github.com/himiyosh/tonarin/releases) (the Japanese notes
folded under the English ones) and the [download page](https://himiyosh.github.io/tonarin/) shows them in the
visitor's language.

## Making a release

1. On `develop`, set the version: `npm version 0.3.0 --no-git-tag-version` (updates `package.json` and the lockfile).
2. Write `docs/releases/v0.3.0.md` and `docs/releases/v0.3.0.ja.md` from the template below. Commit both with the
   version bump, and preview the result with `node scripts/release-notes.mjs v0.3.0 --previous v0.2.0`.
3. Open the release pull request from `develop` into `main`, titled `release: v0.3.0`, and merge it once CI and the
   Package workflow are green.
4. Tag the merge commit on `main` and push the tag:

   ```bash
   git switch main && git pull
   git tag -a v0.3.0 -m "v0.3.0" && git push origin v0.3.0
   ```

5. The [Release workflow](../../.github/workflows/release.yml) checks that the tag matches `package.json` and that the
   notes exist, builds and smoke-tests the macOS and Windows apps, publishes the release with the files and
   `SHA256SUMS.txt`, and refreshes the download page.

A tag with a suffix (`v0.3.0-beta.1`) is published as a pre-release; the download page keeps offering the latest
full release first. To rebuild the files of an existing release, run the Release workflow by hand with its tag.

## Template

Write for people who use the app. Say what they can do now, in plain words, one change per bullet. Leave out empty
sections. Keep every paragraph and bullet on one line: GitHub shows each line break in release notes as it is. The
workflow adds the downloads, new contributors and the Full Changelog link.

```markdown
## vX.Y.Z Highlights

One or two sentences: what is new and why it matters.

### Product updates

#### Area (Conversation, Copilot, News, Automations, Connected apps, Characters, Windows, ...)

- What you can do now.

### Bug fixes and polish

- What works now that did not before.

### To developers

- Changes to commands, environment variables, the proxy's API or the build.

### To contributors

- Changes to CI, tests, tooling and the way we work.
```

The Japanese file uses the same sections: `## vX.Y.Z のハイライト`, `### 新しくなったこと`, `### 不具合の修正と改善`,
`### 開発する方へ`, `### コントリビューターの方へ`.

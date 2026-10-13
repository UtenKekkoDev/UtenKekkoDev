# Profile maintenance

Edit the introduction, project descriptions, links and layout directly in `README.md`.
Only the content between `<!-- releases:start -->` and `<!-- releases:end -->` is generated.
Keep exactly one pair of these markers, in this order.

The updater reads **unauthenticated public GitHub API** data for the three repositories
listed in `scripts/update-profile.mjs`. It first confirms that each repository is public,
then shows its latest published, non-draft release, including prereleases if they are
the newest. Releases are sorted by `published_at`, with at most three entries total.
Dates use `America/Los_Angeles` (Pacific Time, including daylight-saving changes).
Release links are constructed from the fixed repository allowlist and encoded tags.
Release notes, arbitrary links, private data and credentials are never included.

The workflow runs daily at **17:23 UTC**, can be run manually from Actions, and runs
when its relevant files change on `main`. Scheduled runs may start later than their
nominal time. It tests the updater and commits only `README.md` when the generated
content changes. GitHub's built-in token is used for checkout and committing; it is
not sent to the release API and no personal access token is needed.

Any repository/API error, malformed response or timeout fails the update without
changing the README. An empty result keeps the last successful content. Concurrent
local edits abort the write. If `main` advances while the workflow runs, its ordinary
push fails rather than overwriting the newer commits; rerun the workflow. Repository
rules that block bot pushes may also require a manual update.

## Local checks (Node.js 22 or newer)

```sh
node --test scripts/update-profile.test.mjs
node scripts/update-profile.mjs
```

For a reproducible local update using previously captured public API responses:

```sh
node scripts/update-profile.mjs --data snapshot.json
```

The snapshot shape is an object with a `repositories` map. Each of the three exact
repository names is a key, whose value contains `repository` (the public repository
metadata response) and `releases` (an array of release API responses). All three
entries are required, even when a repository has no releases. The same public,
date, draft and tag checks apply to fixture data. Keep temporary snapshots outside
the committed profile files.

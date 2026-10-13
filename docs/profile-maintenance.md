# Profile maintenance

Edit the introduction, project descriptions, links and layout directly in `README.md`.
Only the content between `<!-- releases:start -->` and `<!-- releases:end -->` is generated.
Keep exactly one pair of these markers, in this order.

The updater reads **public GitHub API** data for the three repositories
listed in `scripts/update-profile.mjs`. It first confirms that each repository is public,
then shows its latest published, non-draft release, including prereleases if they are
the newest. Releases are sorted by `published_at`, with at most three entries total.
Dates use `America/Los_Angeles` (Pacific Time, including daylight-saving changes).
Release links are constructed from the fixed repository allowlist and encoded tags.
Release notes, arbitrary links, private data and credentials are never included.

The workflow runs daily at **17:23 UTC**, can be run manually from Actions, and runs
when its relevant files change on `main`. Scheduled runs may start later than their
nominal time. It tests the updater and commits only `README.md` when the generated
content changes. The release-reading step supplies the repository's built-in,
short-lived GitHub Actions token as `PROFILE_GITHUB_TOKEN` to avoid anonymous API
rate limits on shared runners. No personal access token or additional account is
needed. Requests still target only the three allowlisted, verified-public repositories;
authorization is sent only to the fixed `https://api.github.com` host, with redirects
disabled. Private repositories and draft or unpublished releases remain excluded.
Local runs are unauthenticated unless `PROFILE_GITHUB_TOKEN` is explicitly provided.

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

## Codex activity card

The README embeds the dark 3D card from
`https://tokscale.ai/api/embed/UtenKekkoDev/svg?view=3d&theme=dark&compact=1&v=1`
and links to `https://tokscale.ai/u/UtenKekkoDev` for the interactive dashboard.
GitHub displays the SVG image; interactive filtering and daily details are available
on Tokscale. GitHub's image cache may delay visible updates.

The source is local Codex usage, so the card does not necessarily cover other
devices or cloud tasks. Displayed costs are API-equivalent estimates, not actual
subscription charges or remaining account limits. Some models have no available
price, so the displayed cost may be incomplete even when their tokens are counted.

Usage aggregates must be synced from the local machine to Tokscale independently
of this repository's release updater. GitHub Actions cannot read local Codex
session logs, and the release workflow does not collect or upload usage data.
A separate Windows Task Scheduler job refreshes the statistics daily while the
computer is online and the user is signed in. Missed runs can resume when the
computer becomes available. This repository does not contain that local job or
its credentials.

Keep raw session logs, prompts, code, local paths and authentication files out of
the public profile repository. Review the aggregate payload before syncing, and
limit its source to Codex so the card matches its label. The local wrapper also
removes provider labels, the device name, MCP server names, and session timing;
only a random device ID is retained to keep repeat submissions consistent.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { main, REPOSITORIES, selectReleases, updateReadme } from './update-profile.mjs';

const NOW = new Date('2026-10-13T12:00:00Z');
const ORIGINAL = 'Human introduction\n<!-- releases:start -->\nPrevious releases\n<!-- releases:end -->\nHuman footer\n';
const release = (tag, published_at, extra = {}) => ({ tag_name: tag, published_at, draft: false, ...extra });
const metadata = (repository) => ({ full_name: repository, private: false, visibility: 'public' });

function snapshot(releases = []) {
  return {
    repositories: Object.fromEntries(REPOSITORIES.map((repository, index) => [repository, {
      repository: metadata(repository), releases: releases[index] ?? [],
    }])),
  };
}

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'profile-updater-test-'));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  });
  const readmePath = join(directory, 'README.md');
  const dataPath = join(directory, 'snapshot.json');
  await writeFile(readmePath, ORIGINAL);
  return { readmePath, dataPath };
}

test('selects one latest published release per repository and orders by publication, rejecting drafts and invalid/future dates', () => {
  const data = snapshot([
    [
      release('older', '2026-10-01T12:00:00Z', { created_at: '2026-10-12T12:00:00Z' }),
      release('newer', '2026-10-11T12:00:00Z', { created_at: '2026-01-01T12:00:00Z' }),
      release('draft', '2026-10-12T12:00:00Z', { draft: true }),
      release('unpublished', null),
      release('future', '2026-10-14T12:00:00Z'),
      release('invalid-date', '2026-02-30T12:00:00Z'),
      release('bad-date', 'not a date'),
      release('missing-draft-state', '2026-10-12T12:00:00Z', { draft: undefined }),
    ],
    [release('v2.0-beta', '2026-10-12T12:00:00Z', { prerelease: true })],
    [release('v1', '2026-09-01T12:00:00Z')],
  ]);
  assert.deepEqual(selectReleases(data, NOW).map(({ tag }) => tag), ['v2.0-beta', 'newer', 'v1']);
});

test('escapes release labels and constructs only allowlisted tag links, ignoring arbitrary API links and names', () => {
  const tag = 'v1/<script>&"\'';
  const entries = selectReleases(snapshot([[release(tag, '2026-10-12T12:00:00Z', {
    html_url: 'https://example.invalid/payload', name: '<img src=x onerror=alert(1)>',
  })]]), NOW);
  const updated = updateReadme(ORIGINAL, entries);
  assert.match(updated, /v1\/&lt;script&gt;&amp;&quot;&#39;/);
  assert.match(updated, /href="https:\/\/github.com\/UtenKekkoDev\/cli-model-switcher\/releases\/tag\/v1%2F%3Cscript%3E%26%22%27"/);
  assert.doesNotMatch(updated, /<script>|<img|example\.invalid/);
});

test('formats dates in Pacific Time across summer and winter UTC day boundaries', () => {
  const entries = selectReleases(snapshot([
    [release('summer', '2026-07-01T06:30:00Z')],
    [release('winter', '2026-01-15T07:30:00Z')],
  ]), NOW);
  const updated = updateReadme(ORIGINAL, entries);
  assert.match(updated, /<sub>2026-06-30<\/sub>/);
  assert.match(updated, /<sub>2026-01-14<\/sub>/);
});

test('preserves marker boundaries, CRLF and surrounding human content, and is idempotent', () => {
  const readme = ORIGINAL.replaceAll('\n', '\r\n');
  const entries = selectReleases(snapshot([[release('v1', '2026-10-12T12:00:00Z')]]), NOW);
  const updated = updateReadme(readme, entries);
  assert.ok(updated.startsWith('Human introduction\r\n<!-- releases:start -->'));
  assert.ok(updated.endsWith('<!-- releases:end -->\r\nHuman footer\r\n'));
  assert.doesNotMatch(updated, /(?<!\r)\n/);
  assert.equal(updateReadme(updated, entries), updated);
  for (const invalid of [
    'No markers', '<!-- releases:end --><!-- releases:start -->',
    ORIGINAL + '<!-- releases:start -->', ORIGINAL + '<!-- releases:end -->',
  ]) assert.throws(() => updateReadme(invalid, entries), /exactly one ordered pair/);
});

test('local fixture updates the file once; repeated and all-empty data leave the saved result intact', async (t) => {
  const paths = await workspace(t);
  await writeFile(paths.dataPath, JSON.stringify(snapshot([[release('v1', '2026-10-12T12:00:00Z')]])));
  assert.deepEqual(await main({ ...paths, now: NOW }), { changed: true, releases: 1 });
  const saved = await readFile(paths.readmePath, 'utf8');
  assert.deepEqual(await main({ ...paths, now: NOW }), { changed: false, releases: 1 });
  await writeFile(paths.dataPath, JSON.stringify(snapshot()));
  assert.deepEqual(await main({ ...paths, now: NOW }), { changed: false, releases: 0 });
  assert.equal(await readFile(paths.readmePath, 'utf8'), saved);
});

test('a failed repository request preserves the old file and public API requests never carry authorization', async (t) => {
  const { readmePath } = await workspace(t);
  const fetchImpl = async (url, options) => {
    assert.equal(new URL(url).origin, 'https://api.github.com');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    assert.ok(!Object.keys(options.headers).some((key) => key.toLowerCase() === 'authorization'));
    const repository = REPOSITORIES.find((name) => url.includes(`/repos/${name}`));
    if (!url.includes('/releases?')) return Response.json(metadata(repository));
    if (repository === REPOSITORIES[1]) return new Response('', { status: 503 });
    return Response.json([release('v1', '2026-10-12T12:00:00Z')]);
  };
  await assert.rejects(main({ readmePath, fetchImpl, token: '', now: NOW }), /503/);
  assert.equal(await readFile(readmePath, 'utf8'), ORIGINAL);
});

test('optional token is sent only to fixed GitHub API URLs and published public releases still pass safety filters', async (t) => {
  const { readmePath } = await workspace(t);
  const requests = [];
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://api.github.com');
    assert.equal(options.headers.Authorization, 'Bearer test-only');
    assert.equal(options.redirect, 'error');
    const repository = REPOSITORIES.find((name) => parsed.pathname === `/repos/${name}`
      || parsed.pathname === `/repos/${name}/releases`);
    assert.ok(repository, 'request must target an allowlisted repository');
    requests.push(url);
    if (!url.includes('/releases?')) return Response.json(metadata(repository));
    return Response.json([
      release('public-v1', '2026-10-11T12:00:00Z', { html_url: 'https://example.invalid/release' }),
      release('draft-secret', '2026-10-12T12:00:00Z', { draft: true }),
      release('unpublished-secret', null),
      release('future-secret', '2026-10-14T12:00:00Z'),
    ]);
  };
  assert.deepEqual(await main({ readmePath, fetchImpl, token: 'test-only', now: NOW }),
    { changed: true, releases: 3 });
  assert.equal(requests.length, 6);
  const saved = await readFile(readmePath, 'utf8');
  assert.equal((saved.match(/public-v1<\/strong>/g) ?? []).length, 3);
  assert.doesNotMatch(saved, /secret|test-only|example\.invalid/);
});

test('private metadata fails before requesting that repository releases, preserving the README', async (t) => {
  const { readmePath } = await workspace(t);
  let privateReleaseRequested = false;
  const fetchImpl = async (url) => {
    const repository = REPOSITORIES.find((name) => url.includes(`/repos/${name}`));
    if (url.includes('/releases?')) {
      if (repository === REPOSITORIES[0]) privateReleaseRequested = true;
      return Response.json([]);
    }
    return Response.json(repository === REPOSITORIES[0]
      ? { ...metadata(repository), private: true, visibility: 'private' }
      : metadata(repository));
  };
  await assert.rejects(main({ readmePath, fetchImpl, token: 'test-only', now: NOW }), /not confirmed public/);
  assert.equal(privateReleaseRequested, false);
  assert.equal(await readFile(readmePath, 'utf8'), ORIGINAL);
});

test('network aborts preserve the old file', async (t) => {
  const { readmePath } = await workspace(t);
  const fetchImpl = (_url, { signal }) => new Promise((_resolve, reject) => {
    const keepAlive = setTimeout(() => reject(new Error('Test timeout')), 500);
    signal.addEventListener('abort', () => {
      clearTimeout(keepAlive);
      reject(signal.reason);
    }, { once: true });
  });
  await assert.rejects(main({ readmePath, fetchImpl, timeoutMs: 10, now: NOW }), { name: 'TimeoutError' });
  assert.equal(await readFile(readmePath, 'utf8'), ORIGINAL);
});

test('concurrent human edits during API reads are preserved rather than overwritten', async (t) => {
  const { readmePath } = await workspace(t);
  const humanEdit = ORIGINAL.replace('Human introduction', 'Updated by a human');
  const fetchImpl = async (url) => {
    const repository = REPOSITORIES.find((name) => url.includes(`/repos/${name}`));
    if (url.includes('/releases?')) return Response.json([release('v1', '2026-10-12T12:00:00Z')]);
    if (repository === REPOSITORIES[0]) await writeFile(readmePath, humanEdit);
    return Response.json(metadata(repository));
  };
  await assert.rejects(main({ readmePath, fetchImpl, now: NOW }), /README changed/);
  assert.equal(await readFile(readmePath, 'utf8'), humanEdit);
});

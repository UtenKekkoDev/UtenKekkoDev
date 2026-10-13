import { randomUUID } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPOSITORIES = Object.freeze([
  'UtenKekkoDev/cli-model-switcher',
  'UtenKekkoDev/vibe-coding-voice',
  'UtenKekkoDev/AIBILI',
]);
const PROJECT_NAMES = {
  'UtenKekkoDev/cli-model-switcher': 'CLI Model Switcher',
  'UtenKekkoDev/vibe-coding-voice': 'Vibe Coding Voice',
  'UtenKekkoDev/AIBILI': 'AI Bili Checker',
};

const START = '<!-- releases:start -->';
const END = '<!-- releases:end -->';
const DEFAULT_README = resolve(dirname(fileURLToPath(import.meta.url)), '../README.md');
const DATE_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
});

function publishedTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  // Date.parse rolls invalid dates such as February 30 into the next month.
  const canonical = value.includes('.')
    ? value.replace(/\.(\d+)Z$/, (_, fraction) => `.${fraction.padEnd(3, '0')}Z`)
    : value.replace('Z', '.000Z');
  return new Date(time).toISOString() === canonical ? time : null;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function releaseUrl(repository, tag) {
  const encodedTag = encodeURIComponent(tag).replace(/[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `https://github.com/${repository}/releases/tag/${encodedTag}`;
}

function displayDate(timestamp) {
  const parts = Object.fromEntries(DATE_FORMAT.formatToParts(timestamp)
    .filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function verifyPublicRepository(repository, metadata) {
  if (!metadata || metadata.private !== false || metadata.visibility !== 'public'
      || typeof metadata.full_name !== 'string'
      || metadata.full_name.toLowerCase() !== repository.toLowerCase()) {
    throw new Error(`Repository is not confirmed public: ${repository}`);
  }
}

export function selectReleases(snapshot, now = new Date()) {
  const cutoff = new Date(now).getTime();
  if (!Number.isFinite(cutoff)) throw new Error('Invalid current time');
  const selected = [];
  for (const repository of REPOSITORIES) {
    const entry = snapshot?.repositories?.[repository];
    verifyPublicRepository(repository, entry?.repository);
    if (!Array.isArray(entry.releases)) throw new Error(`Invalid release data: ${repository}`);
    const candidates = entry.releases.flatMap((release) => {
      const timestamp = publishedTime(release?.published_at);
      const tag = release?.tag_name;
      if (release?.draft !== false || timestamp === null || timestamp > cutoff
          || typeof tag !== 'string' || !tag.trim() || /[\u0000-\u001F\u007F]/.test(tag)) return [];
      return [{ repository, tag, timestamp, url: releaseUrl(repository, tag) }];
    });
    candidates.sort((a, b) => b.timestamp - a.timestamp || a.tag.localeCompare(b.tag, 'en'));
    if (candidates.length) selected.push(candidates[0]);
  }
  return selected.sort((a, b) => b.timestamp - a.timestamp
    || a.repository.localeCompare(b.repository, 'en')).slice(0, 3);
}

function markerBounds(readme) {
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start < 0 || end < start + START.length
      || readme.indexOf(START, start + START.length) !== -1
      || readme.indexOf(END, end + END.length) !== -1) {
    throw new Error('README must contain exactly one ordered pair of release markers');
  }
  return { start: start + START.length, end };
}

export function updateReadme(readme, releases) {
  const { start, end } = markerBounds(readme);
  // A temporary lack of releases must not erase the last successful result.
  if (releases.length === 0) return readme;
  const eol = readme.includes('\r\n') ? '\r\n' : '\n';
  const paragraphs = releases.map(({ repository, tag, timestamp, url }) => {
    const project = PROJECT_NAMES[repository];
    return `<p><a href="${escapeHtml(url)}"><strong>${escapeHtml(project)} ${escapeHtml(tag)}</strong></a><br /><sub>${displayDate(timestamp)}</sub></p>`;
  });
  return readme.slice(0, start) + eol + paragraphs.join(eol + eol) + eol + readme.slice(end);
}

async function githubJson(path, { fetchImpl, timeoutMs, token }) {
  const response = await fetchImpl(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'UtenKekkoDev-public-profile',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`GitHub API returned ${response.status} for ${path}`);
  return response.json();
}

export async function fetchSnapshot({ fetchImpl = fetch, timeoutMs = 12_000, token } = {}) {
  const entries = await Promise.all(REPOSITORIES.map(async (repository) => {
    const options = { fetchImpl, timeoutMs, token };
    const metadata = await githubJson(`/repos/${repository}`, options);
    verifyPublicRepository(repository, metadata);
    const releases = [];
    for (let page = 1; page <= 100; page += 1) {
      const batch = await githubJson(`/repos/${repository}/releases?per_page=100&page=${page}`, options);
      if (!Array.isArray(batch)) throw new Error(`Invalid release response: ${repository}`);
      releases.push(...batch);
      if (batch.length < 100) return [repository, { repository: metadata, releases }];
    }
    throw new Error(`Release pagination limit reached: ${repository}`);
  }));
  return { repositories: Object.fromEntries(entries) };
}

export async function main({
  readmePath = DEFAULT_README,
  dataPath,
  fetchImpl = fetch,
  timeoutMs = 12_000,
  token = process.env.PROFILE_GITHUB_TOKEN,
  now = new Date(),
} = {}) {
  const original = await readFile(readmePath, 'utf8');
  markerBounds(original);
  const snapshot = dataPath
    ? JSON.parse(await readFile(dataPath, 'utf8'))
    : await fetchSnapshot({ fetchImpl, timeoutMs, token });
  const releases = selectReleases(snapshot, now);
  const updated = updateReadme(original, releases);
  if (updated === original) return { changed: false, releases: releases.length };

  // Write beside README and rename atomically; refuse to overwrite concurrent local edits.
  const temporaryPath = `${readmePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, updated, { encoding: 'utf8', flag: 'wx' });
    if (await readFile(readmePath, 'utf8') !== original) {
      throw new Error('README changed during the update; leaving it untouched');
    }
    await rename(temporaryPath, readmePath);
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  return { changed: true, releases: releases.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--data')) {
      throw new Error('Usage: node scripts/update-profile.mjs [--data snapshot.json]');
    }
    const result = await main({ dataPath: args[1] });
    console.log(result.changed ? `Updated ${result.releases} public releases.` : 'README unchanged.');
  } catch (error) {
    console.error(`Profile update failed: ${error.message}`);
    process.exitCode = 1;
  }
}

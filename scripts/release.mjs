import { createHash } from 'node:crypto';
import { createReadStream, copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkVersions, projectRoot } from './check-version.mjs';

export function assetNames(version) {
  return {
    full: `GitOfflineSync_${version}_x64-setup-with-webview2.exe`,
    slim: `GitOfflineSync_${version}_x64-setup-no-webview2.exe`,
    dmg: `GitOfflineSync_${version}_universal.dmg`,
    mac: `GitOfflineSync_${version}_universal.app.tar.gz`,
  };
}

function nonemptyFile(path) {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size === 0) throw new Error(`Missing or empty asset: ${path}`);
  return stat.size;
}

function signature(path) {
  nonemptyFile(path);
  const text = readFileSync(path, 'utf8').trim();
  // Tauri stores a base64-encoded, four-line minisign signature, not raw binary.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) throw new Error(`Invalid signature: ${path}`);
  const decoded = Buffer.from(text, 'base64');
  if (decoded.toString('base64') !== text) throw new Error(`Invalid signature encoding: ${path}`);
  const lines = decoded.toString('utf8').trim().split(/\r?\n/);
  const packet = Buffer.from(lines[1] ?? '', 'base64');
  if (lines.length !== 4 || !lines[0].startsWith('untrusted comment: ') ||
      !lines[2].startsWith('trusted comment: ') || packet.length !== 74 ||
      !['Ed', 'ED'].includes(packet.subarray(0, 2).toString()) ||
      Buffer.from(lines[3] ?? '', 'base64').length !== 64) {
    throw new Error(`Invalid minisign signature: ${path}`);
  }
  return text;
}

function singleFile(directory, suffix) {
  const files = readdirSync(directory).filter((name) => name.endsWith(suffix));
  if (files.length !== 1) throw new Error(`Expected exactly one ${suffix} in ${directory}, found ${files.length}`);
  return join(directory, files[0]);
}

// Normalize each matrix entry into a small, flat artifact with a known file set.
export function stageAssets(label, output, version, root = projectRoot) {
  const names = assetNames(version);
  let files;
  if (label === 'windows-with-webview2' || label === 'windows-no-webview2') {
    const source = singleFile(join(root, 'src-tauri/target/release/bundle/nsis'), '.exe');
    if (!basename(source).includes(`_${version}_x64`)) throw new Error(`Wrong installer version/architecture: ${source}`);
    const name = label === 'windows-with-webview2' ? names.full : names.slim;
    files = [[source, name], [`${source}.sig`, `${name}.sig`]];
  } else if (label === 'macos-universal') {
    const bundle = join(root, 'src-tauri/target/universal-apple-darwin/release/bundle');
    const dmg = singleFile(join(bundle, 'dmg'), '.dmg');
    if (!basename(dmg).includes(`_${version}_universal`)) throw new Error(`Wrong installer version/architecture: ${dmg}`);
    const archive = singleFile(join(bundle, 'macos'), '.app.tar.gz');
    files = [[dmg, names.dmg], [archive, names.mac], [`${archive}.sig`, `${names.mac}.sig`]];
  } else {
    throw new Error(`Unknown build label: ${label}`);
  }
  for (const [source] of files) {
    nonemptyFile(source);
    if (source.endsWith('.sig')) signature(source);
  }
  mkdirSync(output, { recursive: true });
  if (readdirSync(output).length) throw new Error(`Staging directory must be empty: ${output}`);
  for (const [source, name] of files) copyFileSync(source, join(output, name));
}

export function prepareAssets(directory, version, repository, tag = `v${version}`) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '')) throw new Error('Invalid GitHub repository');
  if (tag !== `v${version}`) throw new Error('Release tag/version mismatch');
  const names = assetNames(version);
  const expected = [names.full, `${names.full}.sig`, names.slim, `${names.slim}.sig`, names.dmg, names.mac, `${names.mac}.sig`];
  const actual = readdirSync(directory).filter((name) => name !== 'latest.json').sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) throw new Error('Unexpected or missing release assets');
  for (const name of expected) nonemptyFile(join(directory, name));
  for (const name of [names.full, names.slim, names.mac]) signature(join(directory, `${name}.sig`));
  const platform = (name) => ({
    signature: signature(join(directory, `${name}.sig`)),
    url: `https://github.com/${repository}/releases/download/${tag}/${name}`,
  });
  const manifest = {
    version,
    notes: `GitOfflineSync ${version}`,
    pub_date: new Date().toISOString(),
    platforms: {
      'windows-x86_64': platform(names.slim),
      'darwin-aarch64': platform(names.mac),
      'darwin-x86_64': platform(names.mac),
    },
  };
  const manifestPath = join(directory, 'latest.json');
  // A retry must not silently overwrite a stale or tampered updater manifest.
  if (!readdirSync(directory).includes('latest.json')) writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const saved = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (saved.version !== version || typeof saved.notes !== 'string' || !Number.isFinite(Date.parse(saved.pub_date)) ||
      JSON.stringify(saved.platforms) !== JSON.stringify(manifest.platforms)) {
    throw new Error('Invalid latest.json version, date, platform URLs or signatures');
  }
  return [...expected, 'latest.json'].map((name) => ({ name, path: join(directory, name), size: nonemptyFile(join(directory, name)) }));
}

async function sha256(stream) {
  const hash = createHash('sha256');
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

// Dependency injection keeps release lifecycle tests entirely offline (no token).
export function githubClient(repository, token, fetcher = fetch) {
  if (!token) throw new Error('GH_TOKEN is required to publish');
  const base = `https://api.github.com/repos/${repository}`;
  return {
    async request(path, { method = 'GET', body, missing = false } = {}) {
      const response = await fetcher(`${base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (missing && response.status === 404) return null;
      if (!response.ok) throw new Error(`GitHub ${method} ${path}: ${response.status} ${await response.text()}`);
      return response.status === 204 ? null : response.json();
    },
    async upload(id, asset) {
      const response = await fetcher(`https://uploads.github.com/repos/${repository}/releases/${id}/assets?name=${encodeURIComponent(asset.name)}`, {
        method: 'POST', duplex: 'half', body: createReadStream(asset.path),
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/octet-stream', 'Content-Length': String(asset.size), 'X-GitHub-Api-Version': '2022-11-28' },
      });
      if (!response.ok) throw new Error(`Upload ${asset.name}: ${response.status} ${await response.text()}`);
    },
    async digest(id) {
      const response = await fetcher(`${base}/releases/assets/${id}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/octet-stream', 'X-GitHub-Api-Version': '2022-11-28' },
      });
      if (!response.ok || !response.body) throw new Error(`Download verification failed: ${id} (${response.status})`);
      return sha256(response.body);
    },
  };
}

function requireDraft(release, tag) {
  if (!release?.draft || release.tag_name !== tag) throw new Error(`Refusing to modify a public or mismatched release: ${tag}`);
}

export async function publishAssets(client, assets, tag) {
  let release = await client.request(`/releases/tags/${encodeURIComponent(tag)}`, { missing: true });
  // GitHub documents the tag endpoint for published releases only. Discover
  // authenticated drafts through the paginated release list when it returns 404.
  if (!release) {
    for (let page = 1; ; page++) {
      const releases = await client.request(`/releases?per_page=100&page=${page}`);
      const matches = releases.filter((candidate) => candidate.tag_name === tag);
      if (matches.length > 1) throw new Error(`Multiple releases for ${tag}; refusing to choose`);
      if (matches.length) { release = matches[0]; break; }
      if (releases.length < 100) break;
    }
  }
  if (release) requireDraft(release, tag);
  else {
    // Do not let the release API create a tag at an unintended branch HEAD.
    await client.request(`/git/ref/tags/${encodeURIComponent(tag)}`);
    release = await client.request('/releases', {
      method: 'POST', body: { tag_name: tag, name: tag, draft: true, prerelease: tag.includes('-'), make_latest: 'false', generate_release_notes: true },
    });
    requireDraft(release, tag);
  }
  const path = `/releases/${release.id}`;
  const guard = async () => requireDraft(await client.request(path), tag);
  const existing = await client.request(`${path}/assets?per_page=100`);
  if (existing.some((asset) => !assets.some(({ name }) => name === asset.name))) throw new Error('Draft contains unexpected assets; refusing to delete them');
  // Re-runs may replace partial assets, but never touch an already public release.
  for (const asset of existing) {
    await guard();
    await client.request(`/releases/assets/${asset.id}`, { method: 'DELETE' });
  }
  for (const asset of assets) {
    await guard();
    await client.upload(release.id, asset);
  }
  await guard();
  const uploaded = await client.request(`${path}/assets?per_page=100`);
  if (uploaded.length !== assets.length) throw new Error('Uploaded asset count does not match');
  for (const asset of assets) {
    const remote = uploaded.filter(({ name }) => name === asset.name);
    if (remote.length !== 1 || remote[0].state !== 'uploaded' || remote[0].size !== asset.size) throw new Error(`Incomplete upload: ${asset.name}`);
    if (await client.digest(remote[0].id) !== await sha256(createReadStream(asset.path))) throw new Error(`Uploaded checksum mismatch: ${asset.name}`);
  }
  await guard();
  // This is the sole publication operation. Failed uploads/checks leave a draft,
  // so releases/latest cannot point at a release missing latest.json or a bundle.
  await client.request(path, {
    method: 'PATCH', body: { draft: false, prerelease: tag.includes('-'), make_latest: tag.includes('-') ? 'false' : 'legacy' },
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, arg, output] = process.argv.slice(2);
  const tag = process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined;
  const version = checkVersions(projectRoot, tag);
  if (command === 'stage') stageAssets(arg, resolve(output), version);
  else if (command === 'preflight' || command === 'publish') {
    const assets = prepareAssets(resolve(arg), version, process.env.GITHUB_REPOSITORY, tag);
    if (command === 'publish') {
      if (!tag) throw new Error('Publishing requires a version tag');
      await publishAssets(githubClient(process.env.GITHUB_REPOSITORY, process.env.GH_TOKEN), assets, tag);
    }
    console.log(`${command}: verified ${assets.length} assets for v${version}`);
  } else throw new Error('Usage: release.mjs stage <label> <output> | preflight <directory> | publish <directory>');
}

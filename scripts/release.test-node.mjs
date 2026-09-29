import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { runBuild } from './build.mjs';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { checkVersions } from './check-version.mjs';
import { assetNames, githubClient, prepareAssets, publishAssets, stageAssets } from './release.mjs';

const version = '2.0.3';
const tag = `v${version}`;
const repository = 'example/git-offline-sync';
const packet = Buffer.alloc(74);
packet.write('ED');
const signature = Buffer.from(`untrusted comment: fixture\n${packet.toString('base64')}\ntrusted comment: fixture\n${Buffer.alloc(64).toString('base64')}\n`).toString('base64');

function temporary(t) {
  const dir = mkdtempSync(join(tmpdir(), 'release-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function fixture(t, v = version) {
  const dir = temporary(t);
  const names = assetNames(v);
  for (const name of Object.values(names)) write(join(dir, name), `fixture ${name}`);
  for (const name of [names.full, names.slim, names.mac]) write(join(dir, `${name}.sig`), signature);
  return dir;
}

function apiMock(assets, { existing = null, failUpload = false, corrupt = false, extra = false, publishDuringUpload = false, hideDraft = false, partial = false } = {}) {
  const events = [];
  let release = existing;
  let remote = extra ? [{ id: 99, name: 'do-not-delete.txt' }] : partial ? [{ id: 99, name: assets[0].name }] : [];
  let nextId = 1;
  const content = new Map();
  return {
    events,
    async request(path, options = {}) {
      const method = options.method ?? 'GET';
      events.push({ method, path, body: options.body });
      if (path.startsWith('/releases/tags/')) return hideDraft ? null : release;
      if (path.startsWith('/releases?')) return release ? [release] : [];
      if (path.startsWith('/git/ref/tags/')) return { ref: tag };
      if (method === 'POST' && path === '/releases') {
        release = { id: 7, draft: true, tag_name: options.body.tag_name };
        return release;
      }
      if (path.endsWith('/assets?per_page=100')) return remote;
      if (method === 'DELETE') { remote = remote.filter(({ id }) => !path.endsWith(`/${id}`)); return null; }
      if (method === 'PATCH') { release = { ...release, ...options.body }; return release; }
      if (path === '/releases/7') return release;
      throw new Error(`Unexpected API call ${method} ${path}`);
    },
    async upload(id, asset) {
      events.push({ method: 'UPLOAD', name: asset.name });
      if (failUpload) throw new Error('upload interrupted');
      const assetId = nextId++;
      remote.push({ id: assetId, name: asset.name, size: asset.size, state: 'uploaded' });
      content.set(assetId, readFileSync(asset.path));
      if (publishDuringUpload) release.draft = false;
    },
    async digest(id) {
      events.push({ method: 'DIGEST', id });
      return corrupt ? 'wrong digest' : createHash('sha256').update(content.get(id)).digest('hex');
    },
  };
}

test('build driver preserves Cargo separator in a real child process without a shell', (t) => {
  const probe = join(temporary(t), 'argv probe.cjs');
  write(probe, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
  for (const extra of [[], ['--config', 'src-tauri/tauri.windows-slim.conf.json'], ['--target', 'universal-apple-darwin']]) {
    const options = ['--ci', '--config', 'src-tauri/tauri.release.conf.json', ...extra];
    let received;
    const status = runBuild(options, (command, args, spawnOptions) => {
      assert.equal(command, process.execPath);
      assert.match(args[0], /[\\/]@tauri-apps[\\/]cli[\\/]tauri\.js$/);
      assert.equal(spawnOptions.shell, false);
      assert.equal(spawnOptions.stdio, 'inherit');
      const result = spawnSync(command, [probe, ...args.slice(1)], { ...spawnOptions, stdio: 'pipe', encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      received = JSON.parse(result.stdout);
      return result;
    });
    assert.equal(status, 0);
    assert.deepEqual(received, ['build', ...options, '--', '--locked']);
  }
});

test('build driver propagates failures instead of reporting success', () => {
  assert.equal(runBuild([], () => ({ status: 17 })), 17);
  assert.throws(() => runBuild([], () => ({ error: new Error('spawn failed') })), /spawn failed/);
  assert.throws(() => runBuild([], () => ({ status: null, signal: 'SIGTERM' })), /SIGTERM/);
});

test('versions include package, Cargo, Tauri and optional exact tag', (t) => {
  const dir = temporary(t);
  write(join(dir, 'package.json'), JSON.stringify({ version }));
  write(join(dir, 'src-tauri/tauri.conf.json'), JSON.stringify({ version }));
  write(join(dir, 'src-tauri/Cargo.toml'), `[package]\nname = "fixture"\nversion = "${version}"\n\n[dependencies]\nversion = "9.0.0"\n`);
  assert.equal(checkVersions(dir), version);
  assert.equal(checkVersions(dir, tag), version);
  assert.throws(() => checkVersions(dir, 'v2.0.2'), /Tag/);
  assert.throws(() => checkVersions(dir, version), /Tag/);
  write(join(dir, 'package.json'), JSON.stringify({ version: '2.0.4' }));
  assert.throws(() => checkVersions(dir), /Version mismatch/);
  write(join(dir, 'package.json'), JSON.stringify({ version }));
  write(join(dir, 'src-tauri/tauri.conf.json'), JSON.stringify({ version: '2.0.4' }));
  assert.throws(() => checkVersions(dir), /Version mismatch/);
});

test('preflight creates all three updater targets with matching URL/signature', (t) => {
  const dir = fixture(t);
  const assets = prepareAssets(dir, version, repository, tag);
  assert.equal(assets.length, 8);
  const manifest = JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf8'));
  assert.equal(manifest.version, version);
  assert.deepEqual(Object.keys(manifest.platforms), ['windows-x86_64', 'darwin-aarch64', 'darwin-x86_64']);
  assert.equal(manifest.platforms['windows-x86_64'].signature, signature);
  assert.match(manifest.platforms['windows-x86_64'].url, /\/v2\.0\.3\/.*-no-webview2\.exe$/);
  assert.deepEqual(manifest.platforms['darwin-aarch64'], manifest.platforms['darwin-x86_64']);
  assert.equal(prepareAssets(dir, version, repository).length, 8);
});

test('preflight rejects missing, empty, unexpected and invalidly signed assets', (t) => {
  for (const fault of ['missing', 'empty', 'unexpected', 'signature']) {
    const dir = fixture(t);
    const name = assetNames(version).slim;
    if (fault === 'missing') rmSync(join(dir, `${name}.sig`));
    if (fault === 'empty') write(join(dir, name), '');
    if (fault === 'unexpected') write(join(dir, 'old.exe'), 'stale');
    if (fault === 'signature') write(join(dir, `${name}.sig`), 'not a signature');
    assert.throws(() => prepareAssets(dir, version, repository), /asset|signature/i, fault);
  }
});

test('preflight rejects stale JSON, altered URLs/signatures and tag mismatch', (t) => {
  for (const fault of ['version', 'url', 'signature', 'date', 'json']) {
    const dir = fixture(t);
    prepareAssets(dir, version, repository);
    const path = join(dir, 'latest.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    if (fault === 'version') manifest.version = '1.0.0';
    if (fault === 'url') manifest.platforms['windows-x86_64'].url = 'https://example.com/wrong.exe';
    if (fault === 'signature') manifest.platforms['darwin-aarch64'].signature = 'other';
    if (fault === 'date') manifest.pub_date = 'bad date';
    write(path, fault === 'json' ? '{' : JSON.stringify(manifest));
    assert.throws(() => prepareAssets(dir, version, repository));
  }
  assert.throws(() => prepareAssets(fixture(t), version, repository, 'v1.0.0'), /tag\/version/);
});

test('stage requires exactly one correctly versioned installer and its signature', (t) => {
  const root = temporary(t);
  const source = join(root, `src-tauri/target/release/bundle/nsis/GitOfflineSync_${version}_x64-setup.exe`);
  write(source, 'installer');
  assert.throws(() => stageAssets('windows-no-webview2', join(root, 'out'), version, root));
  write(`${source}.sig`, signature);
  stageAssets('windows-no-webview2', join(root, 'out'), version, root);
  assert.equal(readFileSync(join(root, 'out', assetNames(version).slim), 'utf8'), 'installer');
  assert.throws(() => stageAssets('windows-no-webview2', join(root, 'out'), version, root), /empty/);
  write(join(dirname(source), 'duplicate.exe'), 'installer');
  assert.throws(() => stageAssets('windows-no-webview2', join(root, 'out2'), version, root), /exactly one/);
});

test('macOS staging requires dmg, updater archive and signature', (t) => {
  const root = temporary(t);
  const bundle = join(root, 'src-tauri/target/universal-apple-darwin/release/bundle');
  write(join(bundle, 'dmg', assetNames(version).dmg), 'dmg');
  write(join(bundle, 'macos/GitOfflineSync.app.tar.gz'), 'archive');
  assert.throws(() => stageAssets('macos-universal', join(root, 'out'), version, root));
  write(join(bundle, 'macos/GitOfflineSync.app.tar.gz.sig'), signature);
  stageAssets('macos-universal', join(root, 'out'), version, root);
  assert.equal(readFileSync(join(root, 'out', assetNames(version).mac), 'utf8'), 'archive');
});

test('publication is the last operation, after every downloaded checksum is verified', async (t) => {
  const assets = prepareAssets(fixture(t), version, repository);
  const client = apiMock(assets);
  await publishAssets(client, assets, tag);
  const create = client.events.find(({ method }) => method === 'POST');
  assert.equal(create.body.draft, true);
  assert.equal(create.body.make_latest, 'false');
  assert.equal(client.events.filter(({ method }) => method === 'UPLOAD').length, assets.length);
  assert.equal(client.events.filter(({ method }) => method === 'DIGEST').length, assets.length);
  assert.deepEqual(client.events.at(-1), { method: 'PATCH', path: '/releases/7', body: { draft: false, prerelease: false, make_latest: 'legacy' } });
});

test('existing public releases are never mutated or reset to draft', async (t) => {
  const assets = prepareAssets(fixture(t), version, repository);
  const client = apiMock(assets, { existing: { id: 7, draft: false, tag_name: tag } });
  await assert.rejects(publishAssets(client, assets, tag), /Refusing/);
  assert.equal(client.events.length, 1);
});

test('partial upload and checksum failures leave a draft, never publish', async (t) => {
  const assets = prepareAssets(fixture(t), version, repository);
  for (const failure of [{ failUpload: true }, { corrupt: true }, { publishDuringUpload: true }, { extra: true }]) {
    const client = apiMock(assets, failure);
    await assert.rejects(publishAssets(client, assets, tag));
    assert.equal(client.events.some(({ method }) => method === 'PATCH'), false);
    assert.equal(client.events.some(({ method }) => method === 'DELETE'), false);
  }
});

test('draft retries do not recreate the release, prereleases cannot become latest', async (t) => {
  const preVersion = '2.0.4-beta.1';
  const preTag = `v${preVersion}`;
  const assets = prepareAssets(fixture(t, preVersion), preVersion, repository);
  const client = apiMock(assets, { existing: { id: 7, draft: true, tag_name: preTag }, hideDraft: true, partial: true });
  await publishAssets(client, assets, preTag);
  assert.equal(client.events.some(({ method }) => method === 'POST'), false);
  assert.equal(client.events.filter(({ method }) => method === 'DELETE').length, 1);
  assert.equal(client.events.at(-1).body.make_latest, 'false');
  assert.equal(client.events.at(-1).body.prerelease, true);
});

test('only HTTP 404 is absence; permission/network/server errors must not create a release', async () => {
  for (const status of [401, 403, 429, 500]) {
    const client = githubClient(repository, 'test-only-token', async () => new Response('failure', { status }));
    await assert.rejects(client.request('/releases/tags/v1.0.0', { missing: true }), new RegExp(String(status)));
  }
  const client = githubClient(repository, 'test-only-token', async () => new Response('', { status: 404 }));
  assert.equal(await client.request('/releases/tags/v1.0.0', { missing: true }), null);
  assert.throws(() => githubClient(repository, ''), /GH_TOKEN/);
});

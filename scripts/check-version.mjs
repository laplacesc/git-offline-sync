import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));

export function checkVersions(root = projectRoot, tag) {
  const json = (path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
  const version = json('package.json').version;
  // The package section is deliberately isolated from dependency versions.
  const cargo = readFileSync(resolve(root, 'src-tauri/Cargo.toml'), 'utf8');
  const section = cargo.split(/^\[package\]\s*$/m)[1]?.split(/^\[/m)[0];
  const cargoVersion = section?.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
  const tauriVersion = json('src-tauri/tauri.conf.json').version;
  const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
  if (typeof version !== 'string' || !semver.test(version)) {
    throw new Error(`Invalid release version: ${version}`);
  }
  if (version !== cargoVersion || version !== tauriVersion) {
    throw new Error(`Version mismatch: package=${version}, Cargo=${cargoVersion}, Tauri=${tauriVersion}`);
  }
  if (tag !== undefined && tag !== `v${version}`) {
    throw new Error(`Tag ${tag} does not match v${version}`);
  }
  return version;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tag = process.argv[2] ?? (process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined);
  console.log(`Version verified: ${checkVersions(projectRoot, tag)}`);
}

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

export function runBuild(args, spawn = spawnSync) {
  // Insert the Cargo separator after shell/package-manager parsing, not in it.
  const result = spawn(process.execPath, [
    require.resolve('@tauri-apps/cli/tauri.js'),
    'build',
    ...args,
    '--',
    '--locked',
  ], { stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status === null) throw new Error(`Tauri build terminated: ${result.signal ?? 'unknown signal'}`);
  return result.status;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runBuild(process.argv.slice(2));
}

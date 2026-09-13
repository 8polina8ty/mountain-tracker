import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { runOsmium } from '../osm-import/osmium-runner.ts';

/** Supports an activated shell, explicit installation, or standard Windows Miniforge. */
export async function resolvePbfOsmium() {
  const roots = [process.env.CONDA_PREFIX, join(process.env.ProgramData ?? 'C:/ProgramData', 'miniforge3')].filter((p): p is string => Boolean(p));
  const candidates = [process.env.OSMIUM_EXECUTABLE, ...roots.map(r => join(r, 'Library', 'bin', 'osmium.exe'))].filter((p): p is string => Boolean(p));
  for (const executable of candidates) {
    try { await access(executable); } catch { continue; }
    let version = ''; await runOsmium(['--version'], line => { version += line + '\n'; }, { executable });
    return { executable, prefix: [] as string[], version: version.trim() };
  }
  for (const root of roots) {
    const executable = join(root, 'Scripts', 'conda.exe');
    try { await access(executable); } catch { continue; }
    const prefix = ['run', '--no-capture-output', '-n', 'base', 'osmium'];
    let version = ''; await runOsmium([...prefix, '--version'], line => { version += line + '\n'; }, { executable });
    return { executable, prefix, version: version.trim() };
  }
  let version = ''; await runOsmium(['--version'], line => { version += line + '\n'; });
  return { executable: 'osmium', prefix: [] as string[], version: version.trim() };
}

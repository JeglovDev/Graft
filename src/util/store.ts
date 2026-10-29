/**
 * The machine-wide graph store `GRAFT_STORE` names.
 *
 * With a store, nothing graft generates lands in the repo: each repo gets its
 * own entry under the store instead of `<repo>/graft/` (or `.trail/cache/`) and
 * `<repo>/.graft/`. The env var is set once (e.g. in a user-level MCP server
 * entry) and covers every repo on the machine, which a per-repo `GRAFT_DIR`
 * cannot. `--dir` and `GRAFT_DIR` still win over it.
 *
 * Kept in its own dependency-free module because both the map-dir resolver
 * (`context/map-dir.ts`) and the state module (`util/state.ts`) need it, and
 * the latter already imports the former.
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** The store root, or null when `GRAFT_STORE` is unset. A leading `~` is
 * expanded because MCP configs pass env values through without a shell. */
export function storeRoot(): string | null {
  const raw = process.env.GRAFT_STORE;
  if (!raw) return null;
  if (raw === '~') return homedir();
  if (raw.startsWith('~/')) return join(homedir(), raw.slice(2));
  return resolve(raw);
}

/** A repo's entry name in the store: its absolute path with separators turned
 * into dashes (`/work/api` → `-work-api`), readable in a plain `ls`. */
export function storeKey(projectDir: string): string {
  return resolve(projectDir).replace(/[\\/:]/g, '-');
}

/** Where a repo's generated state lives: the repo itself, or its store entry. */
export function stateHome(projectDir: string): string {
  const store = storeRoot();
  return store ? join(store, storeKey(projectDir)) : projectDir;
}

/** The repo's code map folder inside the store, or null without a store. */
export function storeMapDir(projectDir: string): string | null {
  return storeRoot() ? join(stateHome(projectDir), 'graft') : null;
}

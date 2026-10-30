/**
 * LSP server registry — maps graft language names to a language server command.
 * Only servers whose binary is actually on PATH are eligible; a missing binary
 * simply means that language gets no LSP enrichment (the AST graph stands alone).
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { win32 } from "node:path";

export interface LspServer {
  /** graft language names (as produced by languageLabelOf/genericLangOf) this serves. */
  languages: string[];
  command: string;
  args: string[];
  /** the LSP `languageId` to tag opened documents with. */
  languageId: string;
  /** For a server without call hierarchy: the call sites to ask `definition` about.
   * Group 1 is the called name; the request goes to its first character. */
  callSites?: RegExp;
  /** Names group 1 may match that are language syntax, not calls (`if (`, `array(`). */
  notCalls?: ReadonlySet<string>;
}

/** PHP: `$o->m(`, `C::m(`, `new C(`, `f(` - the name right before the parenthesis. */
const PHP_CALL_SITES = /([A-Za-z_]\w*)\s*\(/g;
const PHP_NOT_CALLS: ReadonlySet<string> = new Set([
  "if", "elseif", "for", "foreach", "while", "switch", "match", "catch", "fn", "function", "array", "list",
  "isset", "empty", "unset", "eval", "exit", "die", "return", "echo", "print", "include", "include_once",
  "require", "require_once", "declare", "use", "and", "or", "xor", "clone", "static", "self", "parent",
]);

/** First-match-wins; ordering is priority. Extend by adding a row. */
export const LSP_SERVERS: readonly LspServer[] = [
  { languages: ["rust"], command: "rust-analyzer", args: [], languageId: "rust" },
  { languages: ["cpp", "c"], command: "clangd", args: ["--background-index"], languageId: "cpp" },
  { languages: ["go"], command: "gopls", args: [], languageId: "go" },
  { languages: ["python"], command: "pyright-langserver", args: ["--stdio"], languageId: "python" },
  // phpactor has no call hierarchy: enrich.ts asks `definition` at each call site instead.
  { languages: ["php"], command: "phpactor", args: ["language-server"], languageId: "php", callSites: PHP_CALL_SITES, notCalls: PHP_NOT_CALLS },
  { languages: ["typescript", "javascript", "tsx"], command: "typescript-language-server", args: ["--stdio"], languageId: "typescript" },
];

/** Windows: the first `<cmd>.com/.exe/.cmd` in PATH order, searching only
 * absolute PATH folders. Not `where.exe`: it (and cmd.exe finding `where.exe` itself)
 * searches the current folder first, so a checkout could plant
 * `typescript-language-server.cmd` and have `graft build --lsp` run it. The extension
 * matters too: npm puts an extensionless sh script next to each `.cmd` shim, which
 * Windows can't run. */
export function findOnWindowsPath(cmd: string, pathVar = process.env.PATH ?? "", exists: (p: string) => boolean = existsSync): string | null {
  for (const entry of pathVar.split(";")) {
    const dir = entry.trim().replace(/^"(.*)"$/, "$1");
    if (!/^([a-zA-Z]:[\\/]|\\\\)/.test(dir)) continue; // relative or empty ("." = the current folder)
    for (const ext of [".com", ".exe", ".cmd"]) { // .cmd: npm's shims (see spawnSpec); a .bat can't be started without a shell
      const p = win32.join(dir, cmd + ext);
      if (exists(p)) return p;
    }
  }
  return null;
}

const resolved = new Map<string, string | null>();
/** Resolve a command to its ABSOLUTE path via the login shell's PATH. `spawn`
 * resolves against `process.env.PATH`, which often omits `~/.cargo/bin`,
 * `~/go/bin`, etc. where these servers live — so `command -v` can find a server
 * that `spawn(cmd)` then can't. Spawning the absolute path avoids that mismatch.
 * On Windows `execSync` runs through cmd.exe, which has no `command -v`: search
 * PATH directly there (findOnWindowsPath). */
function resolveCommand(cmd: string): string | null {
  if (resolved.has(cmd)) return resolved.get(cmd)!;
  let abs: string | null = null;
  try {
    abs = process.platform === "win32"
      ? findOnWindowsPath(cmd)
      : execSync(`command -v ${cmd}`, { encoding: "utf8" }).trim() || null;
  } catch { abs = null; }
  resolved.set(cmd, abs);
  return abs;
}

/** Pick the highest-priority installed server that covers at least one of the
 * languages present in the repo, with `command` resolved to an absolute path.
 * Returns null if none is installed. */
export function pickServer(languagesPresent: Set<string>): LspServer | null {
  for (const s of LSP_SERVERS) {
    if (!s.languages.some((l) => languagesPresent.has(l))) continue;
    const abs = resolveCommand(s.command);
    if (abs) return { ...s, command: abs };
  }
  return null;
}

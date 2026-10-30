/**
 * Composer autoload (PSR-4) for PHP: which namespace prefix lives in which
 * directory. PHP itself never says where a `use App\Models\User` comes from:
 * the project's `composer.json` does, and every class loaded at runtime goes
 * through that map. Two consumers read it:
 *
 *   - edge resolution inside one repo (`resolve.ts`): a `use` maps to the exact
 *     file autoload would load, and a class outside the repo's own namespaces
 *     stays an external FQCN instead of being guessed onto a same-named local file;
 *   - workspace links (`workspace-links.ts`): an FQCN one child leaves unresolved
 *     is looked up in the namespaces the OTHER children declare.
 *
 * Only `psr-4` is mapped exactly. `classmap` and `psr-0` entries are kept as
 * roots, because a class under them can live anywhere inside: resolution still
 * guesses by suffix there, and only there.
 */
import { readFileSync } from "node:fs";
import { posix } from "node:path";

/** One PSR-4 root: `prefix` ends with `\` (or is "", composer's fallback root),
 * `dir` is posix and relative to the repo root ("" for the root itself). */
export interface Psr4Entry {
  prefix: string;
  dir: string;
}

export interface PhpAutoload {
  /** Longest prefix first, so the most specific namespace wins. */
  psr4: Psr4Entry[];
  /** Repo-relative dirs or files under `classmap`/`psr-0` ("" = the whole repo). */
  otherRoots: string[];
}

interface ComposerAutoload {
  "psr-4"?: Record<string, string | string[]>;
  "psr-0"?: Record<string, string | string[]>;
  classmap?: string[];
}

function strings(v: unknown): string[] {
  if (typeof v === "string") return [v];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Read the autoload maps of the given `composer.json` files. `files` holds
 * `{ abs, dir }` pairs, `dir` being the file's directory relative to the repo
 * root (posix, "" for the root), so a package in a subdirectory maps its own
 * namespaces under that subdirectory. Unreadable or foreign json is skipped. */
export function readComposerAutoload(files: { abs: string; dir: string }[]): PhpAutoload {
  const psr4: Psr4Entry[] = [];
  const otherRoots: string[] = [];
  for (const { abs, dir } of files) {
    let json: { autoload?: ComposerAutoload; "autoload-dev"?: ComposerAutoload };
    try {
      json = JSON.parse(readFileSync(abs, "utf8"));
    } catch {
      continue;
    }
    const at = (t: string) => {
      const joined = posix.normalize(posix.join(dir || ".", t.replace(/\\/g, "/")));
      return joined === "." ? "" : joined.replace(/\/+$/, "");
    };
    // autoload-dev too: test classes are imported by tests exactly like app classes.
    for (const section of [json?.autoload, json?.["autoload-dev"]]) {
      if (!section || typeof section !== "object") continue;
      for (const [prefix, target] of Object.entries(section["psr-4"] ?? {})) {
        for (const t of strings(target)) psr4.push({ prefix: prefix.replace(/^\\+/, ""), dir: at(t) });
      }
      for (const t of strings(section.classmap)) otherRoots.push(at(t));
      for (const target of Object.values(section["psr-0"] ?? {})) for (const t of strings(target)) otherRoots.push(at(t));
    }
  }
  psr4.sort((a, b) => b.prefix.length - a.prefix.length);
  return { psr4, otherRoots };
}

/** The repo-relative files PSR-4 would try for `fqcn`, most specific prefix
 * first. Empty when no prefix covers it. */
export function psr4Paths(fqcn: string, psr4: Psr4Entry[]): string[] {
  const name = fqcn.replace(/^\\+/, "");
  const out: string[] = [];
  for (const { prefix, dir } of psr4) {
    if (!name.startsWith(prefix)) continue;
    const rest = name.slice(prefix.length);
    if (!rest) continue;
    out.push(posix.join(dir, rest.replace(/\\/g, "/") + ".php"));
  }
  return out;
}

/** True when `path` sits under one of the `classmap`/`psr-0` roots. */
export function underOtherRoot(path: string, autoload: PhpAutoload): boolean {
  return autoload.otherRoots.some((r) => r === "" || path === r || path.startsWith(r + "/"));
}

/** An FQCN-shaped edge target: `Vendor\Pkg\Class` (at least one namespace
 * separator). ASCII names only, which is what Composer packages use. */
export function isPhpFqcn(s: string): boolean {
  return /^\\?[A-Za-z_]\w*(\\[A-Za-z_]\w*)+$/.test(s);
}

/**
 * Workspace federation — a "workspace" is a parent directory that holds two or
 * more immediate git-repo children and has no source graph of its own. Instead
 * of one mega-graph pooling every repo, each child keeps its OWN committable
 * `graft/` (byte-identical to building that child standalone), and the parent
 * holds a single `graft/workspace.json` index:
 *
 *   { "version": 1, "children": ["repoA", "repoB"] }
 *
 * Queries run at the parent federate across the children: `ask` fuses every
 * child's ranked hits with `fuseScopes`, reciprocal-rank fusion, so the big
 * repo can't drown the small one. Scopes INSIDE one repo no longer take that
 * path — they share corpus statistics and a normalization denominator, so they
 * are combined by score (see `ask/fuse.ts`). Separate child repositories have
 * no such shared scale, which is exactly the case rank fusion is for.
 * `grep`/`map`/`check`/`callers` run per child and merge, always labeled
 * `<child>/`. `callers` and `grep` also see the edges BETWEEN children, derived
 * from the children's package manifests (`workspace-links.ts`).
 *
 * This module owns the pure/core pieces (the format, its readers/writers, graph
 * loading, and the federated command bodies that return renderable data). The
 * CLI print/exit wrappers and the per-child build orchestration live in
 * `workspace-cli.ts`; `mcp/tools.ts` calls the federate* functions directly.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { contextDirFor } from "../context/node-file.js";
import { checkGraph } from "./check.js";
import { loadGraphCached } from "./load.js";
import { buildRepoMap, formatRepoMap } from "./map.js";
import { discoverWorkspaceChildren } from "./scopes.js";
import {
  callersSavings,
  headerOf,
  hitLine,
  looseNoteFor,
} from "./traverse-cli.js";
import { edgeWalk, resolveSymbol, type Direction, type EdgeHit } from "./traverse.js";
import { wiringPath } from "./write.js";
import type { GraphV1, NodeV1 } from "./types.js";
import { isPhpFqcn } from "./composer.js";
import { crossHits, federatedWalk, httpStats, linkKey, methodStats, resolveFqcn, workspaceLinks } from "./workspace-links.js";
import type { UnlinkedReason } from "./http.js";
import { readWorkspaceOptIn } from "../util/state.js";
import {
  ask,
  type AskHit,
  type AskRankingMetadata,
  type AskResult,
} from "../ask/ask.js";
import {
  fileFirstRoundRobin,
  roundRobinQueues,
} from "../ask/file-selection.js";
import { fuseScopes, STRONG_FLOOR, HIGH_FLOOR, type ScopedDoc } from "../ask/fuse.js";
import { grepGraph, type GrepGroup, type GrepResult } from "../search/grep.js";
import { formatGrepResult, zeroHitNote } from "../search/grep-cli.js";
import { withSavings, type Savings } from "../context/savings.js";
import { cmd } from "../brand.js";

/** The parent index written to `<parent>/graft/workspace.json`. Nodes/edges
 * never live at the parent — they live in each child's own `graft/`. */
export interface WorkspaceV1 {
  version: 1;
  /** Immediate child dir names that are git repos, sorted. */
  children: string[];
}

const WORKSPACE_FILE = "workspace.json";

/** Absolute path to the workspace index for a parent root (`<dir>/graft/workspace.json`). */
export function workspacePath(root: string, override?: string): string {
  return join(contextDirFor(root, override), WORKSPACE_FILE);
}

/** Read the workspace index, or null when the parent has none (not a workspace,
 * or unparseable/foreign json — treated the same as absent). */
export function readWorkspace(root: string, override?: string): WorkspaceV1 | null {
  const path = workspacePath(root, override);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<WorkspaceV1>;
    if (parsed.version !== 1 || !Array.isArray(parsed.children)) return null;
    return { version: 1, children: parsed.children.map(String) };
  } catch {
    return null;
  }
}

/** Write the workspace index, sorting children for a stable, minimal git diff. */
export function writeWorkspace(root: string, ws: WorkspaceV1, override?: string): string {
  const dir = contextDirFor(root, override);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, WORKSPACE_FILE);
  const sorted: WorkspaceV1 = { version: 1, children: [...ws.children].sort() };
  writeFileSync(path, JSON.stringify(sorted, null, 2) + "\n");
  return path;
}

/** A parent is a workspace BUILD target when it has no own `.git` and ≥2 git
 * children — or it was already split (a `workspace.json` is present). The
 * no-own-`.git` guard keeps a normal repo with git submodules from being
 * mistaken for a workspace; a repo that really is a folder of clones with a
 * few files of its own opts in with `graft build --workspace`. */
export function isWorkspaceBuildRoot(root: string, override?: string): boolean {
  if (readWorkspace(root, override)) return true;
  if (existsSync(join(root, ".git")) && !readWorkspaceOptIn(root)) return false;
  return discoverWorkspaceChildren(root).length >= 2;
}

/** True when the parent has a mega-graph from an older single-graph build
 * (`graft/.graph/wiring.json`) — the thing a workspace build migrates away. */
export function hasMegaGraph(root: string, override?: string): boolean {
  return existsSync(wiringPath(contextDirFor(root, override)));
}

/** The EXACT split warning printed once, when a mega-graph parent is first
 * built as a workspace. Templated on the child list so it names the real repos. */
export function migrationNote(children: string[]): string {
  const dirs = children.map((c) => `${c}/graft/`).join(", ");
  return (
    `⚠ this folder contains ${children.length} separate git repos — splitting: ` +
    `each repo now gets its own committable graft/ (${dirs}); the combined graph ` +
    `here is replaced by a workspace index. Queries from here now search all repos, fairly.`
  );
}

/** Remove the parent's entire `graft/` tree — the mega-graph, its `.cache`, and
 * any stale cards — so after `writeWorkspace` the parent holds ONLY
 * workspace.json. Child graphs live in sibling `<child>/graft/`, never under
 * this dir, so they are untouched. */
export function clearParentGraft(root: string, override?: string): void {
  rmSync(contextDirFor(root, override), { recursive: true, force: true });
}

export interface LoadedChild {
  child: string;
  graph: GraphV1;
}

export interface WorkspaceGraphs {
  /** Children (from workspace.json when present, else discovered) that have a
   * built graph, in sorted child order. */
  loaded: LoadedChild[];
  /** Listed children with no built graph yet — surfaced, never silently skipped. */
  missing: string[];
}

/** Load each child's graph via `loadGraphCached`. Children come from
 * workspace.json when present, otherwise from live git-child discovery (a
 * not-yet-built workspace). A child without a built graph is counted into
 * `missing`, not dropped. */
export function loadWorkspaceGraphs(root: string, override?: string): WorkspaceGraphs {
  const ws = readWorkspace(root, override);
  const children = (ws ? ws.children : discoverWorkspaceChildren(root)).slice().sort();
  const loaded: LoadedChild[] = [];
  const missing: string[] = [];
  for (const child of children) {
    const graph = loadGraphCached(contextDirFor(join(root, child)));
    if (graph) loaded.push({ child, graph });
    else missing.push(child);
  }
  return { loaded, missing };
}

/** "2 of 3 workspace repos have graphs; run graft build to cover repoC" — the
 * coverage line federated commands append when some listed child is unbuilt.
 * Empty string when every child has a graph. */
export function coverageNote(g: WorkspaceGraphs): string {
  if (g.missing.length === 0) return "";
  const total = g.loaded.length + g.missing.length;
  return `${g.loaded.length} of ${total} workspace repos have graphs; run ${cmd("graft build")} to cover ${g.missing.join(", ")}`;
}

/** Prefix a hit pointer with its child dir so a `path:span` (or concept path
 * list) opens correctly from the parent. Leaves free-text fragments alone. */
function prefixPointer(child: string, pointer: string): string {
  return pointer
    .split(",")
    .map((part) => {
      const t = part.trim();
      if (!t || t.includes(" ")) return part;
      return `${child}/${t}`;
    })
    .join(", ");
}

/** The exact child-relative file owning a lexical symbol hit. File nodes use a
 * bare path; definition hits append `:Lx-Ly`. */
function hitFile(pointer: string): string {
  return pointer.match(/^(.*):L\d+-L\d+$/)?.[1] ?? pointer;
}

export interface FederateAskOptions {
  limit?: number;
  source?: boolean;
  full?: boolean;
  graphRank?: boolean;
  /** Narrow to one child (`repoA`) or a sub-scope within it (`repoA/backend`).
   * A prefix matching NO child throws, listing the repos. */
  in?: string;
  /** @internal File-level child RRF plus an exact workspace baseline top lock. */
  fileTopLock?: boolean;
}

interface ChildRun {
  child: string;
  hits: AskHit[];
  /** The child's top-hit idf-weighted matched share over name+path+body — a
   * RAW, cross-child-comparable magnitude (NOT per-child normalized). */
  coverage: number;
  /** Same, but over name+path ONLY (body dropped) — the match-STRENGTH signal.
   * A body-only incidental collision has `coverageStrong === 0`. */
  coverageStrong: number;
  /** Exact baseline top-hit coverage used only to compute the workspace top lock. */
  baselineCoverage: number;
  baselineCoverageStrong: number;
  /** Present only for the internal file-aware path. */
  ranking?: AskRankingMetadata;
}

/**
 * The children a workspace-level `--in` reaches, each with the part of the prefix
 * that lies inside it (undefined: the whole child). Children can sit in grouping
 * folders (`platform/bff`), so the prefix is compared segment by segment with the
 * child's path: `platform/bff/app` scopes into one child, `platform` takes every
 * child under it. A prefix that reaches no child is a caller mistake.
 */
function scopeChildren(wg: WorkspaceGraphs, prefix: string): Map<string, string | undefined> {
  const p = prefix.replace(/^\.\/+/, "").replace(/\/+$/, "");
  const out = new Map<string, string | undefined>();
  for (const { child } of wg.loaded) {
    if (p === child || child.startsWith(p + "/")) out.set(child, undefined);
    else if (p.startsWith(child + "/")) out.set(child, p.slice(child.length + 1));
  }
  if (out.size === 0) {
    const all = [...wg.loaded.map((l) => l.child), ...wg.missing].sort();
    throw new Error(`no workspace repo under "${p}" - repos: ${all.join(", ")}`);
  }
  return out;
}

// STRONG_FLOOR / HIGH_FLOOR (a child federates if its top hit matched a
// query term in a NAME/PATH field ≥ STRONG_FLOOR, OR its overall name+path+
// body coverage is broad enough to be real even body-only, ≥ HIGH_FLOOR) are
// defined ONCE in `../ask/fuse.js` and imported here. This is now their only
// caller: a share-of-the-query threshold is the best available signal when the
// candidates carry no common score scale, which is the situation across child
// repositories. `rankScopesAndFuse` used to gate on them for the same reason
// and no longer needs to — within one repo the scores are comparable, so a
// weak scope is held back by scoring low rather than by a strength floor.

/**
 * Federated `ask` across a workspace: run each child's own ask pipeline, then
 * fuse ALL the children's scope lists with `fuseScopes` (reciprocal rank). Each
 * child contributes one fusion scope per intra-child scope, labeled
 * `<child>/<scope>` (or just `<child>` for a child's root scope), so a big repo
 * can't drown a small one — rank positions are comparable across repos where
 * raw scores are not.
 *
 * Rank fusion is still right HERE, and only here: each child was scored against
 * its own corpus, so cross-child scores share no scale. Within a single repo
 * that is no longer true — `rankScopesAndFuse` gives every scope the same
 * statistics and the same denominator and combines them by score.
 *
 * Returns a normal `AskResult`; `formatAsk` renders it unchanged, labeling each
 * hit `[<child>/…]` via the standard multi-scope path.
 */
export function federateAsk(
  root: string,
  override: string | undefined,
  query: string,
  opts: FederateAskOptions = {},
): AskResult {
  const wg = loadWorkspaceGraphs(root, override);
  const limit = opts.limit ?? 8;
  const fileTopLock = opts.fileTopLock ?? true;

  const scoped = opts.in ? scopeChildren(wg, opts.in) : null;
  const onlyChild = scoped?.size === 1;

  // Pass 1: run each child's ask; keep its hits + RAW top-hit coverage.
  const runs: ChildRun[] = [];
  for (const { child } of wg.loaded) {
    if (scoped && !scoped.has(child)) continue;
    const childIn = scoped?.get(child);
    let r: AskResult;
    try {
      // Over-fetch per child so cross-child fusion has enough candidates to
      // rank before the final `limit` slice.
      r = ask(join(root, child), query, {
        limit: Math.max(limit * 4, 20),
        source: opts.source,
        full: opts.full,
        graphRank: opts.graphRank,
        in: childIn,
        // The parent owns the final cross-repo ranking. Selecting inside each
        // child would be undone by fusion and could truncate a hybrid list.
        fileFirst: false,
        fileComplement: fileTopLock,
        includeRankingMetadata: fileTopLock,
      });
    } catch {
      continue; // corrupt child, or a sub-scope --in matching nothing here
    }
    if (r.hits.length === 0) continue;
    const topGroup = r.ranking?.groups[0];
    runs.push({
      child,
      hits: r.hits,
      coverage: topGroup?.coverage ?? r.coverage ?? 0,
      coverageStrong: topGroup?.coverageStrong ?? r.coverageStrong ?? 0,
      baselineCoverage: r.ranking?.baselineCoverage ?? r.coverage ?? 0,
      baselineCoverageStrong:
        r.ranking?.baselineCoverageStrong ?? r.coverageStrong ?? 0,
      ranking: r.ranking,
    });
  }

  // Cross-child participation gate on match STRENGTH, not a lenient ratio.
  // Per-child hit scores are each per-child-normalized (top ~1.0 everywhere),
  // so feeding them to fuseScopes makes its gate vacuous across repos — a junk
  // body-token collision would federate beside another repo's genuine hits.
  // Gate: a child federates iff its top hit matched a query term in a NAME/PATH
  // field (coverageStrong ≥ STRONG_FLOOR — not just an incidental body token)
  // OR its overall coverage is broad enough to be real (≥ HIGH_FLOOR). A
  // body-only collision has coverageStrong 0 and coverage ~0.3 → gated to
  // alsoMatched. Both floors are absolute + scale-invariant (see their docs).
  // The gate is a cross-child FAIRNESS mechanism: it stops a weak body-token
  // collision in one repo from federating beside another repo's genuine hits.
  // An explicit `--in <child>` removes all cross-child competition — the caller
  // has already chosen the scope — so the gate must NOT apply there, or the
  // `also matched: <child> — narrow with --in <child>` hint would lead to an
  // empty result for exactly the weak child it points at. With `onlyChild` set,
  // every run (there is at most one) survives, matching a standalone child ask.
  const gatedOut: { scope: string; bestId: string }[] = [];
  const survivors: ChildRun[] = [];
  const baselineSurvivors: ChildRun[] = [];
  for (const run of runs) {
    const baselineEligible =
      onlyChild ||
      run.baselineCoverageStrong >= STRONG_FLOOR ||
      run.baselineCoverage >= HIGH_FLOOR;
    const fileEligible =
      onlyChild ||
      run.coverageStrong >= STRONG_FLOOR ||
      run.coverage >= HIGH_FLOOR;
    if (baselineEligible) baselineSurvivors.push(run);
    // Distributed file evidence may admit a child, but the exact baseline
    // top lock must never resurrect a child that the final stream calls gated
    // out. The production survivor set is therefore the union of both gates;
    // baselineSurvivors remains the strict baseline subset used only to choose the
    // locked pointer.
    if (baselineEligible || fileEligible) survivors.push(run);
    else {
      const best = run.ranking?.groups[0]?.hits[0] ?? run.hits[0];
      gatedOut.push({ scope: run.child, bestId: prefixPointer(run.child, best.pointer) });
    }
  }

  if (fileTopLock) {
    type WorkspaceGroup = {
      key: string;
      child: string;
      hits: AskHit[];
      baselineHits: AskHit[];
    };
    const qualifyHit = (
      child: string,
      hit: AskHit,
      score = hit.score,
      scope = hit.scope ? `${child}/${hit.scope}` : child,
    ): AskHit => ({
      ...hit,
      score,
      scope,
      pointer: prefixPointer(child, hit.pointer),
    });
    const sameHit = (a: AskHit, b: AskHit): boolean =>
      a.kind === b.kind && a.pointer === b.pointer && a.title === b.title;

    // Baseline workspace stream: reproduce the all-span RRF exactly so the
    // final lock owns the same concrete pointer and fused score as the baseline.
    const baselineDocs: ScopedDoc[] = [];
    const baselineBack = new Map<
      string,
      { child: string; group: string; hit: AskHit }
    >();
    for (const run of baselineSurvivors) {
      const entries = run.ranking?.baseline ?? run.hits.map((hit, index) => ({
        group: `singleton:${index}`,
        hit,
      }));
      entries.forEach((entry, index) => {
        // Keep the legacy id shape so equal-score baseline ties remain exact.
        const id = `${run.child} ${index}`;
        const scope = entry.hit.scope
          ? `${run.child}/${entry.hit.scope}`
          : run.child;
        baselineDocs.push({ id, scope, score: entry.hit.score });
        baselineBack.set(id, {
          child: run.child,
          group: `${run.child}\0${entry.group}`,
          hit: entry.hit,
        });
      });
    }
    const baselineFused = fuseScopes(baselineDocs);
    const baselineTopRanked = baselineFused.ranked[0];
    const baselineTopBack = baselineTopRanked
      ? baselineBack.get(baselineTopRanked.id)
      : undefined;
    const baselineTop = baselineTopRanked && baselineTopBack
      ? qualifyHit(
          baselineTopBack.child,
          baselineTopBack.hit,
          baselineTopRanked.score,
          baselineTopRanked.scope,
        )
      : undefined;

    // File-aware workspace stream: exactly one leader per child/file (concepts stay
    // singleton groups) participates in RRF. Span queues remain in a side map
    // and cannot consume reciprocal-rank positions.
    const fileDocs: ScopedDoc[] = [];
    const fileBack = new Map<string, WorkspaceGroup>();
    for (const run of survivors) {
      const groups = run.ranking?.groups ?? run.hits.map((hit, index) => ({
        key: `singleton:${index}`,
        hits: [hit],
        baselineHits: [hit],
        coverage: 0,
        coverageStrong: 0,
      }));
      groups.forEach((group, index) => {
        const leader = group.hits[0];
        if (!leader) return;
        const id = `${run.child} file ${String(index).padStart(8, "0")}`;
        const scope = leader.scope ? `${run.child}/${leader.scope}` : run.child;
        const key = `${run.child}\0${group.key}`;
        fileDocs.push({ id, scope, score: leader.score });
        fileBack.set(id, {
          key,
          child: run.child,
          hits: group.hits,
          baselineHits: group.baselineHits ?? [leader],
        });
      });
    }
    const fileFused = fuseScopes(fileDocs);
    const rankedGroups: WorkspaceGroup[] = fileFused.ranked.flatMap((ranked) => {
      const group = fileBack.get(ranked.id);
      if (!group) return [];
      return [{
        ...group,
        // These spans are projections of one cross-child file document. Keep
        // their public score on that same RRF scale; child-local tail scores are
        // not comparable after workspace fusion and downstream re-sorting would
        // otherwise silently undo the file ordering.
        hits: group.hits.map((hit) =>
          qualifyHit(
            group.child,
            hit,
            ranked.score,
            hit.scope ? `${group.child}/${hit.scope}` : group.child,
          ),
        ),
        baselineHits: group.baselineHits.map((hit) => qualifyHit(group.child, hit)),
      }];
    });

    let projectedGroups = rankedGroups;
    if (baselineTop && baselineTopBack) {
      const key = baselineTopBack.group;
      const existing = rankedGroups.find((group) => group.key === key);
      const baselineQueue = existing?.baselineHits ?? [baselineTop];
      const projectedScore = existing?.hits[0]?.score ?? baselineTop.score;
      const locked: WorkspaceGroup = existing
        ? {
            ...existing,
            hits: [
              baselineTop,
              ...baselineQueue
                .filter((hit) => !sameHit(hit, baselineTop))
                .map((hit) => ({ ...hit, score: projectedScore })),
            ],
          }
        : {
            key,
            child: baselineTopBack.child,
            hits: [baselineTop],
            baselineHits: [baselineTop],
          };
      projectedGroups = [
        locked,
        ...rankedGroups.filter((group) => group.key !== key),
      ];
    }

    const hits = roundRobinQueues(
      projectedGroups.map((group) => group.hits),
      limit,
    );
    const unmatched = [...fileFused.alsoMatched, ...gatedOut];
    const note = coverageNote(wg);
    const result: AskResult = {
      query,
      mode: hits.length ? "lexical" : "empty",
      hits,
    };
    if (hits.length) {
      const lockedScope = baselineTop?.scope;
      const federated = [
        ...new Set([
          ...(lockedScope ? [lockedScope] : []),
          ...fileFused.federated,
        ]),
      ];
      const federatedSet = new Set(federated);
      result.scopes = {
        federated,
        alsoMatched: unmatched.filter((match) => !federatedSet.has(match.scope)),
      };
    } else {
      result.note = `no matching nodes across ${wg.loaded.length} workspace repo(s) — try different words, or \`${cmd("graft build")}\` at a child`;
    }
    if (note) result.note = result.note ? `${result.note}\n${note}` : note;
    return result;
  }

  // Fuse the survivors' scope lists (within-child fusion is left untouched —
  // each child already ran its own per-scope RRF).
  const docs: ScopedDoc[] = [];
  const back = new Map<string, { child: string; hit: AskHit }>();
  for (const { child, hits } of survivors) {
    hits.forEach((hit, i) => {
      const scope = hit.scope ? `${child}/${hit.scope}` : child;
      const id = `${child} ${i}`;
      docs.push({ id, scope, score: hit.score });
      back.set(id, { child, hit });
    });
  }

  const fused = fuseScopes(docs);
  const rankedHits = fused.ranked.map((rd) => {
    const { child, hit } = back.get(rd.id)!;
    const value: AskHit = {
      ...hit,
      score: rd.score,
      scope: rd.scope,
      pointer: prefixPointer(child, hit.pointer),
    };
    return {
      // Lexical symbols share a file queue. Concepts and structural neighbours
      // remain singleton partitions, so this lexical selection layer cannot
      // reorder `who calls` / `dependencies of` answers.
      group: hit.kind === "symbol"
        ? `file:${child}/${hitFile(hit.pointer)}`
        : `singleton:${child}:${rd.id}`,
      value,
    };
  });
  const hits = fileFirstRoundRobin(rankedHits, limit);

  const alsoMatched = [...fused.alsoMatched, ...gatedOut];
  const note = coverageNote(wg);
  const result: AskResult = { query, mode: hits.length ? "lexical" : "empty", hits };
  if (hits.length) {
    const federated = fused.federated.length ? fused.federated : [...new Set(hits.map((h) => h.scope!))];
    result.scopes = { federated, alsoMatched };
  } else {
    result.note = `no matching nodes across ${wg.loaded.length} workspace repo(s) — try different words, or \`${cmd("graft build")}\` at a child`;
  }
  if (note) result.note = result.note ? `${result.note}\n${note}` : note;
  return result;
}

/** Merge every child's `GrepResult` into one, prefixing group paths with the
 * child dir and re-sorting by coupling (inDegree desc, path asc) across repos.
 * In-degree is each child's own plus the cross-repo links landing on the symbol
 * (`workspace-links.ts`). */
export function federateGrep(
  root: string,
  override: string | undefined,
  pattern: string,
  opts: { ignoreCase?: boolean; fixed?: boolean; in?: string } = {},
): { result: GrepResult; coverage: string } {
  const wg = loadWorkspaceGraphs(root, override);
  const scoped = opts.in ? scopeChildren(wg, opts.in) : null;
  const links = workspaceLinks(root, wg.loaded);
  const groups: GrepGroup[] = [];
  let filesSearched = 0;
  let totalHits = 0;
  const truncated = { files: 0, hits: 0 };
  let savedFiles = 0;
  let savedChars = 0;

  for (const { child, graph } of wg.loaded) {
    if (scoped && !scoped.has(child)) continue;
    const r = grepGraph(graph, join(root, child), pattern, {
      ignoreCase: opts.ignoreCase,
      fixed: opts.fixed,
      in: scoped?.get(child),
    });
    filesSearched += r.filesSearched;
    totalHits += r.totalHits;
    truncated.files += r.truncated.files;
    truncated.hits += r.truncated.hits;
    if (r.saved) {
      savedFiles += r.saved.files;
      savedChars += r.saved.baselineChars;
    }
    for (const g of r.groups) {
      // Coupling counts what other repos point at the symbol too.
      const cross = g.symbol ? (links.into.get(linkKey(child, g.symbol.id))?.length ?? 0) : 0;
      groups.push({
        ...g,
        inDegree: g.inDegree + cross,
        path: `${child}/${g.path}`,
        symbol: g.symbol ? { ...g.symbol, path: `${child}/${g.symbol.path}` } : null,
      });
    }
  }

  groups.sort((a, b) => b.inDegree - a.inDegree || a.path.localeCompare(b.path));
  const saved: Savings | undefined = savedChars > 0 ? { files: savedFiles, baselineChars: savedChars } : undefined;
  const result: GrepResult = { pattern, filesSearched, totalHits, groups, truncated, saved };
  return { result, coverage: coverageNote(wg) };
}

/** One end of a link between repos: the node as its own repo names it. `symbol`
 * is the part of the id after `#`, null for a file node. */
export interface LinkEnd {
  repo: string;
  symbol: string | null;
  path: string;
  span: string | null;
}

export interface WorkspaceLinksReport {
  links: { via: "use" | "method" | "http"; from: LinkEnd; to: LinkEnd }[];
  /** HTTP requests that reached no single handler in another repo. */
  unlinked: { repo: string; symbol: string | null; method: string | null; path: string; line: number; reason: UnlinkedReason }[];
}

/**
 * Every edge between the workspace's repos (Composer `use`, typed method call,
 * HTTP route) with both ends, and the HTTP requests left unlinked with the reason:
 * the raw material for checks that span repos, which `callers` shows only one
 * symbol at a time. `from`/`to` keep repos at or under a path prefix, `via` one kind.
 */
export function federateLinks(
  root: string,
  override: string | undefined,
  opts: { from?: string; to?: string; via?: "use" | "method" | "http" } = {},
): WorkspaceLinksReport {
  const wg = loadWorkspaceGraphs(root, override);
  const graphs = new Map(wg.loaded.map((c) => [c.child, c.graph]));
  const under = (prefix: string | undefined, repo: string) => {
    if (!prefix) return true;
    const p = prefix.replace(/^\.\/+/, "").replace(/\/+$/, "");
    return repo === p || repo.startsWith(p + "/");
  };
  const end = (repo: string, id: string): LinkEnd => {
    const node = graphs.get(repo)?.nodes.find((n) => n.id === id);
    const hash = id.indexOf("#");
    return {
      repo,
      symbol: hash >= 0 ? id.slice(hash + 1) : null,
      path: node?.path ?? (hash >= 0 ? id.slice(0, hash) : id),
      span: node && node.kind !== "file" ? node.span : null,
    };
  };
  const links = workspaceLinks(root, wg.loaded)
    .links.filter((l) => (!opts.via || l.via === opts.via) && under(opts.from, l.fromChild) && under(opts.to, l.toChild))
    .map((l) => ({ via: l.via, from: end(l.fromChild, l.sourceId), to: end(l.toChild, l.targetId) }));
  const unlinked = httpStats(root, wg.loaded)
    .unlinked.filter((u) => under(opts.from, u.fromChild))
    .map((u) => {
      const at = end(u.fromChild, u.call.source);
      return { repo: u.fromChild, symbol: at.symbol, method: u.call.method, path: u.call.path, line: u.call.line, reason: u.reason };
    });
  return { links, unlinked };
}

/** Links between repos counted per pair, one line each: `from -> to: N (use a, method b, http c)`. */
export function formatLinksByPair(report: WorkspaceLinksReport): string {
  const pairs = new Map<string, { use: number; method: number; http: number }>();
  for (const l of report.links) {
    const key = `${l.from.repo} -> ${l.to.repo}`;
    const c = pairs.get(key) ?? { use: 0, method: 0, http: 0 };
    c[l.via]++;
    pairs.set(key, c);
  }
  const lines = [...pairs.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, c]) => `${k}: ${c.use + c.method + c.http} (use ${c.use}, method ${c.method}, http ${c.http})`);
  const reasons = new Map<string, number>();
  for (const u of report.unlinked) reasons.set(u.reason, (reasons.get(u.reason) ?? 0) + 1);
  if (report.unlinked.length) {
    lines.push(`unlinked HTTP requests: ${report.unlinked.length} (${[...reasons].map(([r, n]) => `${r} ${n}`).join(", ")})`);
  }
  return lines.join("\n") + "\n";
}

/** One `graft map` section per child (each child's own map, budget split evenly
 * across the loaded children), joined under `<child>/` headers. */
export function federateMap(
  root: string,
  override: string | undefined,
  opts: { maxDirs?: number } = {},
): string {
  const wg = loadWorkspaceGraphs(root, override);
  const perChild = opts.maxDirs !== undefined && wg.loaded.length > 0
    ? Math.max(1, Math.floor(opts.maxDirs / wg.loaded.length))
    : undefined;

  const sections = wg.loaded.map(({ child, graph }) => {
    const map = buildRepoMap(graph, perChild !== undefined ? { maxDirs: perChild } : {});
    return `## ${child}/\n${formatRepoMap(map).trimEnd()}`;
  });
  const head = `workspace map — ${wg.loaded.length} repo(s)`;
  const parts = [head, "", sections.join("\n\n")];
  const links = linksNote(root, wg.loaded);
  if (links) parts.push("", links);
  const cov = coverageNote(wg);
  if (cov) parts.push("", cov);
  return parts.join("\n") + "\n";
}

const AMBIGUOUS_SHOWN = 5;

/** What the edges between repos amount to, and the HTTP requests that found no
 * single handler. Null when the workspace has neither kind. */
function linksNote(root: string, loaded: LoadedChild[]): string | null {
  const { links } = workspaceLinks(root, loaded);
  const s = httpStats(root, loaded);
  const m = methodStats(root, loaded);
  if (links.length === 0 && s.calls === 0 && m.calls === 0) return null;
  const count = (via: string) => links.filter((l) => l.via === via).length;
  const lines = [
    `links between repos: ${count("use")} by Composer use, ${count("method")} by method call, ${count("http")} by HTTP route ` +
      `(of ${s.calls} requests: ${s.ambiguous.length} ambiguous, ${s.verbMismatch} verb mismatch, ` +
      `${s.noHandler} closure or unresolved handler, ${s.unmatched} no route in another repo)`,
  ];
  if (m.calls) {
    lines.push(
      `  distinct method calls leaving their repo: ${m.calls} (${m.linked} linked, ${m.inRepo} back in their own repo, ` +
        `${m.external} to a class outside the workspace, ${m.untyped} stopped at an untyped step, ` +
        `${m.noMethod} no such method, ${m.ambiguous} ambiguous)`,
    );
  }
  for (const a of s.ambiguous.slice(0, AMBIGUOUS_SHOWN)) {
    lines.push(`  ambiguous: ${a.call.method ?? "ANY"} /${a.call.path} from ${a.fromChild}/${a.call.source} → ${a.candidates.join(", ")}`);
  }
  if (s.ambiguous.length > AMBIGUOUS_SHOWN) lines.push(`  … ${s.ambiguous.length - AMBIGUOUS_SHOWN} more ambiguous`);
  return lines.join("\n");
}

/** Per-child drift status. `ok` is false when any BUILT child is stale — an
 * unbuilt child is surfaced (coverage), never a failure. */
export async function federateCheck(
  root: string,
  override?: string,
): Promise<{ text: string; ok: boolean }> {
  const wg = loadWorkspaceGraphs(root, override);
  const lines = [`workspace check — ${wg.loaded.length + wg.missing.length} repo(s)`, ""];
  let ok = true;
  for (const { child } of wg.loaded) {
    const g = await checkGraph(join(root, child));
    if (g.ok) {
      lines.push(`${child}/: OK`);
    } else {
      ok = false;
      const bits: string[] = [];
      if (g.added.length) bits.push(`${g.added.length} added`);
      if (g.removed.length) bits.push(`${g.removed.length} removed`);
      if (g.changed.length) bits.push(`${g.changed.length} changed`);
      if (g.stale.length) bits.push(`${g.stale.length} stale`);
      lines.push(`${child}/: STALE (${bits.join(", ")})`);
    }
  }
  for (const child of wg.missing) lines.push(`${child}/: not built (run ${cmd("graft build")})`);
  const cov = coverageNote(wg);
  if (cov) lines.push("", cov);
  return { text: lines.join("\n") + "\n", ok };
}

/** Resolve a symbol across every child, grouped per child. Reuses the shared
 * traverse-cli formatters so each block reads exactly like `graft callers`. */
export function federateCallers(
  root: string,
  override: string | undefined,
  symbol: string,
  opts: { direction?: Direction; depth?: number; in?: string } = {},
): { text: string; found: boolean } {
  const wg = loadWorkspaceGraphs(root, override);
  const direction: Direction = opts.direction ?? "in";
  const depth = opts.depth && opts.depth >= 1 ? Math.floor(opts.depth) : 1;
  const showDepth = depth > 1;

  const links = workspaceLinks(root, wg.loaded);
  const graphs = new Map(wg.loaded.map((c) => [c.child, c.graph]));
  // A PHP FQCN names one class through the children's PSR-4 maps; the bare
  // resolver would only ever see its last segment.
  const fqcn = isPhpFqcn(symbol);
  const byFqcn = fqcn ? resolveFqcn(root, wg.loaded, symbol) : [];
  const query = fqcn && byFqcn.length === 0 ? symbol.slice(symbol.lastIndexOf("\\") + 1) : symbol;
  const walk = (child: string, graph: GraphV1, m: NodeV1): EdgeHit[] => {
    if (depth > 1) return federatedWalk(graphs, links, child, m, direction, depth);
    const cross = crossHits(graphs, links, child, m, direction);
    const local = edgeWalk(graph, m, direction, depth).filter((h) => h.node || !cross.replaces.has(h.id));
    return [...local, ...cross.hits];
  };

  const scoped = opts.in ? scopeChildren(wg, opts.in) : null;
  const blocks: string[] = [];
  let found = false;
  for (const { child, graph } of wg.loaded) {
    if (scoped && !scoped.has(child)) continue;
    const childIn = scoped?.get(child);
    const matches = byFqcn.length
      ? byFqcn.filter((f) => f.child === child).map((f) => f.node)
      : resolveSymbol(graph, query, childIn ? { in: childIn } : {});
    if (matches.length === 0) continue;
    found = true;
    const results = matches.map((m) => ({ symbol: m, hits: walk(child, graph, m) }));
    const lines = [`## ${child}/`];
    for (const { symbol: sym, hits } of results) {
      lines.push(headerOf(sym));
      if (hits.length === 0) lines.push(looseNoteFor(direction, sym.name, matches.length));
      else for (const h of hits) lines.push(hitLine(direction, h, showDepth));
    }
    const body = lines.join("\n");
    blocks.push(withSavings(body, callersSavings(graph, results)));
  }

  const cov = coverageNote(wg);
  if (!found) {
    const base = `no symbol "${symbol}" in any of the ${wg.loaded.length} workspace repo(s) — check spelling or run ${cmd("graft build")}`;
    return { text: cov ? `${base}\n${cov}` : base, found: false };
  }
  let text = blocks.join("\n\n");
  if (cov) text += `\n\n${cov}`;
  return { text, found: true };
}

/**
 * Split a parent into a workspace: build each git child (via the supplied
 * `buildChild` callback, so this stays free of any engine/LLM dependency),
 * then REPLACE the parent's `graft/` with just `workspace.json`. `onStart`
 * fires once — before any child is built — carrying whether this build is a
 * mega-graph migration, so the caller can print the one-time split warning
 * first, exactly as the spec requires.
 *
 * The child build writes into `<child>/graft/` and is byte-identical to
 * building that child standalone (`buildChild` is just `buildGraph(childDir)`),
 * because nothing about the parent path enters the child's build.
 */
export async function splitWorkspace(
  root: string,
  override: string | undefined,
  buildChild: (childDir: string, childName: string) => Promise<void>,
  onStart?: (info: { children: string[]; migrated: boolean }) => void,
): Promise<{ children: string[]; migrated: boolean }> {
  const children = discoverWorkspaceChildren(root).slice().sort();
  const migrated = hasMegaGraph(root, override);
  onStart?.({ children, migrated });
  for (const child of children) await buildChild(join(root, child), child);
  clearParentGraft(root, override); // drop the mega-graph/.cache/cards…
  writeWorkspace(root, { version: 1, children }, override); // …leaving ONLY workspace.json
  return { children, migrated };
}

export { formatGrepResult, zeroHitNote };

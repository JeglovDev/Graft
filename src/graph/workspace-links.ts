/**
 * Cross-repo links for a workspace: the edges that leave one child repo and land
 * in another. Each child graph is built standalone, so a service's
 * `use Vendor\Sdk\Client;` stays an unresolved FQCN target in its own graph. At
 * the workspace level the SDK's `composer.json` says where that namespace lives,
 * which turns the string back into the SDK's class node.
 *
 * Links are derived, never stored: they are a pure function of the child graphs
 * and their `composer.json` files, so recomputing on load (memoized on the
 * loaded graph objects, which `loadGraphCached` swaps on every rebuild or
 * pre-query refresh) can never go stale the way a persisted links file would.
 * On a 37-repo workspace it costs ~90 ms cold, next to ~350 ms to load the graphs.
 *
 * Two kinds, both PHP for now; the link shape is language-neutral:
 *   - Composer PSR-4: an FQCN one child leaves unresolved, to the class another defines;
 *   - HTTP (`http.ts`): a client method sending a request, to the route handler of the
 *     one other child that serves its path, relation `http`.
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import { isPhpFqcn, psr4Paths, readComposerAutoload, type PhpAutoload } from "./composer.js";
import { matchHttp, type HttpMatchStats } from "./http.js";
import { WALK_RELATIONS } from "./relations.js";
import { scopesOfGraph } from "./scopes.js";
import type { Direction, EdgeHit } from "./traverse.js";
import type { GraphV1, Kind, NodeV1, Relation } from "./types.js";

/** One edge from a node in `fromChild` to a node in `toChild`. `rawTarget` is the
 * edge's target as the source child's graph holds it (the FQCN, or the bare base
 * name of an `extends`), so a walk can swap that dangling hit for the real node. */
export interface CrossLink {
  fromChild: string;
  sourceId: string;
  relation: Relation;
  rawTarget: string;
  toChild: string;
  targetId: string;
}

export interface LinkIndex {
  links: CrossLink[];
  /** `child\0nodeId` → links landing on that node. */
  into: Map<string, CrossLink[]>;
  /** `child\0nodeId` → links leaving that node. */
  outOf: Map<string, CrossLink[]>;
}

interface Child {
  child: string;
  graph: GraphV1;
}

const TYPE_KINDS: ReadonlySet<Kind> = new Set<Kind>(["class", "interface", "trait", "enum"]);

export function linkKey(child: string, id: string): string {
  return `${child}\0${id}`;
}

/** `composer.json` at the child root plus every scope the build found one in. */
function composerFiles(root: string, { child, graph }: Child): { abs: string; dir: string }[] {
  const dirs = new Set([""]);
  for (const s of scopesOfGraph(graph)) if (s.markers.includes("composer.json")) dirs.add(s.label);
  return [...dirs].map((dir) => ({ abs: join(root, child, dir, "composer.json"), dir }));
}

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return -1;
  }
}

/** Nodes by path, per graph: the lookup a PSR-4 path is matched against. */
const byPathCache = new WeakMap<GraphV1, Map<string, NodeV1[]>>();
function nodesByPath(graph: GraphV1): Map<string, NodeV1[]> {
  let m = byPathCache.get(graph);
  if (m) return m;
  m = new Map();
  for (const n of graph.nodes) {
    const arr = m.get(n.path);
    if (arr) arr.push(n);
    else m.set(n.path, [n]);
  }
  byPathCache.set(graph, m);
  return m;
}

/** The node an FQCN names inside one child: the class/interface/trait/enum of
 * that name in the PSR-4 file, else the file itself. */
function nodeForFqcn(fqcn: string, autoload: PhpAutoload, graph: GraphV1): NodeV1 | null {
  const name = fqcn.slice(fqcn.lastIndexOf("\\") + 1);
  for (const path of psr4Paths(fqcn, autoload.psr4)) {
    const nodes = nodesByPath(graph).get(path);
    if (!nodes) continue;
    return nodes.find((n) => TYPE_KINDS.has(n.kind) && n.name === name) ?? nodes.find((n) => n.kind === "file") ?? null;
  }
  return null;
}

/** Compute every cross-repo link. An FQCN resolves only when exactly one OTHER
 * child defines it, and never when the source child's own namespaces cover it
 * (an `App\…` class missing from one Laravel app is not the next app's class). */
export function computeLinks(root: string, children: Child[]): CrossLink[] {
  const autoloads = new Map(children.map((c) => [c.child, readComposerAutoload(composerFiles(root, c))]));
  const owners = new Map<string, { child: string; node: NodeV1 }[]>();
  const ownersOf = (fqcn: string) => {
    let hit = owners.get(fqcn);
    if (hit) return hit;
    hit = [];
    for (const { child, graph } of children) {
      const node = nodeForFqcn(fqcn, autoloads.get(child)!, graph);
      if (node) hit.push({ child, node });
    }
    owners.set(fqcn, hit);
    return hit;
  };

  const links: CrossLink[] = [];
  for (const { child, graph } of children) {
    const own = autoloads.get(child)!.psr4.filter((e) => e.prefix !== "");
    // A bare `extends Client` names whatever the file imported as `Client`.
    const imported = new Map<string, Map<string, string>>();
    for (const e of graph.edges) {
      if (e.relation !== "imports" || !isPhpFqcn(e.target)) continue;
      const fqcn = e.target.replace(/^\\+/, "");
      let m = imported.get(e.source);
      if (!m) imported.set(e.source, (m = new Map()));
      m.set(fqcn.slice(fqcn.lastIndexOf("\\") + 1), fqcn);
    }
    for (const e of graph.edges) {
      if (!WALK_RELATIONS.has(e.relation)) continue;
      let fqcn: string | undefined;
      if (isPhpFqcn(e.target)) fqcn = e.target.replace(/^\\+/, "");
      else if ((e.relation === "extends" || e.relation === "implements") && /^\w+$/.test(e.target)) {
        fqcn = imported.get(e.source.split("#")[0])?.get(e.target);
      }
      if (!fqcn || own.some((p) => fqcn!.startsWith(p.prefix))) continue;
      const elsewhere = ownersOf(fqcn).filter((o) => o.child !== child);
      if (elsewhere.length !== 1) continue; // unknown here, or ambiguous between repos
      const [{ child: toChild, node }] = elsewhere;
      links.push({ fromChild: child, sourceId: e.source, relation: e.relation, rawTarget: e.target, toChild, targetId: node.id });
    }
  }
  return links;
}

/** HTTP links: a client call in one child to the route handler of the one other
 * child that serves its path (`http.ts`). `rawTarget` is the request itself, which
 * no edge of the source graph targets, so a walk out replaces nothing. */
function httpLinks(children: Child[]): { links: CrossLink[]; stats: HttpMatchStats } {
  const { matches, stats } = matchHttp(children.map((c) => ({ child: c.child, http: c.graph.http })));
  const links = matches.map((m) => ({
    fromChild: m.fromChild,
    sourceId: m.call.source,
    relation: "http" as const,
    rawTarget: `${m.call.method ?? "ANY"} /${m.call.path}`,
    toChild: m.toChild,
    targetId: m.endpoint.handler!,
  }));
  return { links, stats };
}

interface Memo {
  graphs: GraphV1[];
  stamp: string;
  index: LinkIndex;
  http: HttpMatchStats;
}

let memo: Memo | null = null;

function memoized(root: string, children: Child[]): Memo {
  const stamp =
    root + "\n" + children.map((c) => `${c.child}:${composerFiles(root, c).map((f) => mtimeOf(f.abs)).join(",")}`).join("\n");
  if (
    memo &&
    memo.stamp === stamp &&
    memo.graphs.length === children.length &&
    memo.graphs.every((g, i) => g === children[i]!.graph)
  ) {
    return memo;
  }
  const http = httpLinks(children);
  const links = [...computeLinks(root, children), ...http.links];
  const into = new Map<string, CrossLink[]>();
  const outOf = new Map<string, CrossLink[]>();
  const push = (m: Map<string, CrossLink[]>, k: string, l: CrossLink) => {
    const arr = m.get(k);
    if (arr) arr.push(l);
    else m.set(k, [l]);
  };
  for (const l of links) {
    push(into, linkKey(l.toChild, l.targetId), l);
    push(outOf, linkKey(l.fromChild, l.sourceId), l);
  }
  memo = { graphs: children.map((c) => c.graph), stamp, index: { links, into, outOf }, http: http.stats };
  return memo;
}

/** The workspace's link index (Composer and HTTP), recomputed only when a child
 * graph object or a `composer.json` changed since the last call in this process. */
export function workspaceLinks(root: string, children: Child[]): LinkIndex {
  return memoized(root, children).index;
}

/** How the workspace's HTTP client calls matched: linked, ambiguous between repos
 * (listed), verb mismatch, handler unresolved, unmatched. */
export function httpStats(root: string, children: Child[]): HttpMatchStats {
  return memoized(root, children).http;
}

/** Every child node an FQCN query names, via the children's PSR-4 maps. */
export function resolveFqcn(root: string, children: Child[], fqcn: string): { child: string; node: NodeV1 }[] {
  const out: { child: string; node: NodeV1 }[] = [];
  for (const c of children) {
    const node = nodeForFqcn(fqcn.replace(/^\\+/, ""), readComposerAutoload(composerFiles(root, c)), c.graph);
    if (node) out.push({ child: c.child, node });
  }
  return out;
}

const byIdCache = new WeakMap<GraphV1, Map<string, NodeV1>>();
function nodeById(graph: GraphV1, id: string): NodeV1 | undefined {
  let m = byIdCache.get(graph);
  if (!m) byIdCache.set(graph, (m = new Map(graph.nodes.map((n) => [n.id, n]))));
  return m.get(id);
}

/** A hit in `child`, rendered from the point of view of `home`: a node from
 * another repo carries that repo's dir on its path, like every federated result. */
function hitIn(graphs: Map<string, GraphV1>, home: string, child: string, id: string, relation: Relation, depth: number): EdgeHit {
  const node = nodeById(graphs.get(child)!, id) ?? null;
  if (child === home) return { node, id, relation, depth };
  return { node: node && { ...node, path: `${child}/${node.path}` }, id: `${child}/${id}`, relation, depth };
}

/** Depth-1 cross-repo neighbours of `node`, and for `out` the raw targets they
 * replace (the dangling FQCN hit the child graph alone would show). */
export function crossHits(
  graphs: Map<string, GraphV1>,
  index: LinkIndex,
  child: string,
  node: NodeV1,
  direction: Direction,
): { hits: EdgeHit[]; replaces: Set<string> } {
  const links = (direction === "in" ? index.into : index.outOf).get(linkKey(child, node.id)) ?? [];
  const hits = links.map((l) =>
    direction === "in"
      ? hitIn(graphs, child, l.fromChild, l.sourceId, l.relation, 1)
      : hitIn(graphs, child, l.toChild, l.targetId, l.relation, 1),
  );
  return { hits, replaces: new Set(direction === "out" ? links.map((l) => l.rawTarget) : []) };
}

/**
 * BFS over walk-relation edges across repos: inside a child it follows that
 * child's edges exactly like `impactOfMany`, and at a link it steps into the
 * other repo and keeps walking there. With no links it returns what
 * `edgeWalk` returns for depth > 1 (same order, same dedup).
 */
export function federatedWalk(
  graphs: Map<string, GraphV1>,
  index: LinkIndex,
  child: string,
  node: NodeV1,
  direction: Direction,
  maxDepth: number,
): EdgeHit[] {
  const adjCache = new Map<string, Map<string, { other: string; relation: Relation }[]>>();
  const adjOf = (c: string) => {
    let adj = adjCache.get(c);
    if (adj) return adj;
    adj = new Map();
    for (const e of graphs.get(c)!.edges) {
      if (!WALK_RELATIONS.has(e.relation)) continue;
      const key = direction === "in" ? e.target : e.source;
      const entry = { other: direction === "in" ? e.source : e.target, relation: e.relation };
      const arr = adj.get(key);
      if (arr) arr.push(entry);
      else adj.set(key, [entry]);
    }
    adjCache.set(c, adj);
    return adj;
  };

  // A file seed walks with the symbols it defines, as `impactOfFile` does.
  const seeds =
    node.kind === "file"
      ? [node, ...graphs.get(child)!.nodes.filter((n) => n.kind !== "file" && n.path === node.path)]
      : [node];
  const visited = new Set(seeds.map((s) => linkKey(child, s.id)));
  let frontier = seeds.map((s) => ({ child, id: s.id }));
  const hits: EdgeHit[] = [];
  const visit = (c: string, id: string, relation: Relation, depth: number, next: { child: string; id: string }[]) => {
    const k = linkKey(c, id);
    if (visited.has(k)) return;
    visited.add(k);
    hits.push(hitIn(graphs, child, c, id, relation, depth));
    next.push({ child: c, id });
  };

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: { child: string; id: string }[] = [];
    for (const cur of frontier) {
      const links = (direction === "in" ? index.into : index.outOf).get(linkKey(cur.child, cur.id)) ?? [];
      const replaced = direction === "out" ? new Set(links.map((l) => l.rawTarget)) : null;
      for (const { other, relation } of adjOf(cur.child).get(cur.id) ?? []) {
        if (replaced?.has(other)) continue;
        visit(cur.child, other, relation, depth, next);
      }
      for (const l of links) {
        if (direction === "in") visit(l.fromChild, l.sourceId, l.relation, depth, next);
        else visit(l.toChild, l.targetId, l.relation, depth, next);
      }
      // A call from another repo is never resolved to the method itself, only to its
      // class (the `use` that imports it), so a method's callers continue there.
      if (direction === "in") {
        for (const l of foreignUsersOfOwner(graphs, index, cur.child, cur.id)) visit(l.fromChild, l.sourceId, l.relation, depth, next);
      }
    }
    frontier = next;
  }
  return hits;
}

/** Links from other repos into the class that owns method `id`. */
function foreignUsersOfOwner(graphs: Map<string, GraphV1>, index: LinkIndex, child: string, id: string): CrossLink[] {
  const graph = graphs.get(child)!;
  if (nodeById(graph, id)?.kind !== "method") return [];
  const owner = id.replace(/\.[^.#]+$/, "");
  if (owner === id || !nodeById(graph, owner)) return [];
  return (index.into.get(linkKey(child, owner)) ?? []).filter((l) => l.fromChild !== child);
}

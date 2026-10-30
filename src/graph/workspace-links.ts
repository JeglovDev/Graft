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
 * Three kinds, all PHP for now; the link shape is language-neutral:
 *   - Composer PSR-4: an FQCN one child leaves unresolved, to the class another defines;
 *   - method calls (`php-calls.ts`): a member call whose receiver chain types statically
 *     to a class of another child, to that class's method, relation `calls`;
 *   - HTTP (`http.ts`): a client method sending a request, to the route handler of the
 *     one other child that serves its path, relation `http`.
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import { isPhpFqcn, psr4Paths, readComposerAutoload, type PhpAutoload } from "./composer.js";
import { matchHttp, type HttpMatchStats } from "./http.js";
import { methodIndex, resolveChain, type ChainResult, type ClassRef, type PhpWorld } from "./php-calls.js";
import { WALK_RELATIONS } from "./relations.js";
import { scopesOfGraph } from "./scopes.js";
import type { Direction, EdgeHit } from "./traverse.js";
import type { GraphV1, Kind, NodeV1, PhpCallFactV1, PhpClassFactV1, Relation } from "./types.js";

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
  /** Which evidence made the link: a Composer `use`/`extends`, a typed method call, an HTTP route. */
  via: "use" | "method" | "http";
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

/** How the workspace's PHP member calls that leave their repo resolved: linked to
 * a method of another repo, back in their own repo, or stopped (why). A call is
 * counted once per caller and chain, however many times the caller makes it. */
export interface MethodCallStats {
  calls: number;
  linked: number;
  inRepo: number;
  /** The chain reached a class no repo of the workspace defines (framework, vendor). */
  external: number;
  /** Two classes for one FQCN, two methods for one name, two bindings for one key. */
  ambiguous: number;
  /** A step's method or property has no class type. */
  untyped: number;
  /** The class has no such method (magic `__call`, a docblock with no node). */
  noMethod: number;
}

export interface MethodOutcome {
  fromChild: string;
  call: PhpCallFactV1;
  result: ChainResult;
}

const methodIndexCache = new WeakMap<GraphV1, Map<string, Map<string, string[]>>>();
function methodsOf(graph: GraphV1): Map<string, Map<string, string[]>> {
  let m = methodIndexCache.get(graph);
  if (!m) methodIndexCache.set(graph, (m = methodIndex(graph.nodes, graph.edges)));
  return m;
}

/**
 * Method-level links: each PHP call a child kept because its chain leaves the child
 * (`php-calls.ts`) continues through the classes, facades and container bindings of
 * the whole workspace, and becomes a `calls` link when it ends on one method node of
 * another child. Classes are found the way `computeLinks` finds them, through PSR-4,
 * the source child's own copy first and never another child's copy of a namespace
 * the source child declares itself.
 */
export function computeMethodLinks(
  root: string,
  children: Child[],
  autoloads = new Map(children.map((c) => [c.child, readComposerAutoload(composerFiles(root, c))])),
): { links: CrossLink[]; stats: MethodCallStats; outcomes: MethodOutcome[] } {
  const stats: MethodCallStats = { calls: 0, linked: 0, inRepo: 0, external: 0, ambiguous: 0, untyped: 0, noMethod: 0 };
  const outcomes: MethodOutcome[] = [];
  const links: CrossLink[] = [];
  if (!children.some((c) => c.graph.php?.calls.length)) return { links, stats, outcomes };

  const graphs = new Map(children.map((c) => [c.child, c.graph]));
  const facts = new Map<string, Map<string, PhpClassFactV1>>();
  const binds = new Map<string, Map<string, Set<string>>>(); // key → child → classes
  for (const { child, graph } of children) {
    facts.set(child, new Map((graph.php?.classes ?? []).map((f) => [f.id, f])));
    for (const b of graph.php?.binds ?? []) {
      let byChild = binds.get(b.k);
      if (!byChild) binds.set(b.k, (byChild = new Map()));
      const s = byChild.get(child) ?? new Set<string>();
      s.add(b.t);
      byChild.set(child, s);
    }
  }
  const owners = new Map<string, ClassRef[]>();
  const ownersOf = (fqcn: string): ClassRef[] => {
    let hit = owners.get(fqcn);
    if (hit) return hit;
    hit = [];
    for (const { child, graph } of children) {
      const node = nodeForFqcn(fqcn, autoloads.get(child)!, graph);
      if (node && TYPE_KINDS.has(node.kind)) hit.push({ child, id: node.id, fact: facts.get(child)!.get(node.id) });
    }
    owners.set(fqcn, hit);
    return hit;
  };
  const one = (s: Set<string> | undefined): string | "ambiguous" | null => (!s ? null : s.size === 1 ? [...s][0]! : "ambiguous");

  const seen = new Set<string>();
  for (const { child, graph } of children) {
    const calls = graph.php?.calls ?? [];
    if (!calls.length) continue;
    const own = autoloads.get(child)!.psr4.filter((e) => e.prefix !== "");
    const world: PhpWorld = {
      cls(fqcn) {
        const os = ownersOf(fqcn);
        const mine = os.find((o) => o.child === child);
        if (mine) return mine;
        if (own.some((p) => fqcn.startsWith(p.prefix))) return null;
        return os.length === 1 ? os[0]! : os.length > 1 ? "ambiguous" : null;
      },
      methods: (ref, name) => methodsOf(graphs.get(ref.child)!).get(ref.id)?.get(name.toLowerCase()) ?? [],
      bound(key, prefer) {
        const byChild = binds.get(key);
        if (!byChild) return null;
        if (prefer && byChild.has(prefer)) return one(byChild.get(prefer));
        return one(new Set([...byChild.values()].flatMap((s) => [...s])));
      },
    };
    for (const call of calls) {
      stats.calls++;
      const result = resolveChain(world, call, child);
      outcomes.push({ fromChild: child, call, result });
      if (!result.ok) {
        const why = result.why;
        // Every class the workspace defines was in this world: what is outside it is outside the workspace.
        if (why === "outside") stats.external++;
        else if (why === "ambiguous") stats.ambiguous++;
        else if (why === "untyped") stats.untyped++;
        else stats.noMethod++;
        continue;
      }
      if (result.child === child) {
        stats.inRepo++;
        continue;
      }
      stats.linked++;
      const key = linkKey(child, call.s) + "\0" + linkKey(result.child, result.target);
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({
        fromChild: child,
        sourceId: call.s,
        relation: "calls",
        rawTarget: `${call.r}::${[...(call.p ?? []), call.m].join("->")}`,
        toChild: result.child,
        targetId: result.target,
        via: "method",
      });
    }
  }
  return { links, stats, outcomes };
}

/** Compute every cross-repo link. An FQCN resolves only when exactly one OTHER
 * child defines it, and never when the source child's own namespaces cover it
 * (an `App\…` class missing from one Laravel app is not the next app's class). */
export function computeLinks(
  root: string,
  children: Child[],
  autoloads = new Map(children.map((c) => [c.child, readComposerAutoload(composerFiles(root, c))])),
): CrossLink[] {
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
      links.push({ fromChild: child, sourceId: e.source, relation: e.relation, rawTarget: e.target, toChild, targetId: node.id, via: "use" });
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
    via: "http" as const,
  }));
  return { links, stats };
}

interface Memo {
  graphs: GraphV1[];
  stamp: string;
  index: LinkIndex;
  http: HttpMatchStats;
  methods: MethodCallStats;
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
  const autoloads = new Map(children.map((c) => [c.child, readComposerAutoload(composerFiles(root, c))]));
  const http = httpLinks(children);
  const methods = computeMethodLinks(root, children, autoloads);
  const links = [...computeLinks(root, children, autoloads), ...methods.links, ...http.links];
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
  memo = { graphs: children.map((c) => c.graph), stamp, index: { links, into, outOf }, http: http.stats, methods: methods.stats };
  return memo;
}

/** The workspace's link index (Composer, method calls and HTTP), recomputed only when
 * a child graph object or a `composer.json` changed since the last call in this process. */
export function workspaceLinks(root: string, children: Child[]): LinkIndex {
  return memoized(root, children).index;
}

/** How the PHP member calls that leave their repo resolved (`computeMethodLinks`). */
export function methodStats(root: string, children: Child[]): MethodCallStats {
  return memoized(root, children).methods;
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
      // A call from another repo whose receiver does not type statically links only
      // to the method's class (the `use` that imports it), so the callers continue
      // there too, next to the calls that did resolve to the method itself.
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

/**
 * HTTP facts of one repo and the links they make between repos: a client method
 * that sends `POST /createTransaction` calls the route handler that another repo
 * declares for that path, even though no symbol connects the two.
 *
 * Three stages, each with one owner:
 *
 *   1. per file, at extraction (`http-php.ts`): route declarations, the mounts
 *      that put a route file under a prefix (`->group(base_path('routes/api.php'))`),
 *      and call sites whose arguments carry a path or forward a parameter. Pure and
 *      file-local, so it rides the per-file extraction memo;
 *   2. per repo, at build ({@link assembleHttp}): mounts become full endpoint paths,
 *      handlers become method node ids, and call sites become client calls, through
 *      the repo's own wrappers (`ApiRequest::post($path)` → `$this->client->request(…)`).
 *      The result is stored on the graph as `graph.http`;
 *   3. per workspace, on load ({@link matchHttp}): a client call in one child is
 *      matched to the endpoint of exactly one OTHER child. Several children declaring
 *      the best match is ambiguous, and no link is made.
 *
 * Paths are kept as `/`-joined segments without leading or trailing slash; a route
 * parameter is `{}`, an optional one `{?}`, and a client segment computed at run
 * time is `{}` too.
 */
import { posix } from "node:path";
import { psr4Paths, type PhpAutoload } from "./composer.js";
import type { HttpCallV1, HttpEndpointV1, HttpFactsV1, NodeV1 } from "./types.js";

/** Marks a part of an evaluated string that is only known at run time. */
export const DYN = "\u0001";
/** Marks `__DIR__` (the declaring file's directory) in an evaluated mount path. */
export const DIR_MARK = "\u0002DIR";
/** Marks `base_path()` (the application root) in an evaluated mount path. */
export const BASE_MARK = "\u0002BASE";

export const HTTP_VERBS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"] as const;

/** Where a route's handler points, as the route file wrote it. `cls` is relative
 * to the enclosing route-group namespace unless `absolute` (a `::class` reference
 * resolved through the file's `use` statements, or a leading `\`). */
export interface HandlerRef {
  cls: string | null;
  absolute: boolean;
  method: string;
}

export interface RouteFact {
  methods: string[];
  /** In-file group prefixes joined with the route's own path, not yet normalized. */
  path: string;
  handler: HandlerRef | null;
  /** First line of the closure that serves the route, when the action is one. */
  closureLine?: number;
  /** Namespace of the in-file groups around the route, relative to its mount. */
  namespace: string | null;
  line: number;
}

/** A route file put under a prefix: `group(['prefix' => 'v2'], fn () => require …)`. */
export interface MountFact {
  /** Evaluated path expression, with {@link DIR_MARK}/{@link BASE_MARK} unresolved. */
  target: string;
  prefix: string;
  namespace: string | null;
  line: number;
}

/** One argument of a call site, or null when it is neither of these:
 * `s`, an evaluated string (may hold {@link DYN}); `p`, the index of a parameter of
 * the enclosing method the argument forwards, with `pre`, what is concatenated in
 * front of it. A parameter with a string default carries both `p` and `s`. */
export type ArgFact = { s?: string; p?: number; pre?: string } | null;

export interface CallSiteFact {
  /** The enclosing method or function node. */
  source: string;
  callee: string;
  args: ArgFact[];
  line: number;
  /** The verb the enclosing class fixes (`$_method = 'POST'`), for a request whose
   * verb argument is only known at run time. */
  verb?: string;
}

export interface FileHttpFacts {
  routes: RouteFact[];
  mounts: MountFact[];
  sites: CallSiteFact[];
}

// ------------------------------------------------------------------ paths

/** A route path as the router reads it: `{id}`/`{id:\d+}` → `{}`, `{id?}` → `{?}`,
 * Lumen's optional `[/{x}]` tails dropped, no leading/trailing slash. */
export function normalizeRoutePath(raw: string): string {
  let p = raw.replace(/\[[^\]]*\]/g, "");
  p = p.replace(/\{[^}]*\?\}/g, "{?}").replace(/\{[^}?]*\}/g, "{}");
  if (p.includes(DYN)) p = p.split("/").map((s) => (s.includes(DYN) ? "{}" : s)).join("/");
  return p.replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
}

export function joinRoutePath(...parts: string[]): string {
  return normalizeRoutePath(parts.filter(Boolean).join("/"));
}

/**
 * The path a client call sends, from its evaluated argument, or null when it does
 * not look like a request path. A leading run-time part is the base URL and is
 * dropped (`$this->base . '/x'`); so is a literal `scheme://host`. Run-time text
 * glued after a literal inside a segment is a query string (`'/events' . $qs`);
 * any other run-time segment is a parameter.
 */
export function clientPath(raw: string): string | null {
  let p = raw;
  if (p.startsWith(DYN)) {
    p = p.replace(new RegExp(`^${DYN}+`), "");
    if (p !== "" && !p.startsWith("/")) return null;
  }
  const url = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i.exec(p);
  if (url) p = p.slice(url[0].length) || "/";
  if (/\s/.test(p) || p.includes("\u0002")) return null;
  // Path-shaped: absolute, or relative with at least two segments (`v1/users`).
  // A single bare word is a key (`->get('name')`), not a path.
  if (!p.startsWith("/") && !/^[\w.-]+\/[\w{}.\-/]/.test(p)) return null;
  p = p.split(/[?#]/)[0]!;
  const segs = p
    .split("/")
    .filter((s) => s !== "")
    .map((s) => {
      if (!s.includes(DYN)) return s;
      const lit = s.split(DYN)[0]!;
      return lit !== "" ? lit : "{}";
    });
  if (!segs.some((s) => s !== "{}")) return null;
  return segs.join("/");
}

/** How well `client` fits `route` segment by segment, or null when it does not, or
 * fits by parameters alone. `{}` on either side matches any segment and trailing
 * `{?}` may be absent; an equal literal scores 2, a parameter against a parameter 1,
 * so a run-time segment prefers `items/{id}` over `items/save`, and the literal
 * `items/save` prefers `items/save` over `items/{id}`. */
export function pathScore(client: string, route: string): number | null {
  return segmentScore(client === "" ? [] : client.split("/"), route === "" ? [] : route.split("/"));
}

function segmentScore(a: readonly string[], b: readonly string[]): number | null {
  let n = b.length;
  while (n > a.length && b[n - 1] === "{?}") n--;
  if (a.length !== n) return null;
  let score = 0;
  let literal = false;
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i] === "{?}" ? "{}" : b[i]!;
    if (x === y) {
      score += x === "{}" ? 1 : 2;
      literal ||= x !== "{}";
    } else if (x !== "{}" && y !== "{}") return null;
  }
  return literal ? score : null;
}

export function verbAccepts(methods: readonly string[], verb: string | null): boolean {
  return verb === null || methods.includes("ANY") || methods.includes(verb);
}

// ------------------------------------------------------------------ per repo

/** The application root a `base_path()` call means for a file: the part of its
 * path before the framework's `app/`, `bootstrap/`, `routes/` or `config/` dir. */
function appBase(file: string): string {
  const parts = file.split("/");
  for (let i = parts.length - 2; i >= 0; i--) {
    if (["app", "bootstrap", "routes", "config"].includes(parts[i]!)) return parts.slice(0, i).join("/");
  }
  return "";
}

function resolveMountTarget(from: string, target: string, routeFiles: ReadonlySet<string>): string | null {
  let p = target;
  if (p.startsWith(DIR_MARK)) p = posix.dirname(from) + p.slice(DIR_MARK.length);
  else if (p.startsWith(BASE_MARK)) p = appBase(from) + "/" + p.slice(BASE_MARK.length);
  if (p.includes(DYN) || p.includes("\u0002")) return null;
  const norm = posix.normalize(p).replace(/^\.?\//, "");
  if (routeFiles.has(norm)) return norm;
  // A path relative to a cwd we cannot know: the one route file ending with it.
  const tail = norm.replace(/^(\.\.\/)+/, "");
  const hits = [...routeFiles].filter((f) => f === tail || f.endsWith("/" + tail));
  return hits.length === 1 ? hits[0]! : null;
}

function joinNamespace(outer: string | null, inner: string | null): string | null {
  if (!inner) return outer;
  if (inner.startsWith("\\") || !outer) return inner.replace(/^\\+/, "");
  return `${outer.replace(/\\+$/, "")}\\${inner}`;
}

const TEST_DIR = /(^|\/)(tests?|Tests?)\//;
const MAX_WRAPPERS_PER_NAME = 8;

/** The repo's method node for a handler: by its PSR-4 file when the class name is
 * known in full, else the one class of that short name defining the method. */
function handlerNode(
  fqcn: string,
  method: string,
  methodsByOwner: Map<string, NodeV1[]>,
  typesByName: Map<string, NodeV1[]>,
  autoload: PhpAutoload | undefined,
): string | null {
  const short = fqcn.slice(fqcn.lastIndexOf("\\") + 1);
  const candidates = methodsByOwner.get(`${short}\0${method}`) ?? [];
  const classes = typesByName.get(short) ?? [];
  const pick = (paths: string[]): string | null => {
    for (const path of paths) {
      const m = candidates.find((n) => n.path === path);
      if (m) return m.id;
      const c = classes.find((n) => n.path === path);
      if (c) return c.id; // inherited action: the class is the closest node
    }
    return null;
  };
  if (autoload?.psr4.length && fqcn.includes("\\")) {
    const hit = pick(psr4Paths(fqcn, autoload.psr4));
    if (hit) return hit;
  }
  // Longest unique namespace-tail suffix, as `use` resolution guesses outside PSR-4.
  const parts = fqcn.split("\\").filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const suffix = `${parts.slice(i).join("/")}.php`;
    const hits = candidates.filter((n) => n.path === suffix || n.path.endsWith("/" + suffix));
    if (hits.length === 1) return hits[0]!.id;
    if (hits.length > 1) return null;
  }
  return null;
}

/** A method that sends a request to whatever path it is given: `pre` + its
 * argument `pathArg`, with the verb fixed or taken from argument `verbArg`. */
interface Wrapper {
  pathArg: number;
  pre: string;
  verb: string | null;
  verbArg?: number;
}

/** Calls an HTTP client exposes, by name: the verb methods (`get('/x')`) and the
 * generic ones that take the verb first (`request('POST', '/x')`). */
function sinkOf(callee: string, argCount: number): Wrapper | null {
  const verb = callee.replace(/Async$/, "").toUpperCase();
  if ((HTTP_VERBS as readonly string[]).includes(verb) && argCount >= 1) return { pathArg: 0, pre: "", verb };
  if (/^(request|send)(Async)?$/.test(callee) && argCount >= 2) return { pathArg: 1, pre: "", verb: null, verbArg: 0 };
  return null;
}

function verbOf(arg: ArgFact | undefined): string | null {
  if (arg?.s === undefined) return null;
  const v = arg.s.toUpperCase();
  return (HTTP_VERBS as readonly string[]).includes(v) ? v : null;
}

/**
 * The repo's endpoints and client calls from its per-file facts.
 *
 * A route file's prefix comes from every mount that reaches it (a file mounted
 * twice yields its routes twice); a file nobody mounts is served at the root.
 * A client call is a call site whose path argument is known, made to an HTTP
 * client method or to one of the repo's own wrappers: a method that forwards
 * its parameter as the path of such a call, found to a fixpoint by name.
 * Sites in test directories are skipped: a test's `$this->get('/x')` requests
 * its own app.
 */
export function assembleHttp(
  files: ReadonlyMap<string, FileHttpFacts>,
  nodes: readonly NodeV1[],
  autoload?: PhpAutoload,
): HttpFactsV1 | undefined {
  if (files.size === 0) return undefined;
  const methodsByOwner = new Map<string, NodeV1[]>();
  const typesByName = new Map<string, NodeV1[]>();
  const nameOf = new Map<string, string>();
  /** Closure nodes by `file:first line`, for routes whose action is a closure. */
  const closureAt = new Map<string, string>();
  for (const n of nodes) {
    nameOf.set(n.id, n.name);
    if (n.kind === "function" && n.name === "{closure}") closureAt.set(`${n.path}:${n.span.slice(1, n.span.indexOf("-"))}`, n.id);
    if (n.kind === "method" && n.owner) {
      const k = `${n.owner}\0${n.name}`;
      const arr = methodsByOwner.get(k);
      if (arr) arr.push(n);
      else methodsByOwner.set(k, [n]);
    } else if (n.kind === "class" || n.kind === "trait") {
      const arr = typesByName.get(n.name);
      if (arr) arr.push(n);
      else typesByName.set(n.name, [n]);
    }
  }

  // Endpoints: route files under their mounts.
  const routeFiles = new Set<string>();
  for (const [file, f] of files) if (f.routes.length || f.mounts.length) routeFiles.add(file);
  const mountsInto = new Map<string, { from: string; m: MountFact }[]>();
  for (const [from, f] of files) {
    for (const m of f.mounts) {
      const target = resolveMountTarget(from, m.target, routeFiles);
      if (!target || target === from) continue;
      const arr = mountsInto.get(target);
      if (arr) arr.push({ from, m });
      else mountsInto.set(target, [{ from, m }]);
    }
  }
  const contexts = (file: string, seen: Set<string>): { prefix: string; namespace: string | null }[] => {
    const incoming = mountsInto.get(file);
    if (!incoming || seen.has(file)) return [{ prefix: "", namespace: null }];
    const next = new Set(seen).add(file);
    const out: { prefix: string; namespace: string | null }[] = [];
    for (const { from, m } of incoming) {
      for (const outer of contexts(from, next)) {
        out.push({ prefix: joinRoutePath(outer.prefix, m.prefix), namespace: joinNamespace(outer.namespace, m.namespace) });
      }
    }
    return out;
  };

  const endpoints: HttpEndpointV1[] = [];
  const seenEndpoint = new Set<string>();
  for (const [file, f] of files) {
    if (f.routes.length === 0) continue;
    for (const ctx of contexts(file, new Set())) {
      for (const r of f.routes) {
        let handler: string | null = null;
        if (r.handler?.cls) {
          const fqcn = r.handler.absolute
            ? r.handler.cls
            : (joinNamespace(joinNamespace(ctx.namespace, r.namespace), r.handler.cls) ?? r.handler.cls);
          handler = handlerNode(fqcn, r.handler.method, methodsByOwner, typesByName, autoload);
        } else if (r.closureLine !== undefined) {
          handler = closureAt.get(`${file}:${r.closureLine}`) ?? null;
        }
        const path = joinRoutePath(ctx.prefix, r.path);
        const methods = [...new Set(r.methods)].sort();
        const key = `${methods.join(",")} ${path} ${handler} ${file}:${r.line}`;
        if (seenEndpoint.has(key)) continue;
        seenEndpoint.add(key);
        endpoints.push({ methods, path, handler, file, line: r.line });
      }
    }
  }

  // Wrappers, to a fixpoint: a method that hands its parameter to a sink (or to
  // another wrapper) as the path is itself a client of whatever path it is given.
  const wrappers = new Map<string, Wrapper[]>();
  const sites = [...files.entries()].filter(([file]) => !TEST_DIR.test(file)).flatMap(([, f]) => f.sites);
  const targetsOf = (callee: string, argCount: number): Wrapper[] => {
    const sink = sinkOf(callee, argCount);
    return [...(sink ? [sink] : []), ...(wrappers.get(callee) ?? [])];
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const s of sites) {
      const name = nameOf.get(s.source);
      if (!name) continue;
      for (const t of targetsOf(s.callee, s.args.length)) {
        const a = s.args[t.pathArg];
        if (a?.p === undefined) continue;
        const va = t.verbArg !== undefined ? s.args[t.verbArg] : undefined;
        const w: Wrapper = { pathArg: a.p, pre: t.pre + (a.pre ?? ""), verb: t.verb ?? verbOf(va) };
        if (w.verb === null && va?.p !== undefined) w.verbArg = va.p;
        const list = wrappers.get(name) ?? [];
        // A bounded set per name: a recursive wrapper must not grow `pre` forever.
        if (list.length >= MAX_WRAPPERS_PER_NAME) continue;
        if (list.some((x) => x.pathArg === w.pathArg && x.pre === w.pre && x.verb === w.verb && x.verbArg === w.verbArg))
          continue;
        list.push(w);
        wrappers.set(name, list);
        changed = true;
      }
    }
  }

  const calls: HttpCallV1[] = [];
  const seenCall = new Set<string>();
  for (const s of sites) {
    for (const t of targetsOf(s.callee, s.args.length)) {
      const a = s.args[t.pathArg];
      if (a?.s === undefined) continue;
      const path = clientPath(t.pre + a.s);
      if (path === null) continue;
      const method = t.verb ?? (t.verbArg !== undefined ? verbOf(s.args[t.verbArg]) : null) ?? s.verb ?? null;
      const key = `${s.source} ${method} ${path}`;
      if (seenCall.has(key)) continue;
      seenCall.add(key);
      calls.push({ source: s.source, method, path, line: s.line });
    }
  }

  if (endpoints.length === 0 && calls.length === 0) return undefined;
  endpoints.sort((x, y) => x.file.localeCompare(y.file) || x.line - y.line || x.path.localeCompare(y.path));
  calls.sort((x, y) => x.source.localeCompare(y.source) || x.line - y.line || x.path.localeCompare(y.path));
  return { endpoints, calls };
}

// ------------------------------------------------------------------ per workspace

export interface HttpMatch {
  fromChild: string;
  call: HttpCallV1;
  toChild: string;
  endpoint: HttpEndpointV1;
}

export interface HttpMatchStats {
  calls: number;
  linked: number;
  /** The best match has more than one handler (`child: handler`), in one child or
   * several: no link. */
  ambiguous: { fromChild: string; call: HttpCallV1; candidates: string[] }[];
  /** The best match is a closure route or a handler the repo does not define. */
  noHandler: number;
  /** A route has the path but not the verb. */
  verbMismatch: number;
  unmatched: number;
  /** Every request left without a link, with the reason; the counts above tally it. */
  unlinked: { fromChild: string; call: HttpCallV1; reason: UnlinkedReason }[];
}

export type UnlinkedReason = "no-route" | "verb-mismatch" | "no-handler" | "ambiguous";

/**
 * Match every child's client calls to the other children's endpoints. Within the
 * verb-compatible routes the best {@link pathScore} wins, so `bonuses/getLite` is
 * not taken by `bonuses/{id}`; when the winners sit in more than one child, there
 * is no telling which service the client talks to, and no link is made.
 */
export function matchHttp(children: { child: string; http?: HttpFactsV1 }[]): { matches: HttpMatch[]; stats: HttpMatchStats } {
  const stats: HttpMatchStats = { calls: 0, linked: 0, ambiguous: [], noHandler: 0, verbMismatch: 0, unmatched: 0, unlinked: [] };
  const matches: HttpMatch[] = [];
  // Endpoints by first literal segment: a call only scans routes that could fit.
  type Entry = { child: string; e: HttpEndpointV1; segs: string[] };
  const byHead = new Map<string, Entry[]>();
  const wild: Entry[] = [];
  const all: Entry[] = [];
  for (const { child, http } of children) {
    for (const e of http?.endpoints ?? []) {
      const entry = { child, e, segs: e.path === "" ? [] : e.path.split("/") };
      all.push(entry);
      const head = entry.segs[0] ?? "";
      if (head === "{}" || head === "{?}" || head === "") wild.push(entry);
      else {
        const arr = byHead.get(head);
        if (arr) arr.push(entry);
        else byHead.set(head, [entry]);
      }
    }
  }
  for (const { child, http } of children) {
    for (const call of http?.calls ?? []) {
      stats.calls++;
      const segs = call.path.split("/");
      const head = segs[0]!;
      const pools = head === "{}" ? [all] : [byHead.get(head) ?? [], wild];
      const fit: { child: string; e: HttpEndpointV1; score: number }[] = [];
      let pathOnly = false;
      for (const c of pools.flat()) {
        if (c.child === child) continue;
        const score = segmentScore(segs, c.segs);
        if (score === null) continue;
        if (!verbAccepts(c.e.methods, call.method)) {
          pathOnly = true;
          continue;
        }
        fit.push({ ...c, score });
      }
      if (fit.length === 0) {
        if (pathOnly) stats.verbMismatch++;
        else stats.unmatched++;
        stats.unlinked.push({ fromChild: child, call, reason: pathOnly ? "verb-mismatch" : "no-route" });
        continue;
      }
      const top = Math.max(...fit.map((f) => f.score));
      const best = fit.filter((f) => f.score === top);
      // One link or none: two services, or two handlers of one (a request whose verb
      // is only known at run time, against `GET x` and `POST x`), is a guess.
      const handlers = new Map<string, (typeof best)[number]>();
      for (const b of best) handlers.set(`${b.child}\0${b.e.handler}`, b);
      if (handlers.size > 1) {
        stats.ambiguous.push({ fromChild: child, call, candidates: [...handlers.keys()].map((k) => k.replace("\0", ": ")).sort() });
        stats.unlinked.push({ fromChild: child, call, reason: "ambiguous" });
        continue;
      }
      const [only] = handlers.values();
      if (only!.e.handler === null) {
        stats.noHandler++;
        stats.unlinked.push({ fromChild: child, call, reason: "no-handler" });
        continue;
      }
      matches.push({ fromChild: child, call, toChild: only!.child, endpoint: only!.e });
      stats.linked++;
    }
  }
  return { matches, stats };
}

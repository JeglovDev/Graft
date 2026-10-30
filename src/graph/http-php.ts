/**
 * PHP's half of the HTTP facts (`http.ts`), read off the tree the depth extractor
 * already parsed: Laravel/Lumen route declarations and mounts, and the call sites
 * that may send a request.
 *
 * Routes: a call chain rooted at a router (`Route::`, `$router->`, `$app->router->`,
 * `$app->` and a group closure's own parameter at file level) declares a route with
 * `get/post/put/patch/delete/options/any/match/addRoute/resource/apiResource`, and
 * nests with `group` (array attributes `prefix`/`namespace`, or the chained
 * `prefix()`/`namespace()`/`controller()`). A group whose body is a file
 * (`base_path('routes/api.php')`) or that `require`s one is a mount; so is
 * Laravel 11's `withRouting(api: …)`, which serves `api` under `apiPrefix` (`api`).
 *
 * Call sites: inside a function, every member or static call with an argument
 * that evaluates to a path-shaped string or forwards a string parameter. Which of
 * them are requests is decided per repo, once the repo's wrappers are known.
 */
import {
  BASE_MARK,
  DIR_MARK,
  DYN,
  HTTP_VERBS,
  clientPath,
  type ArgFact,
  type FileHttpFacts,
  type HandlerRef,
  type MountFact,
  type RouteFact,
} from "./http.js";
import type { SyntaxNode } from "./depth-parser.js";
import type { NodeV1 } from "./types.js";

const CALL_TYPES = new Set(["member_call_expression", "nullsafe_member_call_expression", "scoped_call_expression"]);
const FUNCTION_TYPES = new Set(["method_declaration", "function_definition", "anonymous_function", "arrow_function"]);
const ROUTE_VERBS = new Set(["get", "post", "put", "patch", "delete", "options", "any"]);
const RESOURCE_ACTIONS: [string, string, string][] = [
  ["GET", "", "index"],
  ["GET", "create", "create"],
  ["POST", "", "store"],
  ["GET", "{}", "show"],
  ["GET", "{}/edit", "edit"],
  ["PUT", "{}", "update"],
  ["PATCH", "{}", "update"],
  ["DELETE", "{}", "destroy"],
];
const MAX_EVAL_DEPTH = 4;

interface Param {
  index: number;
  def: SyntaxNode | null;
  stringy: boolean;
}

interface Env {
  params: Map<string, Param>;
  /** Local variables assigned exactly once in the function: name → right-hand side. */
  locals: Map<string, SyntaxNode | null>;
}

const NO_ENV: Env = { params: new Map(), locals: new Map() };

interface FileCtx {
  namespace: string;
  uses: ReadonlyMap<string, { name: string; specifier: string }>;
  /** Class constants and property defaults of the file, by name; null when declared twice. */
  consts: Map<string, SyntaxNode | null>;
  props: Map<string, SyntaxNode | null>;
  /** File-level `$var = …` assignments made once. */
  globals: Map<string, SyntaxNode | null>;
}

interface RouteCtx {
  prefix: string;
  namespace: string | null;
  controller: string | null;
  /** Variables that name a router here. */
  receivers: ReadonlySet<string>;
  /** Outside every class: `$app` and a group closure's `$this` are routers only here. */
  fileLevel: boolean;
}

function setOnce(m: Map<string, SyntaxNode | null>, k: string, v: SyntaxNode | null): void {
  m.set(k, m.has(k) ? null : v);
}

function argValues(call: SyntaxNode): { name: string | null; value: SyntaxNode }[] {
  const args = call.childForFieldName("arguments") ?? call.namedChildren.find((c) => c.type === "arguments");
  if (!args) return [];
  const out: { name: string | null; value: SyntaxNode }[] = [];
  for (const a of args.namedChildren) {
    if (a.type !== "argument") continue;
    const kids = a.namedChildren;
    const value = kids[kids.length - 1];
    if (!value) continue;
    out.push({ name: kids.length >= 2 && kids[0]!.type === "name" ? kids[0]!.text : null, value });
  }
  return out;
}

function callName(call: SyntaxNode): string | null {
  return call.childForFieldName("name")?.text ?? null;
}

const UNESCAPE: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"', $: "$" };

function stringText(n: SyntaxNode): string {
  if (n.namedChildren.length === 0) return n.text.replace(/^[bB]?(['"])([\s\S]*)\1$/, "$2");
  let out = "";
  for (const c of n.namedChildren) {
    if (c.type === "string_content" || c.type === "string_value") out += c.text;
    else if (c.type === "escape_sequence") out += UNESCAPE[c.text.slice(1)] ?? c.text;
    else out += DYN;
  }
  return out;
}

/**
 * The string an expression evaluates to, with {@link DYN} where only run time knows,
 * or null when it is not a string expression. Follows literals, `.` concatenation,
 * interpolation, a parameter's default, a variable assigned once, class constants
 * and property defaults of the same file, `__DIR__`, `base_path()`, `dirname()` and
 * `sprintf()`.
 */
function evalStr(n: SyntaxNode | null | undefined, env: Env, file: FileCtx, depth = 0): string | null {
  if (!n || depth > MAX_EVAL_DEPTH) return null;
  switch (n.type) {
    case "string":
    case "encapsed_string":
      return stringText(n);
    case "parenthesized_expression":
      return evalStr(n.namedChildren[0], env, file, depth);
    case "binary_expression": {
      const op = n.childForFieldName("operator")?.text ?? n.children[1]?.text;
      if (op !== ".") return null;
      const l = evalStr(n.childForFieldName("left") ?? n.namedChildren[0], env, file, depth + 1);
      const r = evalStr(n.childForFieldName("right") ?? n.namedChildren[1], env, file, depth + 1);
      return (l ?? DYN) + (r ?? DYN);
    }
    case "variable_name": {
      const name = n.text.replace(/^\$/, "");
      const p = env.params.get(name);
      if (p) return p.def ? (evalStr(p.def, env, file, depth + 1) ?? DYN) : DYN;
      const local = env.locals.get(name) ?? (env === NO_ENV ? file.globals.get(name) : undefined);
      return local ? (evalStr(local, env, file, depth + 1) ?? DYN) : DYN;
    }
    case "name":
      return n.text === "__DIR__" ? DIR_MARK : null;
    case "class_constant_access_expression": {
      const member = n.namedChildren[n.namedChildren.length - 1]?.text;
      if (!member || member === "class") return null;
      const v = file.consts.get(member);
      return v ? (evalStr(v, env, file, depth + 1) ?? DYN) : DYN;
    }
    case "member_access_expression": {
      const obj = n.childForFieldName("object");
      const prop = n.childForFieldName("name")?.text;
      const v = obj?.text === "$this" && prop ? file.props.get(prop) : undefined;
      return v ? (evalStr(v, env, file, depth + 1) ?? DYN) : DYN;
    }
    case "function_call_expression": {
      const fn = n.childForFieldName("function")?.text.replace(/^\\/, "");
      const args = argValues(n);
      const first = args[0] ? evalStr(args[0].value, env, file, depth + 1) : null;
      if (fn === "base_path") return `${BASE_MARK}/${first ?? ""}`;
      if (fn === "dirname" && first !== null) return `${first}/..`;
      if (fn === "trim" || fn === "rtrim" || fn === "ltrim") return first ?? DYN;
      if (fn === "sprintf" && first !== null) return first.replace(/%(\d+\$)?[-+ 0']*\d*(\.\d+)?[bcdeEfFgGosuxX]/g, DYN);
      return DYN;
    }
    case "member_call_expression":
    case "nullsafe_member_call_expression":
    case "scoped_call_expression":
    case "subscript_expression":
    case "nullsafe_member_access_expression":
    case "scoped_property_access_expression":
      return DYN;
    default:
      return null;
  }
}

/** A class name as written → FQCN, through the file's `use` statements and namespace. */
function resolveClass(text: string, file: FileCtx): string {
  if (text.startsWith("\\")) return text.slice(1);
  const [head, ...rest] = text.split("\\");
  const use = file.uses.get(head!);
  if (use) return [use.specifier, ...rest].join("\\");
  return file.namespace ? `${file.namespace}\\${text}` : text;
}

function classRef(n: SyntaxNode | undefined, file: FileCtx): string | null {
  if (n?.type !== "class_constant_access_expression") return null;
  const [scope, member] = [n.namedChildren[0], n.namedChildren[n.namedChildren.length - 1]];
  if (!scope || member?.text !== "class") return null;
  return resolveClass(scope.text, file);
}

function arrayEntries(n: SyntaxNode): { key: SyntaxNode | null; value: SyntaxNode }[] {
  const out: { key: SyntaxNode | null; value: SyntaxNode }[] = [];
  for (const el of n.namedChildren) {
    if (el.type !== "array_element_initializer") continue;
    const kids = el.namedChildren;
    if (kids.length === 2) out.push({ key: kids[0]!, value: kids[1]! });
    else if (kids.length === 1) out.push({ key: null, value: kids[0]! });
  }
  return out;
}

function arrayKey(n: SyntaxNode, key: string): SyntaxNode | null {
  for (const e of arrayEntries(n)) if (e.key && (e.key.type === "string" || e.key.type === "encapsed_string") && stringText(e.key) === key) return e.value;
  return null;
}

/** A route action: `'Ctrl@m'`, `['uses' => 'Ctrl@m']`, `[Ctrl::class, 'm']`,
 * `Ctrl::class` (invokable), or `'m'` inside `Route::controller(Ctrl::class)`. */
function handlerOf(n: SyntaxNode | undefined, ctx: RouteCtx, file: FileCtx): HandlerRef | null {
  if (!n) return null;
  if (n.type === "string" || n.type === "encapsed_string") {
    const s = stringText(n);
    if (s.includes(DYN)) return null;
    const at = /^(\\?[\w\\]+)[@:](\w+)$/.exec(s);
    if (at) return { cls: at[1]!.replace(/^\\/, ""), absolute: at[1]!.startsWith("\\"), method: at[2]! };
    if (/^\w+$/.test(s) && ctx.controller) return { cls: ctx.controller, absolute: true, method: s };
    return null;
  }
  if (n.type === "class_constant_access_expression") {
    const cls = classRef(n, file);
    return cls ? { cls, absolute: true, method: "__invoke" } : null;
  }
  if (n.type === "array_creation_expression") {
    const uses = arrayKey(n, "uses");
    if (uses) return handlerOf(uses, ctx, file);
    const plain = arrayEntries(n).filter((e) => e.key === null);
    if (plain.length === 2) {
      const cls = classRef(plain[0]!.value, file);
      const m = plain[1]!.value;
      if (cls && (m.type === "string" || m.type === "encapsed_string")) return { cls, absolute: true, method: stringText(m) };
    }
  }
  return null;
}

/** `[root, calls…]` of a call chain, innermost call first. */
function chainOf(call: SyntaxNode): { root: SyntaxNode | null; calls: SyntaxNode[] } {
  const calls: SyntaxNode[] = [];
  let cur: SyntaxNode | null = call;
  while (cur && CALL_TYPES.has(cur.type)) {
    calls.unshift(cur);
    if (cur.type === "scoped_call_expression") return { root: cur.childForFieldName("scope"), calls };
    cur = cur.childForFieldName("object");
  }
  return { root: cur, calls };
}

function isRouterRoot(root: SyntaxNode | null, ctx: RouteCtx): boolean {
  if (!root) return false;
  if (root.type === "name" || root.type === "qualified_name") return root.text.replace(/^.*\\/, "") === "Route";
  if (root.type === "variable_name") {
    const v = root.text.replace(/^\$/, "");
    return ctx.receivers.has(v) || (ctx.fileLevel && (v === "app" || v === "this"));
  }
  if (root.type === "member_access_expression") return root.childForFieldName("name")?.text === "router";
  return false;
}

function closureOf(n: SyntaxNode | undefined): SyntaxNode | null {
  return n && (n.type === "anonymous_function" || n.type === "arrow_function") ? n : null;
}

function closureParams(fn: SyntaxNode): string[] {
  const params = fn.childForFieldName("parameters") ?? fn.namedChildren.find((c) => c.type === "formal_parameters");
  return (params?.namedChildren ?? [])
    .map((p) => p.childForFieldName("name")?.text ?? p.namedChildren.find((c) => c.type === "variable_name")?.text)
    .filter((t): t is string => !!t)
    .map((t) => t.replace(/^\$/, ""));
}

function joinNs(outer: string | null, inner: string | null): string | null {
  if (!inner) return outer;
  if (inner.startsWith("\\") || !outer) return inner.replace(/^\\+/, "");
  return `${outer}\\${inner}`;
}

function joinPrefix(a: string, b: string | null): string {
  return b ? (a ? `${a}/${b}` : b) : a;
}

function lineOf(n: SyntaxNode): number {
  return n.startPosition.row + 1;
}

class RouteWalker {
  readonly routes: RouteFact[] = [];
  readonly mounts: MountFact[] = [];
  constructor(private readonly file: FileCtx) {}

  walk(n: SyntaxNode, ctx: RouteCtx): void {
    if (CALL_TYPES.has(n.type)) {
      if (this.chain(n, ctx)) return;
    } else if (n.type === "class_declaration" || n.type === "trait_declaration") {
      ctx = { ...ctx, fileLevel: false };
    } else if (/^(require|include)(_once)?_expression$/.test(n.type)) {
      this.mount(n.namedChildren[0], n, ctx);
      return;
    }
    for (const c of n.namedChildren) this.walk(c, ctx);
  }

  private mount(target: SyntaxNode | undefined, at: SyntaxNode, ctx: RouteCtx, prefix = ctx.prefix): void {
    const t = evalStr(target, NO_ENV, this.file);
    if (t && /\.php$/.test(t)) this.mounts.push({ target: t, prefix, namespace: ctx.namespace, line: lineOf(at) });
  }

  private str(n: SyntaxNode | undefined): string | null {
    return n ? evalStr(n, NO_ENV, this.file) : null;
  }

  /** Read a router chain; false when it declares no route or group, so the walk
   * descends into it (a closure argument may hold one). */
  private chain(call: SyntaxNode, ctx: RouteCtx): boolean {
    if (callName(call) === "withRouting") this.withRouting(call, ctx);
    const { root, calls } = chainOf(call);
    if (!isRouterRoot(root, ctx)) return false;
    let prefix = ctx.prefix;
    let namespace = ctx.namespace;
    let controller = ctx.controller;
    for (const c of calls) {
      const name = callName(c)?.toLowerCase() ?? "";
      const args = argValues(c).map((a) => a.value);
      if (name === "prefix") prefix = joinPrefix(prefix, this.str(args[0]));
      else if (name === "namespace") namespace = joinNs(namespace, this.str(args[0]));
      else if (name === "controller") controller = classRef(args[0], this.file) ?? controller;
      else if (name === "group") {
        const attrs = args.length > 1 ? args[0] : undefined;
        if (attrs?.type === "array_creation_expression") {
          const p = arrayKey(attrs, "prefix");
          const ns = arrayKey(attrs, "namespace");
          if (p) prefix = joinPrefix(prefix, this.str(p));
          if (ns) namespace = joinNs(namespace, this.str(ns));
        } else if (attrs) {
          prefix = joinPrefix(prefix, this.str(attrs)); // Slim: group('/prefix', fn)
        }
        const body = args[args.length - 1];
        const inner: RouteCtx = { ...ctx, prefix, namespace, controller };
        const fn = closureOf(body);
        if (fn) {
          const params = closureParams(fn);
          const receivers = params.length ? new Set([...ctx.receivers, ...params]) : ctx.receivers;
          const fnBody = fn.childForFieldName("body") ?? fn.namedChildren[fn.namedChildren.length - 1];
          if (fnBody) this.walk(fnBody, { ...inner, receivers });
        } else if (body) {
          this.mount(body, c, inner);
        }
        return true;
      } else if (this.route(name, c, args, { ...ctx, prefix, namespace, controller })) {
        return true;
      }
    }
    return false;
  }

  private route(name: string, call: SyntaxNode, args: SyntaxNode[], ctx: RouteCtx): boolean {
    const push = (methods: string[], path: string | null, handler: HandlerRef | null) => {
      if (path === null) return;
      this.routes.push({ methods, path: joinPrefix(ctx.prefix, path), handler, namespace: ctx.namespace, line: lineOf(call) });
    };
    if (ROUTE_VERBS.has(name)) {
      push([name === "any" ? "ANY" : name.toUpperCase()], this.str(args[0]), handlerOf(args[1], ctx, this.file));
      return true;
    }
    if (name === "match" || name === "addroute") {
      const m = args[0];
      const methods =
        m?.type === "array_creation_expression"
          ? arrayEntries(m).map((e) => this.str(e.value)?.toUpperCase()).filter((v): v is string => !!v && !v.includes(DYN))
          : [this.str(m)?.toUpperCase()].filter((v): v is string => !!v && !v.includes(DYN));
      push(methods.length ? methods : ["ANY"], this.str(args[1]), handlerOf(args[2], ctx, this.file));
      return true;
    }
    if (name === "resource" || name === "apiresource") {
      const base = this.str(args[0]);
      const cls = classRef(args[1], this.file);
      if (base === null) return true;
      for (const [verb, tail, action] of RESOURCE_ACTIONS) {
        if (name === "apiresource" && (action === "create" || action === "edit")) continue;
        push([verb], joinPrefix(base, tail), cls ? { cls, absolute: true, method: action } : null);
      }
      return true;
    }
    return false;
  }

  /** Laravel 11: `->withRouting(web: …, api: …, apiPrefix: 'api')`. */
  private withRouting(call: SyntaxNode, ctx: RouteCtx): void {
    const named = new Map(argValues(call).filter((a) => a.name).map((a) => [a.name!, a.value]));
    const apiPrefix = named.has("apiPrefix") ? this.str(named.get("apiPrefix")) : "api";
    for (const [kind, prefix] of [["web", ""], ["api", apiPrefix ?? "api"]] as const) {
      const target = named.get(kind);
      if (target) this.mount(target, call, ctx, joinPrefix(ctx.prefix, prefix));
    }
  }
}

function isStringyType(t: SyntaxNode | null): boolean {
  if (!t) return true;
  return /\bstring\b|\bmixed\b/i.test(t.text);
}

function functionEnv(fn: SyntaxNode): Env {
  const params = new Map<string, Param>();
  const list = fn.childForFieldName("parameters") ?? fn.namedChildren.find((c) => c.type === "formal_parameters");
  (list?.namedChildren ?? []).forEach((p, index) => {
    const v = p.childForFieldName("name") ?? p.namedChildren.find((c) => c.type === "variable_name");
    if (!v) return;
    params.set(v.text.replace(/^\$/, ""), {
      index,
      def: p.childForFieldName("default_value"),
      stringy: isStringyType(p.childForFieldName("type")),
    });
  });
  const locals = new Map<string, SyntaxNode | null>();
  const body = fn.childForFieldName("body");
  const visit = (n: SyntaxNode): void => {
    if (n !== fn && FUNCTION_TYPES.has(n.type)) return;
    if (n.type === "assignment_expression") {
      const left = n.childForFieldName("left");
      if (left?.type === "variable_name") setOnce(locals, left.text.replace(/^\$/, ""), n.childForFieldName("right"));
    }
    for (const c of n.namedChildren) visit(c);
  };
  if (body) visit(body);
  return { params, locals };
}

/** The parameter an argument forwards (directly, through a local assigned once, or
 * at the end of a `.` concatenation), with what is concatenated in front of it. */
function forwardedParam(n: SyntaxNode, env: Env, file: FileCtx, depth = 0): { p: Param; pre: string } | null {
  if (depth > MAX_EVAL_DEPTH) return null;
  if (n.type === "variable_name") {
    const name = n.text.replace(/^\$/, "");
    const p = env.params.get(name);
    if (p) return p.stringy ? { p, pre: "" } : null;
    const local = env.locals.get(name);
    return local ? forwardedParam(local, env, file, depth + 1) : null;
  }
  if (n.type === "parenthesized_expression" && n.namedChildren[0]) return forwardedParam(n.namedChildren[0], env, file, depth + 1);
  if (n.type === "binary_expression" && (n.childForFieldName("operator")?.text ?? n.children[1]?.text) === ".") {
    const right = n.childForFieldName("right") ?? n.namedChildren[1];
    const left = n.childForFieldName("left") ?? n.namedChildren[0];
    const fwd = right ? forwardedParam(right, env, file, depth + 1) : null;
    if (!fwd || !left) return null;
    return { p: fwd.p, pre: (evalStr(left, env, file, depth + 1) ?? DYN) + fwd.pre };
  }
  if (n.type === "encapsed_string") {
    const kids = n.namedChildren;
    const last = kids[kids.length - 1];
    if (last?.type !== "variable_name") return null;
    const fwd = forwardedParam(last, env, file, depth + 1);
    if (!fwd) return null;
    let pre = "";
    for (const c of kids.slice(0, -1)) pre += c.type === "string_content" ? c.text : DYN;
    return { p: fwd.p, pre };
  }
  return null;
}

function argFact(n: SyntaxNode, env: Env, file: FileCtx): ArgFact {
  const fwd = forwardedParam(n, env, file);
  const s = evalStr(n, env, file);
  const keep = s !== null && (clientPath(s) !== null || (HTTP_VERBS as readonly string[]).includes(s.toUpperCase()));
  // A forwarded parameter is also a path of its own when its default or the text
  // around it is one: `'/email/confirm/' . $hash` is a wrapper and a request.
  if (fwd) return { p: fwd.p.index, ...(fwd.pre ? { pre: fwd.pre } : {}), ...(keep && clientPath(s!) !== null ? { s: s! } : {}) };
  return keep ? { s: s! } : null;
}

/** The verb a request class fixes in its own `$method`-named property
 * (`protected $_method = 'POST'`), when it declares exactly one such verb. */
function classVerb(cls: SyntaxNode, file: FileCtx): string | undefined {
  const found = new Set<string>();
  const body = cls.childForFieldName("body") ?? cls.namedChildren.find((c) => c.type === "declaration_list");
  for (const decl of body?.namedChildren ?? []) {
    if (decl.type !== "property_declaration") continue;
    for (const el of decl.namedChildren) {
      if (el.type !== "property_element") continue;
      const [name, value] = el.namedChildren;
      if (!name || !/method/i.test(name.text) || !value) continue;
      const v = evalStr(value, NO_ENV, file)?.toUpperCase();
      if (v && (HTTP_VERBS as readonly string[]).includes(v)) found.add(v);
    }
  }
  return found.size === 1 ? [...found][0] : undefined;
}

/**
 * HTTP facts of one PHP file, or undefined when it has none. `nodes` are the
 * file's extracted nodes, so a call site names the method node it sits in.
 */
export function extractPhpHttp(
  source: string,
  root: SyntaxNode,
  nodes: readonly NodeV1[],
  uses: ReadonlyMap<string, { name: string; specifier: string }>,
): FileHttpFacts | undefined {
  // Cheap gates: no call at all means nothing here; no router API, no routes.
  if (!/->|::/.test(source)) return undefined;
  const routey = /Route::|\$router\b|->router\b|withRouting|\$app->|->group\s*\(|\b(require|include)(_once)?\b/.test(source);

  const file: FileCtx = { namespace: "", uses, consts: new Map(), props: new Map(), globals: new Map() };
  const collect = (n: SyntaxNode, top: boolean): void => {
    if (n.type === "namespace_definition") {
      file.namespace = n.childForFieldName("name")?.text ?? n.namedChildren.find((c) => c.type === "namespace_name")?.text ?? "";
    } else if (n.type === "const_element") {
      const name = n.namedChildren[0];
      if (name) setOnce(file.consts, name.text, n.namedChildren[1] ?? null);
    } else if (n.type === "property_element") {
      const v = n.namedChildren[0];
      if (v?.type === "variable_name") setOnce(file.props, v.text.replace(/^\$/, ""), n.namedChildren[1] ?? null);
    } else if (top && n.type === "assignment_expression") {
      const left = n.childForFieldName("left");
      if (left?.type === "variable_name") setOnce(file.globals, left.text.replace(/^\$/, ""), n.childForFieldName("right"));
    }
    const nextTop = top && !FUNCTION_TYPES.has(n.type) && n.type !== "class_declaration";
    for (const c of n.namedChildren) collect(c, nextTop);
  };
  collect(root, true);

  const facts: FileHttpFacts = { routes: [], mounts: [], sites: [] };
  if (routey) {
    const w = new RouteWalker(file);
    w.walk(root, { prefix: "", namespace: null, controller: null, receivers: new Set(["router"]), fileLevel: true });
    facts.routes = w.routes;
    facts.mounts = w.mounts;
  }

  // Call sites, attributed to the nearest named function (a closure only at file level).
  const bySpan = new Map<string, string>();
  for (const n of nodes) if (n.kind === "method" || n.kind === "function") if (!bySpan.has(n.span)) bySpan.set(n.span, n.id);
  const idOf = (fn: SyntaxNode) => bySpan.get(`L${fn.startPosition.row + 1}-L${fn.endPosition.row + 1}`);
  const envs = new Map<number, Env>();
  const envOf = (fn: SyntaxNode) => {
    let e = envs.get(fn.id);
    if (!e) envs.set(fn.id, (e = functionEnv(fn)));
    return e;
  };
  const verbs = new Map<number, string | undefined>();
  const visit = (n: SyntaxNode, owner: string | null, fn: SyntaxNode | null, cls: SyntaxNode | null): void => {
    if (FUNCTION_TYPES.has(n.type)) {
      const named = n.type === "method_declaration" || n.type === "function_definition";
      const id = idOf(n);
      if (id && (named || owner === null)) owner = id;
      fn = n;
    } else if (n.type === "class_declaration" || n.type === "trait_declaration") {
      cls = n;
    } else if (CALL_TYPES.has(n.type) && owner && fn) {
      const callee = callName(n);
      const ctx: RouteCtx = { prefix: "", namespace: null, controller: null, receivers: new Set(["router"]), fileLevel: !cls };
      if (callee && !isRouterRoot(chainOf(n).root, ctx)) {
        const env = envOf(fn);
        const args = argValues(n).map((a) => argFact(a.value, env, file));
        if (args.some((a) => a !== null && (a.p !== undefined || (a.s !== undefined && clientPath(a.s) !== null)))) {
          if (cls && !verbs.has(cls.id)) verbs.set(cls.id, classVerb(cls, file));
          const verb = cls ? verbs.get(cls.id) : undefined;
          facts.sites.push({ source: owner, callee, args, line: lineOf(n), ...(verb ? { verb } : {}) });
        }
      }
    }
    for (const c of n.namedChildren) visit(c, owner, fn, cls);
  };
  visit(root, null, null, null);

  return facts.routes.length || facts.mounts.length || facts.sites.length ? facts : undefined;
}

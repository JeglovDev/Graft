/**
 * Member calls whose receiver is typed statically, for PHP: the facts behind
 * method-level links between the repos of a workspace.
 *
 * Inside one repo `resolve.ts` types a receiver by its bare class name and drops
 * what it cannot finish, so a service's `BankSDK::balance()->getUserBalance()`
 * leaves no trace: the facade lives in another repo, and the chain needs the
 * return type of `balance()`. Here the same calls are kept as typed chains with
 * fully-qualified names, in three passes:
 *
 *   1. per file (`extractPhpCalls`): every class's FQCN, parent, interfaces and
 *      traits, the class its methods return (declared type, `self`/`static`,
 *      `@return`), its property types (typed, promoted, `@var`, assigned from a
 *      typed constructor parameter or `new`), `@method` docblocks and a facade's
 *      accessor; container bindings (`->singleton('key', fn () => new X)`); and
 *      each member or static call whose receiver chain starts at something typed:
 *      a class (`X::`), `new X`, `$this`, a typed parameter, a local assigned once,
 *      `app(X::class)`;
 *   2. per repo (`assemblePhpCalls`, at build): each chain is walked through the
 *      repo's own classes. One that ends in the repo is `resolve.ts`'s business and
 *      one that breaks there can never be finished, so both are dropped; a chain
 *      that reaches a class the repo does not define is kept from that point on;
 *   3. per workspace (`resolveChain`, from `workspace-links.ts`): the kept chains
 *      continue through the other repos' classes, facades and bindings, and a chain
 *      that ends on one method node of another repo becomes a `calls` link.
 *
 * Every step must be unambiguous: one class for an FQCN, one method of that name
 * on the class, its traits or parents, one binding for a key. A chain stops at the
 * first step that is not.
 */
import type { SyntaxNode } from "./depth-parser.js";
import type {
  EdgeV1,
  NodeV1,
  PhpBindFactV1 as PhpBindFact,
  PhpCallFactV1 as PhpCallFact,
  PhpClassFactV1 as PhpClassFact,
  PhpFactsV1,
} from "./types.js";

/** A typed call site of one file, with its line. */
export interface FilePhpCall extends PhpCallFact {
  l: number;
}

/** One file's facts: every class with a node, every binding, every typed call. */
export interface FilePhpFacts {
  classes: PhpClassFact[];
  binds: PhpBindFact[];
  calls: FilePhpCall[];
}

/** A call's chain without its caller: where it starts and where it goes. */
export type PhpChain = Omit<PhpCallFact, "s">;

export const FACADE_BASE = "Illuminate\\Support\\Facades\\Facade";

const CALL_TYPES = new Set(["member_call_expression", "nullsafe_member_call_expression", "scoped_call_expression"]);
const FUNCTION_TYPES = new Set(["method_declaration", "function_definition", "anonymous_function", "arrow_function"]);
const CLASS_TYPES: Record<string, string> = {
  class_declaration: "class",
  interface_declaration: "interface",
  trait_declaration: "trait",
  enum_declaration: "enum",
};
const BIND_METHODS = new Set(["singleton", "bind", "scoped", "instance", "singletonif", "bindif", "scopedif"]);
const CONTAINER_FUNCTIONS = new Set(["app", "resolve"]);
const MAKE_METHODS = new Set(["make", "makewith", "get"]);
const NOT_A_CLASS = new Set([
  "array", "string", "int", "integer", "float", "double", "bool", "boolean", "mixed", "void", "null", "callable",
  "iterable", "object", "never", "false", "true", "resource", "numeric", "scalar", "list", "parent",
]);
const MAX_EXPR_DEPTH = 8;

interface FileCtx {
  namespace: string;
  uses: ReadonlyMap<string, { name: string; specifier: string }>;
}

interface ClassCtx {
  fqcn: string;
  ext: string | null;
  /** Methods the class declares itself: `$this->m()` on one of them is resolve.ts's. */
  own: ReadonlySet<string>;
}

/** A class name as written → FQCN, through the file's `use` statements and namespace. */
function resolveClass(text: string, file: FileCtx): string {
  if (text.startsWith("\\")) return text.slice(1);
  const [head, ...rest] = text.split("\\");
  const use = file.uses.get(head!);
  if (use) return [use.specifier, ...rest].join("\\");
  return file.namespace ? `${file.namespace}\\${text}` : text;
}

/** A docblock or source type → the one class it names, or null (primitive, array,
 * a union of two classes). `self`/`static`/`$this` are the enclosing class. */
function typeFromText(raw: string, file: FileCtx, cls: string | null): string | null {
  const parts = raw
    .trim()
    .replace(/^\?/, "")
    .split("|")
    .map((p) => p.trim().replace(/^\(|\)$/g, ""))
    .filter((p) => p && p.toLowerCase() !== "null");
  if (parts.length !== 1) return null;
  const t = parts[0]!.replace(/<.*$/s, "");
  if (!t || t.endsWith("[]") || t.includes("&") || t.includes("{")) return null;
  const lower = t.toLowerCase();
  if (lower === "self" || lower === "static" || lower === "$this") return cls;
  if (NOT_A_CLASS.has(lower) || !/^\\?[A-Za-z_][\w\\]*$/.test(t)) return null;
  return resolveClass(t, file);
}

/** A source type node (`Foo`, `?Foo`, `Foo|null`, `self`) → its class, or null. */
function typeFromNode(n: SyntaxNode | null | undefined, file: FileCtx, cls: string | null): string | null {
  if (!n) return null;
  if (n.type === "primitive_type" || n.type === "bottom_type" || n.type === "intersection_type") return null;
  return typeFromText(n.text, file, cls);
}

/** The `/** … *\/` comment directly before `n`, if any. */
function docOf(n: SyntaxNode): string | null {
  const prev = n.previousNamedSibling;
  return prev?.type === "comment" && prev.text.startsWith("/**") ? prev.text : null;
}

function docTag(doc: string | null, tag: string): string | null {
  if (!doc) return null;
  const m = new RegExp(`@${tag}\\s+(\\S+)`).exec(doc);
  return m ? m[1]! : null;
}

function bodyOf(n: SyntaxNode): SyntaxNode | null {
  return n.childForFieldName("body") ?? n.namedChildren.find((c) => c.type === "declaration_list" || c.type === "compound_statement") ?? null;
}

function paramsOf(fn: SyntaxNode): SyntaxNode[] {
  const list = fn.childForFieldName("parameters") ?? fn.namedChildren.find((c) => c.type === "formal_parameters");
  return list ? [...list.namedChildren] : [];
}

function paramName(p: SyntaxNode): string | null {
  const v = p.childForFieldName("name") ?? p.namedChildren.find((c) => c.type === "variable_name");
  return v?.type === "variable_name" ? v.text.replace(/^\$/, "") : null;
}

function argValues(call: SyntaxNode): SyntaxNode[] {
  const args = call.childForFieldName("arguments") ?? call.namedChildren.find((c) => c.type === "arguments");
  const out: SyntaxNode[] = [];
  for (const a of args?.namedChildren ?? []) {
    if (a.type !== "argument") continue;
    const v = a.namedChildren[a.namedChildren.length - 1];
    if (v) out.push(v);
  }
  return out;
}

function stringLiteral(n: SyntaxNode | undefined): string | null {
  if (!n || (n.type !== "string" && n.type !== "encapsed_string")) return null;
  if (n.namedChildren.some((c) => c.type !== "string_content" && c.type !== "string_value")) return null;
  return n.text.replace(/^[bB]?(['"])([\s\S]*)\1$/, "$2");
}

/** `X::class` → the FQCN of X. */
function classConst(n: SyntaxNode | undefined, file: FileCtx, cls: ClassCtx | null): string | null {
  if (n?.type !== "class_constant_access_expression") return null;
  const scope = n.namedChildren[0];
  const member = n.namedChildren[n.namedChildren.length - 1];
  if (!scope || member?.text !== "class") return null;
  if (scope.type === "relative_scope" || scope.text === "self" || scope.text === "static") return cls?.fqcn ?? null;
  if (scope.type !== "name" && scope.type !== "qualified_name") return null;
  return resolveClass(scope.text, file);
}

/** `new X(…)` → the FQCN of X (`new self`/`new static` → the enclosing class). */
function newType(n: SyntaxNode, file: FileCtx, cls: ClassCtx | null): string | null {
  const c = n.namedChildren.find((k) => k.type === "name" || k.type === "qualified_name" || k.type === "relative_scope");
  if (!c) return null;
  if (c.type === "relative_scope" || c.text === "self" || c.text === "static") return cls?.fqcn ?? null;
  return resolveClass(c.text, file);
}

/** A receiver: its root (a class, or `k:<key>`), whether that root is static, and
 * the steps taken from it. */
interface Recv {
  r: string;
  st: boolean;
  p: string[];
}

/** What a function knows about its variables: typed parameters, locals assigned
 * exactly once (their right-hand side), `@var T $x` comments. */
interface Env {
  params: Map<string, string | null>;
  locals: Map<string, SyntaxNode | null>;
  docVars: Map<string, string | null>;
}

function setOnce<T>(m: Map<string, T | null>, k: string, v: T | null): void {
  m.set(k, m.has(k) ? null : v);
}

function functionEnv(fn: SyntaxNode, file: FileCtx, cls: ClassCtx | null): Env {
  const params = new Map<string, string | null>();
  for (const p of paramsOf(fn)) {
    const name = paramName(p);
    if (name) params.set(name, typeFromNode(p.childForFieldName("type"), file, cls?.fqcn ?? null));
  }
  const locals = new Map<string, SyntaxNode | null>();
  const docVars = new Map<string, string | null>();
  const visit = (n: SyntaxNode): void => {
    if (n.id !== fn.id && FUNCTION_TYPES.has(n.type)) return;
    if (n.type === "assignment_expression") {
      const left = n.childForFieldName("left");
      if (left?.type === "variable_name") setOnce(locals, left.text.replace(/^\$/, ""), n.childForFieldName("right"));
    } else if (n.type === "comment" && n.text.startsWith("/**")) {
      const m = /@var\s+(\S+)\s+\$(\w+)/.exec(n.text);
      if (m) setOnce(docVars, m[2]!, typeFromText(m[1]!, file, cls?.fqcn ?? null));
    } else if (n.type === "foreach_statement" || n.type === "catch_clause" || n.type === "list_literal") {
      // A loop or catch variable is re-bound on each pass: never "assigned once".
      const vars = (k: SyntaxNode): void => {
        if (k.type === "variable_name") setOnce(locals, k.text.replace(/^\$/, ""), null);
        else if (!FUNCTION_TYPES.has(k.type) && k.type !== "compound_statement") for (const c of k.namedChildren) vars(c);
      };
      vars(n);
    }
    for (const c of n.namedChildren) visit(c);
  };
  const body = bodyOf(fn) ?? fn.namedChildren[fn.namedChildren.length - 1];
  if (body) visit(body);
  return { params, locals, docVars };
}

/** The typed receiver an expression evaluates to, or null when nothing types it. */
function recvOf(n: SyntaxNode | null | undefined, env: Env, file: FileCtx, cls: ClassCtx | null, depth = 0): Recv | null {
  if (!n || depth > MAX_EXPR_DEPTH) return null;
  const step = (inner: SyntaxNode | null, s: string): Recv | null => {
    const base = recvOf(inner, env, file, cls, depth + 1);
    return base ? { r: base.r, st: base.st, p: [...base.p, s] } : null;
  };
  switch (n.type) {
    case "parenthesized_expression":
      return recvOf(n.namedChildren[0], env, file, cls, depth + 1);
    case "object_creation_expression": {
      const t = newType(n, file, cls);
      return t ? { r: t, st: false, p: [] } : null;
    }
    case "variable_name": {
      const name = n.text.replace(/^\$/, "");
      if (name === "this") return cls ? { r: cls.fqcn, st: false, p: [] } : null;
      const doc = env.docVars.get(name);
      if (doc) return { r: doc, st: false, p: [] };
      if (env.params.has(name)) {
        const t = env.params.get(name);
        return t ? { r: t, st: false, p: [] } : null;
      }
      const local = env.locals.get(name);
      return local ? recvOf(local, env, file, cls, depth + 1) : null;
    }
    case "member_access_expression":
    case "nullsafe_member_access_expression": {
      const name = n.childForFieldName("name");
      return name?.type === "name" ? step(n.childForFieldName("object"), name.text) : null;
    }
    case "member_call_expression":
    case "nullsafe_member_call_expression": {
      const name = n.childForFieldName("name");
      if (name?.type !== "name") return null;
      const obj = n.childForFieldName("object");
      // `app()->make(X::class)`
      if (MAKE_METHODS.has(name.text.toLowerCase()) && obj?.type === "function_call_expression") {
        const fn = obj.childForFieldName("function")?.text.replace(/^\\/, "").toLowerCase();
        if (fn && CONTAINER_FUNCTIONS.has(fn) && argValues(obj).length === 0) return containerRecv(argValues(n)[0], file, cls);
      }
      return step(obj, `${name.text}()`);
    }
    case "scoped_call_expression": {
      const name = n.childForFieldName("name");
      if (name?.type !== "name") return null;
      const root = scopeRecv(n.childForFieldName("scope"), env, file, cls, depth);
      return root ? { r: root.r, st: root.st, p: [...root.p, `${name.text}()`] } : null;
    }
    case "function_call_expression": {
      const fn = n.childForFieldName("function")?.text.replace(/^\\/, "").toLowerCase();
      if (!fn || !CONTAINER_FUNCTIONS.has(fn)) return null;
      return containerRecv(argValues(n)[0], file, cls);
    }
    default:
      return null;
  }
}

/** `app(X::class)` / `app('key')`: what the container hands back. */
function containerRecv(arg: SyntaxNode | undefined, file: FileCtx, cls: ClassCtx | null): Recv | null {
  const c = classConst(arg, file, cls);
  if (c) return { r: c, st: false, p: [] };
  const key = stringLiteral(arg);
  return key ? { r: `k:${key}`, st: false, p: [] } : null;
}

/** The scope of `X::m()`: a class (static), `self`/`static` (static), `parent`
 * (the parent class, called on this instance), or an expression (`$x::m()`). */
function scopeRecv(scope: SyntaxNode | null, env: Env, file: FileCtx, cls: ClassCtx | null, depth: number): Recv | null {
  if (!scope) return null;
  const text = scope.text;
  if (text === "parent") return cls?.ext ? { r: cls.ext, st: false, p: [] } : null;
  if (scope.type === "relative_scope" || text === "self" || text === "static") return cls ? { r: cls.fqcn, st: true, p: [] } : null;
  if (scope.type === "name" || scope.type === "qualified_name") return { r: resolveClass(text, file), st: true, p: [] };
  // `$x::m()` is a static call on the class of `$x`.
  const r = recvOf(scope, env, file, cls, depth + 1);
  return r && r.p.length === 0 ? { ...r, st: true } : null;
}

/** The FQCN a closure or arrow function builds: every `return new X` (or the arrow
 * body) names the same class. */
function builtType(fn: SyntaxNode, file: FileCtx, cls: ClassCtx | null): string | null {
  const exprs: SyntaxNode[] = [];
  if (fn.type === "arrow_function") {
    const body = fn.childForFieldName("body") ?? fn.namedChildren[fn.namedChildren.length - 1];
    if (body) exprs.push(body);
  } else {
    const visit = (n: SyntaxNode): void => {
      if (n.id !== fn.id && FUNCTION_TYPES.has(n.type)) return;
      if (n.type === "return_statement" && n.namedChildren[0]) exprs.push(n.namedChildren[0]);
      for (const c of n.namedChildren) visit(c);
    };
    visit(fn);
  }
  const types = new Set<string | null>();
  for (let e of exprs) {
    while (e.type === "parenthesized_expression" && e.namedChildren[0]) e = e.namedChildren[0];
    types.add(e.type === "object_creation_expression" ? newType(e, file, cls) : null);
  }
  return types.size === 1 ? [...types][0]! : null;
}

/** `->singleton('key', fn () => new X)`, `->bind(I::class, X::class)`,
 * `->instance('key', new X)`. */
function bindingOf(call: SyntaxNode, file: FileCtx, cls: ClassCtx | null): PhpBindFact | null {
  const name = call.childForFieldName("name")?.text.toLowerCase();
  if (!name || !BIND_METHODS.has(name)) return null;
  const [keyArg, value] = argValues(call);
  const k = stringLiteral(keyArg) ?? classConst(keyArg, file, cls);
  if (!k || !value) return null;
  let t: string | null = null;
  if (value.type === "anonymous_function" || value.type === "arrow_function") t = builtType(value, file, cls);
  else if (value.type === "object_creation_expression") t = newType(value, file, cls);
  else t = classConst(value, file, cls);
  return t && t !== k ? { k, t } : null;
}

/** The facade accessor a `getFacadeAccessor` body returns. */
function accessorOf(method: SyntaxNode, file: FileCtx, cls: ClassCtx): string | null {
  const values = new Set<string | null>();
  const visit = (n: SyntaxNode): void => {
    if (n.id !== method.id && FUNCTION_TYPES.has(n.type)) return;
    if (n.type === "return_statement") {
      const v = n.namedChildren[0];
      const key = stringLiteral(v);
      const c = classConst(v, file, cls);
      values.add(key !== null ? `k:${key}` : c ? `c:${c}` : null);
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(method);
  return values.size === 1 ? [...values][0]! : null;
}

function nameOf(n: SyntaxNode): string | null {
  return n.childForFieldName("name")?.text ?? null;
}

function lineSpan(n: SyntaxNode): string {
  return `L${n.startPosition.row + 1}-L${n.endPosition.row + 1}`;
}

/**
 * PHP class facts, container bindings and typed member calls of one file, or
 * undefined when it has none. `nodes` are the file's extracted nodes, so a class
 * and a call site name their node ids.
 */
export function extractPhpCalls(
  source: string,
  root: SyntaxNode,
  nodes: readonly NodeV1[],
  uses: ReadonlyMap<string, { name: string; specifier: string }>,
): FilePhpFacts | undefined {
  if (!/\b(class|interface|trait|enum)\b|->|::/.test(source)) return undefined;
  const rel = nodes[0]?.path ?? "";
  const out: FilePhpFacts = { classes: [], binds: [], calls: [] };

  const typeNodes = new Map<string, NodeV1[]>();
  for (const n of nodes) {
    if (n.kind !== "class" && n.kind !== "interface" && n.kind !== "trait" && n.kind !== "enum") continue;
    const arr = typeNodes.get(n.name);
    if (arr) arr.push(n);
    else typeNodes.set(n.name, [n]);
  }
  const classNodeId = (decl: SyntaxNode, name: string): string | null => {
    const cands = typeNodes.get(name) ?? [];
    if (cands.length === 1) return cands[0]!.id;
    return cands.find((c) => c.span === lineSpan(decl))?.id ?? null;
  };
  const bySpan = new Map<string, string>();
  for (const n of nodes) if ((n.kind === "method" || n.kind === "function") && !bySpan.has(n.span)) bySpan.set(n.span, n.id);

  // File-level comments, for a class whose docblock sits above its `use` lines.
  const topComments: SyntaxNode[] = [];
  let classCount = 0;
  const countClasses = (n: SyntaxNode): void => {
    if (CLASS_TYPES[n.type]) classCount++;
    else if (n.type === "comment" && n.text.includes("@method")) topComments.push(n);
    else if (n.type === "namespace_definition" || n.type === "compound_statement" || n.type === "program") {
      for (const c of n.namedChildren) countClasses(c);
    }
  };
  countClasses(root);

  const classFact = (decl: SyntaxNode, file: FileCtx): { ctx: ClassCtx; fact: PhpClassFact | null } | null => {
    const name = nameOf(decl);
    if (!name) return null;
    const fqcn = file.namespace ? `${file.namespace}\\${name}` : name;
    let ext: string | null = null;
    const impl: string[] = [];
    for (const clause of decl.namedChildren) {
      const names = clause.namedChildren.filter((t) => t.type === "name" || t.type === "qualified_name").map((t) => resolveClass(t.text, file));
      if (clause.type === "base_clause") {
        // An interface may extend several; a class has one parent.
        if (decl.type === "interface_declaration") impl.push(...names);
        else ext = names[0] ?? null;
      } else if (clause.type === "class_interface_clause") impl.push(...names);
    }
    const body = bodyOf(decl);
    const members = body ? [...body.namedChildren] : [];
    const own = new Set<string>();
    for (const m of members) if (m.type === "method_declaration") own.add((nameOf(m) ?? "").toLowerCase());
    const ctx: ClassCtx = { fqcn, ext, own };
    const id = classNodeId(decl, name);
    if (!id) return { ctx, fact: null };

    const traits: string[] = [];
    const ret: Record<string, string> = {};
    const props: Record<string, string> = {};
    const doc: Record<string, string> = {};
    let acc: string | null = null;
    const assigned = new Map<string, string | null>();

    for (const m of members) {
      if (m.type === "use_declaration") {
        for (const t of m.namedChildren) if (t.type === "name" || t.type === "qualified_name") traits.push(resolveClass(t.text, file));
      } else if (m.type === "property_declaration") {
        const t = typeFromNode(m.childForFieldName("type"), file, fqcn) ?? (() => {
          const v = docTag(docOf(m), "var");
          return v ? typeFromText(v, file, fqcn) : null;
        })();
        for (const el of m.namedChildren) {
          if (el.type !== "property_element") continue;
          const v = el.childForFieldName("name") ?? el.namedChildren[0];
          if (t && v?.type === "variable_name") props[v.text.replace(/^\$/, "")] = t;
        }
      } else if (m.type === "method_declaration") {
        const mname = nameOf(m);
        if (!mname) continue;
        const declared = typeFromNode(m.childForFieldName("return_type"), file, fqcn);
        const r = declared ?? (() => {
          const v = docTag(docOf(m), "return");
          return v ? typeFromText(v, file, fqcn) : null;
        })();
        if (r) ret[mname] = r;
        if (mname === "getFacadeAccessor") acc = accessorOf(m, file, ctx);
        const env = functionEnv(m, file, ctx);
        for (const p of paramsOf(m)) {
          if (p.type !== "property_promotion_parameter") continue;
          const pn = paramName(p);
          const pt = typeFromNode(p.childForFieldName("type"), file, fqcn);
          if (pn && pt) props[pn] = pt;
        }
        // `$this->x = $typedParam` / `$this->x = new X`: the type of an untyped property.
        const visit = (n: SyntaxNode): void => {
          if (n.id !== m.id && FUNCTION_TYPES.has(n.type)) return;
          if (n.type === "assignment_expression") {
            const left = n.childForFieldName("left");
            const right = n.childForFieldName("right");
            if (left?.type === "member_access_expression" && left.childForFieldName("object")?.text === "$this") {
              const pn = left.childForFieldName("name");
              if (pn?.type === "name" && right) {
                const rv = recvOf(right, env, file, ctx);
                setOnce(assigned, pn.text, rv && rv.p.length === 0 && !rv.st && !rv.r.startsWith("k:") ? rv.r : null);
              }
            }
          }
          for (const c of n.namedChildren) visit(c);
        };
        const mb = bodyOf(m);
        if (mb) visit(mb);
      }
    }
    for (const [pn, t] of assigned) if (t && !(pn in props)) props[pn] = t;

    let classDoc = docOf(decl);
    if (!classDoc?.includes("@method") && classCount === 1) classDoc = topComments.map((c) => c.text).join("\n") || classDoc;
    for (const mm of (classDoc ?? "").matchAll(/@method\s+(?:static\s+)?(?:([^\s(]+)\s+)?(\w+)\s*\(/g)) {
      const t = mm[1] ? typeFromText(mm[1], file, fqcn) : null;
      if (t) doc[mm[2]!] = t;
    }

    const fact: PhpClassFact = { id, fqcn };
    if (ext) fact.ext = ext;
    if (impl.length) fact.impl = impl;
    if (traits.length) fact.traits = traits;
    if (Object.keys(ret).length) fact.ret = ret;
    if (Object.keys(props).length) fact.props = props;
    if (Object.keys(doc).length) fact.doc = doc;
    if (acc) fact.acc = acc;
    return { ctx, fact };
  };

  const envs = new Map<number, Env>();
  const visit = (n: SyntaxNode, file: FileCtx, cls: ClassCtx | null, owner: string, fn: SyntaxNode | null): void => {
    if (n.type === "namespace_definition") {
      const ns = n.childForFieldName("name")?.text ?? n.namedChildren.find((c) => c.type === "namespace_name")?.text ?? "";
      const body = n.childForFieldName("body") ?? n.namedChildren.find((c) => c.type === "compound_statement");
      if (body) {
        for (const c of body.namedChildren) visit(c, { ...file, namespace: ns }, cls, owner, fn);
      } else {
        file.namespace = ns; // `namespace X;` holds for the rest of the file
      }
      return;
    }
    if (CLASS_TYPES[n.type]) {
      const r = classFact(n, file);
      if (r?.fact) out.classes.push(r.fact);
      cls = r?.ctx ?? cls;
    } else if (FUNCTION_TYPES.has(n.type)) {
      const named = n.type === "method_declaration" || n.type === "function_definition";
      const id = bySpan.get(lineSpan(n));
      if (id && (named || owner === rel)) owner = id;
      fn = n;
    } else if (CALL_TYPES.has(n.type)) {
      const env = fn ? (envs.get(fn.id) ?? envs.set(fn.id, functionEnv(fn, file, cls)).get(fn.id)!) : EMPTY_ENV;
      if (n.type !== "scoped_call_expression") {
        const b = bindingOf(n, file, cls);
        if (b) out.binds.push(b);
      }
      const name = n.childForFieldName("name");
      if (name?.type === "name") {
        const recv =
          n.type === "scoped_call_expression"
            ? scopeRecv(n.childForFieldName("scope"), env, file, cls, 0)
            : recvOf(n.childForFieldName("object"), env, file, cls);
        // `$this->own()` / `self::own()` is what resolve.ts already links.
        const local = recv && cls && recv.r === cls.fqcn && recv.p.length === 0 && cls.own.has(name.text.toLowerCase());
        if (recv && !local) {
          out.calls.push({
            s: owner,
            r: recv.r,
            ...(recv.st ? { st: 1 as const } : {}),
            ...(recv.p.length ? { p: recv.p } : {}),
            m: name.text,
            l: n.startPosition.row + 1,
          });
        }
      }
    }
    for (const c of n.namedChildren) visit(c, file, cls, owner, fn);
  };
  const file: FileCtx = { namespace: "", uses };
  visit(root, file, null, rel, null);

  return out.classes.length || out.binds.length || out.calls.length ? out : undefined;
}

const EMPTY_ENV: Env = { params: new Map(), locals: new Map(), docVars: new Map() };

// ---------------------------------------------------------------------------
// Resolution, shared by the per-repo and the per-workspace pass.

/** A class as the resolver sees it: where it lives and its facts, if it has any. */
export interface ClassRef {
  child: string;
  id: string;
  fact: PhpClassFact | undefined;
}

/**
 * The classes a chain walks through. `cls` answers null for an FQCN this world
 * does not hold; `methods` lists the method node ids a class declares itself;
 * `bound` is the class a container key stands for.
 */
export interface PhpWorld {
  cls(fqcn: string): ClassRef | "ambiguous" | null;
  methods(ref: ClassRef, name: string): string[];
  bound(key: string, prefer: string | null): string | "ambiguous" | null;
}

export type ChainFailure = "ambiguous" | "untyped" | "no-method";

export type ChainResult =
  | { ok: true; child: string; target: string }
  | { ok: false; why: ChainFailure }
  /** The chain reached a class this world does not hold: resume there. */
  | { ok: false; why: "outside"; rest: PhpChain };

interface Found {
  /** null: known only from a `@method` docblock, which no node stands for. */
  ref: ClassRef | null;
  id: string | null;
  ret: string | null;
}

type Lookup = Found | "ambiguous" | "none" | { outside: string };

const MAX_CHAIN = 6;

/** PHP method names are case-insensitive: `v2player()` calls `v2Player()`. */
function anyCase(rec: Record<string, string> | undefined, name: string): string | null {
  if (!rec) return null;
  if (name in rec) return rec[name]!;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(rec)) if (k.toLowerCase() === lower) return v;
  return null;
}

/** Method `name` on class `fqcn`: its own, then its traits', then its parent's;
 * a facade forwards a static call to the class its accessor is bound to; a
 * `@method` docblock and then the interfaces come last. */
function findMethod(world: PhpWorld, fqcn: string, name: string, isStatic: boolean, depth = 0): Lookup {
  if (depth > MAX_CHAIN) return "none";
  const ref = world.cls(fqcn);
  if (ref === "ambiguous") return "ambiguous";
  if (ref === null) return { outside: fqcn };
  const ids = world.methods(ref, name);
  if (ids.length > 1) return "ambiguous";
  if (ids.length === 1) return { ref, id: ids[0]!, ret: anyCase(ref.fact?.ret, name) ?? anyCase(ref.fact?.doc, name) };

  const fact = ref.fact;
  const viaTraits: Found[] = [];
  for (const t of fact?.traits ?? []) {
    const hit = findMethod(world, t, name, isStatic, depth + 1);
    if (hit === "ambiguous") return "ambiguous";
    if (typeof hit === "object" && "id" in hit && hit.id) viaTraits.push(hit);
  }
  if (viaTraits.length > 1 && new Set(viaTraits.map((h) => h.id)).size > 1) return "ambiguous";
  if (viaTraits.length) return viaTraits[0]!;

  if (isStatic && isFacade(world, fqcn, depth)) {
    const fwd = facadeTarget(world, ref, name, depth);
    if (fwd) return fwd;
  }
  let parentOutside: string | null = null;
  if (fact?.ext && fact.ext !== FACADE_BASE) {
    const hit = findMethod(world, fact.ext, name, isStatic, depth + 1);
    if (hit === "ambiguous") return hit;
    if (typeof hit === "object" && "id" in hit) return hit;
    if (typeof hit === "object" && "outside" in hit) parentOutside = hit.outside;
  }
  const doc = anyCase(fact?.doc, name);
  if (doc) return { ref: null, id: null, ret: doc };
  if (parentOutside) return { outside: parentOutside };
  for (const i of fact?.impl ?? []) {
    const hit = findMethod(world, i, name, isStatic, depth + 1);
    if (hit === "ambiguous") return hit;
    if (typeof hit === "object" && "id" in hit) return hit;
  }
  return "none";
}

function isFacade(world: PhpWorld, fqcn: string, depth: number): boolean {
  for (let cur: string | undefined = fqcn, d = depth; cur && d <= MAX_CHAIN; d++) {
    if (cur === FACADE_BASE) return true;
    const ref = world.cls(cur);
    if (!ref || ref === "ambiguous") return false;
    cur = ref.fact?.ext;
  }
  return false;
}

/** The instance method a facade's static `name()` forwards to: the nearest
 * accessor up its chain, bound in the facade's own repo first. */
function facadeTarget(world: PhpWorld, facade: ClassRef, name: string, depth: number): Found | null {
  let holder: ClassRef = facade;
  for (let d = depth; !holder.fact?.acc && holder.fact?.ext && d <= MAX_CHAIN; d++) {
    const up = world.cls(holder.fact.ext);
    if (!up || up === "ambiguous") return null;
    holder = up;
  }
  const acc = holder.fact?.acc;
  if (!acc) return null;
  const key = acc.slice(2);
  const bound = world.bound(key, holder.child);
  const target = bound === "ambiguous" ? null : (bound ?? (acc.startsWith("c:") ? key : null));
  if (!target) return null;
  const hit = findMethod(world, target, name, false, depth + 1);
  return typeof hit === "object" && "id" in hit && hit.id ? hit : null;
}

/** Walk `call` from its root through its steps to the method it calls. */
export function resolveChain(world: PhpWorld, call: PhpChain, from: string | null = null): ChainResult {
  let type = call.r;
  let isStatic = !!call.st;
  const steps = [...(call.p ?? []), `${call.m}()`];
  for (let i = 0; i < steps.length; i++) {
    const rest = (t: string, st: boolean): ChainResult => {
      const tail = steps.slice(i);
      const m = tail.pop()!.slice(0, -2);
      return { ok: false, why: "outside", rest: { r: t, ...(st ? { st: 1 as const } : {}), ...(tail.length ? { p: tail } : {}), m } };
    };
    if (type.startsWith("k:")) {
      const b = world.bound(type.slice(2), from);
      if (b === "ambiguous") return { ok: false, why: "ambiguous" };
      if (!b) return rest(type, isStatic);
      type = b;
    }
    const s = steps[i]!;
    const last = i === steps.length - 1;
    if (!s.endsWith("()")) {
      const t = propType(world, type, s);
      if (t === "ambiguous") return { ok: false, why: "ambiguous" };
      if (t && typeof t === "object") return rest(t.outside, false);
      if (!t) return { ok: false, why: "untyped" };
      type = t;
      isStatic = false;
      continue;
    }
    const hit = findMethod(world, type, s.slice(0, -2), isStatic);
    if (hit === "ambiguous") return { ok: false, why: "ambiguous" };
    if (hit === "none") return { ok: false, why: "no-method" };
    if ("outside" in hit) return rest(hit.outside, isStatic);
    if (last) {
      if (!hit.ref || !hit.id) return { ok: false, why: "no-method" };
      return { ok: true, child: hit.ref.child, target: hit.id };
    }
    if (!hit.ret) return { ok: false, why: "untyped" };
    // A fluent method of a parent returns `self`/`static`/`$this`: the object is
    // still the receiver, whose own methods the chain goes on to call.
    if (hit.ret !== hit.ref?.fact?.fqcn) type = hit.ret;
    isStatic = false;
  }
  return { ok: false, why: "untyped" };
}

/** Property `name` of class `fqcn`, through its parents and traits. */
function propType(world: PhpWorld, fqcn: string, name: string, depth = 0): string | null | "ambiguous" | { outside: string } {
  if (depth > MAX_CHAIN) return null;
  const ref = world.cls(fqcn);
  if (ref === "ambiguous") return "ambiguous";
  if (ref === null) return { outside: fqcn };
  const own = ref.fact?.props?.[name];
  if (own) return own;
  for (const t of ref.fact?.traits ?? []) {
    const hit = propType(world, t, name, depth + 1);
    if (typeof hit === "string") return hit;
  }
  return ref.fact?.ext && ref.fact.ext !== FACADE_BASE ? propType(world, ref.fact.ext, name, depth + 1) : null;
}

/** Method node ids per class node id and lower-cased method name, from a graph's
 * `contains` edges. */
export function methodIndex(nodes: readonly NodeV1[], edges: readonly EdgeV1[]): Map<string, Map<string, string[]>> {
  const methods = new Map<string, NodeV1>();
  for (const n of nodes) if (n.kind === "method") methods.set(n.id, n);
  const out = new Map<string, Map<string, string[]>>();
  for (const e of edges) {
    if (e.relation !== "contains") continue;
    const m = methods.get(e.target);
    if (!m) continue;
    let byName = out.get(e.source);
    if (!byName) out.set(e.source, (byName = new Map()));
    const key = m.name.toLowerCase();
    const arr = byName.get(key);
    if (arr) arr.push(m.id);
    else byName.set(key, [m.id]);
  }
  return out;
}

/**
 * The repo's pass: each call is walked through the repo's own classes and kept,
 * from the first class the repo does not define, only when it leaves the repo.
 * Classes are kept when they carry typing another repo's chain may need.
 */
export function assemblePhpCalls(files: Map<string, FilePhpFacts>, nodes: readonly NodeV1[], edges: readonly EdgeV1[]): PhpFactsV1 | undefined {
  if (files.size === 0) return undefined;
  const classes: PhpClassFact[] = [];
  const binds: PhpBindFact[] = [];
  const byFqcn = new Map<string, PhpClassFact[]>();
  for (const f of files.values()) {
    classes.push(...f.classes);
    binds.push(...f.binds);
    for (const c of f.classes) {
      const arr = byFqcn.get(c.fqcn);
      if (arr) arr.push(c);
      else byFqcn.set(c.fqcn, [c]);
    }
  }
  const index = methodIndex(nodes, edges);
  const ids = new Set(nodes.map((n) => n.id));
  const bindsByKey = new Map<string, Set<string>>();
  for (const b of binds) {
    const s = bindsByKey.get(b.k) ?? new Set<string>();
    s.add(b.t);
    bindsByKey.set(b.k, s);
  }
  const world: PhpWorld = {
    cls(fqcn) {
      const hit = byFqcn.get(fqcn);
      if (hit?.length === 1) return { child: "", id: hit[0]!.id, fact: hit[0] };
      return hit && hit.length > 1 ? "ambiguous" : null;
    },
    methods: (ref, name) => index.get(ref.id)?.get(name.toLowerCase()) ?? [],
    bound(key) {
      const s = bindsByKey.get(key);
      if (!s) return null;
      return s.size === 1 ? [...s][0]! : "ambiguous";
    },
  };
  const calls: PhpCallFact[] = [];
  const seen = new Set<string>();
  for (const f of files.values()) {
    for (const c of f.calls) {
      if (!ids.has(c.s)) continue;
      const r = resolveChain(world, c);
      if (r.ok || r.why !== "outside") continue;
      const kept: PhpCallFact = { s: c.s, ...r.rest };
      const key = JSON.stringify(kept);
      if (seen.has(key)) continue;
      seen.add(key);
      calls.push(kept);
    }
  }
  const typed = classes.filter((c) => c.ext || c.impl || c.traits || c.ret || c.props || c.doc || c.acc);
  if (!typed.length && !binds.length && !calls.length) return undefined;
  return { classes: typed, binds, calls };
}

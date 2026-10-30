/**
 * `graph.json` — the code graph schema (v1).
 *
 * One node per definition (file, class, function, method, interface, type, enum),
 * wired by edges (contains, imports, calls, ...). Field names follow the LSP
 * vocabulary (`name`, `kind`, ...) rather than any one tool's conventions.
 *
 * Two tiers of data live on a node:
 *   - Tier-1 (deterministic, $0): everything from the AST. Rebuilt on every run.
 *   - Tier-2 (one LLM call, cached on `body_hash`): `summary` + `crux`.
 * M1 populates Tier-1 only; Tier-2 fields ship as `pending`/null.
 */

/** What a node represents. LSP SymbolKind, narrowed to what our extractors produce. */
export type Kind =
  | "file"
  | "class"
  | "function"
  | "method"
  | "interface" // TS + Go
  | "type" // TS + Go (type alias / named type)
  | "enum" // TS + PHP + Java
  | "struct" // Go only
  | "trait" // PHP only
  // The generic (tags.scm) breadth tier also emits these — every tree-sitter
  // grammar's tags.scm uses the tree-sitter tags @definition.<X> vocabulary, and
  // module/constant/variable are common across the long tail (Ruby modules,
  // Rust consts, top-level lets, …). Kept distinct rather than coerced so the
  // breadth tier's kinds read truthfully in cards/skeleton.
  | "module"
  | "constant"
  | "variable";

/** How confident we are an edge is true, best-first. The hand-written AST
 * resolver assigns `extracted`/`inferred`; the opt-in LSP enrichment pass
 * (`graft build --lsp`) can promote an edge to compiler-grade `lsp_resolved`
 * (an exact server-confirmed target) or `lsp_dispatch` (an interface/virtual
 * candidate). Order matters: consumers that rank by provenance treat earlier
 * values as stronger. */
export type Confidence = "lsp_resolved" | "lsp_dispatch" | "extracted" | "inferred";

/** Whether the LLM meaning-layer has been computed for a node. */
export type SummaryState = "pending" | "ready" | "stale";

/** The LLM-chosen business-logic excerpt. `code` is the source of truth; `span`
 * is a best-effort pointer that may drift and is never used to re-slice. */
export interface Crux {
  code: string;
  span: string; // e.g. "L189-L196"
}

export interface NodeV1 {
  // identity
  id: string; // path-scoped: "src/cache.ts#Cache.get"
  name: string; // the symbol's own name: "get"
  kind: Kind;
  // method nodes only: the bare name of the immediate enclosing class/receiver
  // ("Cache" for "get"). Lets owner-qualified lookups (resolve.ts's ownerMethod
  // index) key off a stored field instead of re-deriving it by slicing `id`,
  // which breaks once ids can carry a dedup ordinal (`Cache.get~2`).
  owner?: string;

  // location (Tier-1, deterministic)
  path: string; // repo-relative: "src/cache.ts"
  span: string; // whole definition: "L165-L222"
  signature: string | null; // "get(k: string): number" — null for kind:"file"
  exported: boolean;
  // How the node was extracted. "ast" = a first-class hand-written extractor
  // (TS/JS/Python/Go, full-fidelity). "generic" = the tags.scm breadth tier
  // (signature-only; symbols + bare edges, no scope-aware binding).
  origin: "ast" | "generic";
  body_hash: string; // sha256 of the definition text; the Tier-2 re-run trigger
  chars?: number; // byte length of the WHOLE file (file nodes only); the baseline
  //                 `ask` uses to estimate tokens saved vs reading the file whole
  body_text?: string; // searchable whitespace-normalized definition body (Tier-1,
  //                 symbol nodes only, capped). Ranks `ask` queries so a term in
  //                 the code — not just the name/signature — is findable; never
  //                 emitted to the agent (that reads verbatim source via `--source`).
  //                 Absent on file nodes and on graphs built before this field.
  arity?: number; // declared parameter count (method/constructor nodes). Disambiguates
  //                 OVERLOADS, which only Java has among the languages parsed here: two
  //                 same-named methods on one class are otherwise separable only by
  //                 arity, and picking the wrong one turns a delegating overload into a
  //                 self-loop. Absent on graphs built before this field, and on
  //                 languages that do not emit it — resolution then behaves as before.
  variadic?: boolean; // the last parameter is a vararg (`String... xs`), so the declared
  //                 arity is a MINIMUM, not an equality. Never arity-filtered out.

  // meaning (Tier-2, one LLM call)
  summary_state: SummaryState;
  summary: string | null;
  crux: Crux | null;
}

export type Relation =
  | "contains" // file → symbol, class → method (structural)
  | "calls" // function → function it invokes
  | "imports" // file → module
  | "references" // symbol → symbol it names but doesn't call
  | "implements" // TS: class → interface
  | "extends" // class → base class
  | "http"; // client method → route handler in another repo; workspace links only, never a graph edge

export interface EdgeV1 {
  source: string; // node id
  target: string; // node id, or an unresolved module string for imports
  relation: Relation;
  confidence: Confidence;
}

/** A ranking scope: a sub-project discovered by project-marker files (`package.json`,
 * `go.mod`, ...). `prefix` is a posix path relative to the graph root ("" = root scope);
 * `label` is the same value without a trailing slash (also "" for root); `markers` lists
 * which marker file(s) were found in that directory. See `src/graph/scopes.ts`. */
export interface ScopeV1 {
  prefix: string;
  label: string;
  markers: string[];
}

/** A route the repo serves. `path` is `/`-free at both ends, parameters are `{}`
 * (`{?}` when optional); `handler` is the method node that serves it, null for a
 * closure or a class the repo does not define. See `http.ts`. */
export interface HttpEndpointV1 {
  methods: string[]; // upper-case verbs, or ["ANY"]
  path: string;
  handler: string | null;
  file: string;
  line: number;
}

/** A request the repo sends: `source` is the method that sends it, `method` the
 * verb when it is known statically. */
export interface HttpCallV1 {
  source: string;
  method: string | null;
  path: string;
  line: number;
}

export interface HttpFactsV1 {
  endpoints: HttpEndpointV1[];
  calls: HttpCallV1[];
}

export interface GraphV1 {
  meta: {
    version: 1;
    nodeCount: number;
    edgeCount: number;
    languages: string[];
    /** Ranking scopes: posix path prefixes relative to the graph root, "" = root scope.
     * Absent (old graphs) ≡ [{ prefix: "", label: "" }]. Sorted by prefix length desc. */
    scopes?: ScopeV1[];
  };
  nodes: NodeV1[];
  edges: EdgeV1[];
  /** HTTP routes and client calls, for links between the repos of a workspace.
   * Absent when the repo has neither, and on graphs built before this field. */
  http?: HttpFactsV1;
  /** PHP class typing and the member calls that leave the repo, for method-level
   * links between the repos of a workspace (`php-calls.ts`). Absent when the repo
   * has none, and on graphs built before this field. */
  php?: PhpFactsV1;
}

/** One class, interface, trait or enum. Type names are FQCNs, `self`/`static`
 * already replaced by the class itself. Empty fields are omitted. */
export interface PhpClassFactV1 {
  id: string;
  fqcn: string;
  ext?: string;
  impl?: string[];
  traits?: string[];
  /** method → the class it returns */
  ret?: Record<string, string>;
  /** property → its class */
  props?: Record<string, string>;
  /** `@method [static] T name()` → T */
  doc?: Record<string, string>;
  /** Facade accessor: `k:<key>` for a string, `c:<FQCN>` for `X::class`. */
  acc?: string;
}

/** A container binding: `k` is the key string or the FQCN of `X::class`. */
export interface PhpBindFactV1 {
  k: string;
  t: string;
}

/**
 * A call `m` made by node `s` on a receiver `r` (a class FQCN, or `k:<key>` for a
 * container key) reached through steps `p` (absent when none): `name()` calls a
 * method, `name` reads a property. `st` marks a static root (`X::name()`), which
 * is where a facade forwards. One entry per distinct call shape of a node.
 */
export interface PhpCallFactV1 {
  s: string;
  r: string;
  st?: 1;
  p?: string[];
  m: string;
}

export interface PhpFactsV1 {
  /** Classes that carry typing: a parent, interfaces, traits, return or property types, docblocks, an accessor. */
  classes: PhpClassFactV1[];
  binds: PhpBindFactV1[];
  /** Calls whose chain reaches a class the repo does not define, from that class on. */
  calls: PhpCallFactV1[];
}

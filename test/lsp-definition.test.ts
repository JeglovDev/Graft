/**
 * The definition pass of `graft build --lsp`, for servers without call hierarchy
 * (phpactor): every call site in a callable's span is asked `definition`, and an
 * in-repo answer becomes an `lsp_resolved` calls edge. A fake `phpactor` on PATH
 * stands in for the server, so the test needs no PHP.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { enrichWithLsp } from "../src/graph/lsp/enrich.js";
import type { GraphV1, NodeV1 } from "../src/graph/types.js";

const FAKE_SERVER = `#!/usr/bin/env node
// Minimal LSP server: definition only; answers from DEFS ("line:char" -> [file, line]) and logs each request.
const { appendFileSync } = require("node:fs");
const { join } = require("node:path");
const defs = JSON.parse(process.env.FAKE_DEFS);
const root = process.cwd();
let buf = Buffer.alloc(0);
const send = (m) => { const s = JSON.stringify(m); process.stdout.write("Content-Length: " + Buffer.byteLength(s) + "\\r\\n\\r\\n" + s); };
process.stdin.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const h = buf.indexOf("\\r\\n\\r\\n");
    if (h < 0) return;
    const len = Number(/Content-Length: (\\d+)/i.exec(buf.slice(0, h).toString())[1]);
    if (buf.length < h + 4 + len) return;
    const msg = JSON.parse(buf.slice(h + 4, h + 4 + len).toString());
    buf = buf.slice(h + 4 + len);
    if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: { definitionProvider: true } } });
    else if (msg.method === "textDocument/definition") {
      const key = msg.params.position.line + ":" + msg.params.position.character;
      appendFileSync(process.env.FAKE_LOG, key + "\\n");
      const hit = defs[key];
      const uri = hit ? require("node:url").pathToFileURL(join(root, hit[0])).href : null;
      send({ jsonrpc: "2.0", id: msg.id, result: hit ? { uri, range: { start: { line: hit[1], character: 0 }, end: { line: hit[1], character: 1 } } } : null });
    } else if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, result: null });
  }
});
`;

function node(id: string, kind: NodeV1["kind"], path: string, span: string, name: string): NodeV1 {
  return { id, name, kind, path, span, signature: null, exported: true, origin: "ast", body_hash: "x", summary_state: "pending", summary: null, crux: null };
}

const A_PHP = [
  "<?php",
  "class A {",
  "    public function run() {",
  "        if ($this->ok()) { return $this->svc->charge(1); }",
  "    }",
  "    public function ok() { return true; }",
  "}",
].join("\n");
const B_PHP = ["<?php", "class B {", "    public function charge($n) { return $n; }", "}"].join("\n");

test("definition pass: an unresolved member call becomes an lsp_resolved edge, a resolved one costs no request", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lsp-def-"));
  const bin = join(dir, "bin");
  const repo = join(dir, "repo");
  mkdirSync(bin);
  mkdirSync(repo);
  writeFileSync(join(repo, "A.php"), A_PHP);
  writeFileSync(join(repo, "B.php"), B_PHP);
  writeFileSync(join(bin, "phpactor"), FAKE_SERVER);
  chmodSync(join(bin, "phpactor"), 0o755);
  const log = join(dir, "requests.log");
  writeFileSync(log, "");
  const charge = A_PHP.split("\n")[3].indexOf("charge");
  const saved = { PATH: process.env.PATH, FAKE_DEFS: process.env.FAKE_DEFS, FAKE_LOG: process.env.FAKE_LOG };
  process.env.PATH = bin + delimiter + (process.env.PATH ?? "");
  process.env.FAKE_DEFS = JSON.stringify({ [`3:${charge}`]: ["B.php", 2] });
  process.env.FAKE_LOG = log;
  try {
    const graph: GraphV1 = {
      meta: { version: 1, nodeCount: 6, edgeCount: 1, languages: ["php"], scopes: [] },
      nodes: [
        node("A.php", "file", "A.php", "L1-L7", "A.php"),
        node("A.php#A", "class", "A.php", "L2-L7", "A"),
        node("A.php#A.run", "method", "A.php", "L3-L5", "run"),
        node("A.php#A.ok", "method", "A.php", "L6-L6", "ok"),
        node("B.php", "file", "B.php", "L1-L4", "B.php"),
        node("B.php#B.charge", "method", "B.php", "L3-L3", "charge"),
      ],
      // The static pass already resolved `$this->ok()`.
      edges: [{ source: "A.php#A.run", target: "A.php#A.ok", relation: "calls", confidence: "extracted" }],
    };
    const r = await enrichWithLsp(graph, repo);
    assert.match(r.server ?? "", /phpactor$/);
    assert.equal(r.added, 1);
    assert.deepEqual(
      graph.edges.find((e) => e.confidence === "lsp_resolved"),
      { source: "A.php#A.run", target: "B.php#B.charge", relation: "calls", confidence: "lsp_resolved" },
    );
    const asked = readFileSync(log, "utf8").trim().split("\n");
    assert.ok(asked.includes(`3:${charge}`), "the unresolved call was asked about");
    const ok = A_PHP.split("\n")[3].indexOf("ok(");
    assert.ok(!asked.includes(`3:${ok}`), "the call the static pass resolved was not asked about");
    assert.ok(!asked.some((k) => k.startsWith("3:") && Number(k.split(":")[1]) === A_PHP.split("\n")[3].indexOf("if")), "`if (` is syntax");
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.FAKE_DEFS === undefined) delete process.env.FAKE_DEFS; else process.env.FAKE_DEFS = saved.FAKE_DEFS;
    if (saved.FAKE_LOG === undefined) delete process.env.FAKE_LOG; else process.env.FAKE_LOG = saved.FAKE_LOG;
    rmSync(dir, { recursive: true, force: true });
  }
});

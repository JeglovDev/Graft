/**
 * `graft build --workspace`: a repo that is really a folder of clones.
 *
 * The shape: a small repo of its own (docs, scripts) that git-ignores
 * `services/` and `libs/`, where separate repositories are cloned by kind. Its
 * own `.git` kept it from ever being a workspace, and ignored clones are
 * invisible to `--follow-nested-repos`, so graft indexed only the handful of
 * files the root tracks. The opt-in makes it a workspace; clones one grouping
 * folder down count as children.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { contextDirFor } from "../src/context/node-file.js";
import { wiringPath } from "../src/graph/write.js";
import { tmpRepo } from "./helpers.js";

function gitInit(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
}

function write(root: string, path: string, content: string): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), content);
}

function build(root: string, store: string, ...flags: string[]) {
  const res = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "build", ...flags, root], {
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, GRAFT_STORE: store, DO_NOT_TRACK: "1" },
  });
  assert.equal(res.status, 0, `build ${flags.join(" ")} failed:\n${res.stdout}\n${res.stderr}`);
  return res;
}

function inStore<T>(store: string, fn: () => T): T {
  const prev = process.env.GRAFT_STORE;
  process.env.GRAFT_STORE = store;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.GRAFT_STORE; else process.env.GRAFT_STORE = prev;
  }
}

function fixture(): string {
  const root = tmpRepo("ws-optin");
  gitInit(root);
  write(root, ".gitignore", "/services/\n/libs/\n");
  write(root, "scripts/tool.py", "def tool():\n    return 1\n");
  for (const child of ["services/api", "services/web", "libs/sdk"]) {
    gitInit(join(root, child));
    write(root, `${child}/src/index.ts`, `export function ${child.split("/")[1]}() { return 1; }\n`);
  }
  return root;
}

test("a repo with its own .git is not a workspace without the opt-in", () => {
  const root = fixture();
  const store = tmpRepo("ws-store");
  build(root, store);
  inStore(store, () => {
    assert.equal(existsSync(join(contextDirFor(root), "workspace.json")), false);
    assert.ok(existsSync(wiringPath(contextDirFor(root))), "root should get an ordinary graph");
  });
});

test("--workspace splits the repo into its nested clones, including ones in grouping folders", () => {
  const root = fixture();
  const store = tmpRepo("ws-store");
  build(root, store, "--workspace");
  inStore(store, () => {
    const ws = JSON.parse(readFileSync(join(contextDirFor(root), "workspace.json"), "utf8"));
    assert.deepEqual(ws.children, ["libs/sdk", "services/api", "services/web"]);
    for (const child of ws.children) {
      assert.ok(existsSync(wiringPath(contextDirFor(join(root, child)))), `no graph for ${child}`);
    }
  });

  // Persisted: a later no-flag build stays a workspace.
  build(root, store);
  inStore(store, () => assert.ok(existsSync(join(contextDirFor(root), "workspace.json"))));
});

test("--no-workspace turns the mode off and drops the workspace index", () => {
  const root = fixture();
  const store = tmpRepo("ws-store");
  build(root, store, "--workspace");
  build(root, store, "--no-workspace");
  inStore(store, () => {
    assert.equal(existsSync(join(contextDirFor(root), "workspace.json")), false);
    assert.ok(existsSync(wiringPath(contextDirFor(root))), "root should be back to an ordinary graph");
  });
});

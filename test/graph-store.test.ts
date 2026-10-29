/**
 * `GRAFT_STORE`: one machine-wide place for every repo's graph.
 *
 * `GRAFT_DIR`/`--dir` name ONE context dir, so they only fit a single repo. A
 * store is set once (typically in a user-level MCP server entry) and gives each
 * repo its own entry, keyed by the repo's absolute path. The contract pinned
 * here: under a store, a build writes nothing into the checkout (no `graft/`,
 * no `.graft/`, no `.gitignore` or `.ignore` edit), and every resolver
 * (`contextDirFor`, `resolveContextDir`, `buildConfigPath`, the ancestor walk)
 * agrees on where the graph is.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { contextDirFor } from "../src/context/node-file.js";
import { mapDirFor } from "../src/context/map-dir.js";
import { nearestGraftRoot } from "../src/graph/root.js";
import { wiringPath } from "../src/graph/write.js";
import { planRetract } from "../src/hosts/retract.js";
import {
  buildConfigPath,
  patchBuildConfig,
  resolveContextDir,
  storeKey,
} from "../src/util/state.js";
import { tmpRepo } from "./helpers.js";

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return fn(); }
  finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

test("storeKey turns the absolute repo path into one dash-separated name", () => {
  assert.equal(storeKey("/work/api"), "-work-api");
  assert.equal(storeKey("/work/api/"), "-work-api");
});

test("without GRAFT_STORE the graph stays at <repo>/graft", () => {
  const repo = tmpRepo("store-off");
  withEnv({ GRAFT_STORE: undefined, GRAFT_DIR: undefined }, () => {
    assert.equal(mapDirFor(repo), join(repo, "graft"));
    assert.equal(contextDirFor(repo), join(repo, "graft"));
    assert.equal(buildConfigPath(repo), join(repo, ".graft", "config.json"));
  });
});

test("GRAFT_STORE moves the graph and the build config into the repo's store entry", () => {
  const repo = tmpRepo("store-on");
  const store = tmpRepo("store");
  const entry = join(store, storeKey(repo));
  withEnv({ GRAFT_STORE: store, GRAFT_DIR: undefined }, () => {
    assert.equal(contextDirFor(repo), join(entry, "graft"));
    assert.equal(resolveContextDir(repo), join(entry, "graft"));
    assert.equal(buildConfigPath(repo), join(entry, ".graft", "config.json"));
  });
});

test("GRAFT_STORE expands a leading ~, since MCP configs pass env without a shell", () => {
  const repo = tmpRepo("store-tilde");
  withEnv({ GRAFT_STORE: "~/graft-store", GRAFT_DIR: undefined }, () => {
    assert.equal(contextDirFor(repo), join(homedir(), "graft-store", storeKey(repo), "graft"));
  });
});

test("explicit overrides still win over GRAFT_STORE", () => {
  const repo = tmpRepo("store-override");
  const store = tmpRepo("store");
  const custom = join(tmpRepo("custom"), "ctx");
  withEnv({ GRAFT_STORE: store, GRAFT_DIR: custom }, () => {
    assert.equal(contextDirFor(repo, custom), custom);
    assert.equal(resolveContextDir(repo), custom);
  });
});

test("persisting build config under GRAFT_STORE leaves the repo's .gitignore alone", () => {
  const repo = tmpRepo("store-config");
  const store = tmpRepo("store");
  withEnv({ GRAFT_STORE: store, GRAFT_DIR: undefined }, () => {
    patchBuildConfig(repo, { includeDirs: ["vendor"] });
    assert.ok(existsSync(buildConfigPath(repo)));
  });
  assert.equal(existsSync(join(repo, ".graft")), false);
  assert.equal(existsSync(join(repo, ".gitignore")), false);
});

test("the ancestor walk finds a stored graph from a subdirectory", () => {
  const repo = tmpRepo("store-walk");
  const store = tmpRepo("store");
  const deep = join(repo, "src", "inner");
  mkdirSync(deep, { recursive: true });
  withEnv({ GRAFT_STORE: store, GRAFT_DIR: undefined }, () => {
    const wiring = wiringPath(contextDirFor(repo));
    mkdirSync(join(wiring, ".."), { recursive: true });
    writeFileSync(wiring, '{"version":1,"nodes":[],"edges":[]}\n');
    assert.deepEqual(nearestGraftRoot(deep), { root: repo, levels: 2 });
  });
});

function buildInStore(flags: string[]): { repo: string; store: string } {
  const repo = tmpRepo("store-build");
  const store = tmpRepo("store");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "a.ts"), "export function a() { return b(); }\nexport function b() { return 1; }\n");
  const git = spawnSync("git", ["init", "-q"], { cwd: repo });
  assert.equal(git.status, 0, "git init failed");
  // A clone parked inside the tree, the case `--follow-nested-repos` persists a choice for.
  mkdirSync(join(repo, "nested"));
  writeFileSync(join(repo, "nested", "n.ts"), "export const n = 1;\n");
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: join(repo, "nested") }).status, 0);

  const env: NodeJS.ProcessEnv = { ...process.env, GRAFT_STORE: store, DO_NOT_TRACK: "1" };
  delete env.GRAFT_DIR;
  const res = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "build", repo, ...flags], {
    encoding: "utf8",
    timeout: 120_000,
    env,
  });
  assert.equal(res.status, 0, `build failed:\n${res.stdout}\n${res.stderr}`);
  return { repo, store };
}

const REPO_TRACES = ["graft", ".graft", ".gitignore", ".ignore", ".trail"];

test("graft build under GRAFT_STORE writes nothing into the checkout", () => {
  const { repo, store } = buildInStore([]);
  for (const name of REPO_TRACES) {
    assert.equal(existsSync(join(repo, name)), false, `${name} appeared in the checkout`);
  }
  assert.ok(existsSync(wiringPath(join(store, storeKey(repo), "graft"))), "no wiring graph in the store");
});

test("a persisted build flag under GRAFT_STORE lands in the store, not in <repo>/.graft", () => {
  const { repo, store } = buildInStore(["--follow-nested-repos"]);
  for (const name of REPO_TRACES) {
    assert.equal(existsSync(join(repo, name)), false, `${name} appeared in the checkout`);
  }
  const config = join(store, storeKey(repo), ".graft", "config.json");
  assert.ok(existsSync(config), "the persisted choice is missing from the store");
  assert.match(readFileSync(config, "utf8"), /"followNestedRepos": true/);
});

test("GRAFT_STORE wins over trail's .trail/cache and never moves an old graft/ into the repo", () => {
  const repo = tmpRepo("store-trail");
  const store = tmpRepo("store");
  // A repo on trail (it has .trail/learnings/) that still holds a map in graft/.
  mkdirSync(join(repo, ".trail", "learnings"), { recursive: true });
  mkdirSync(join(repo, "graft"));
  writeFileSync(join(repo, "graft", "INDEX.md"), "# old map\n");
  withEnv({ GRAFT_STORE: store, GRAFT_DIR: undefined }, () => {
    assert.equal(mapDirFor(repo), join(store, storeKey(repo), "graft"));
    assert.equal(contextDirFor(repo), join(store, storeKey(repo), "graft"));
  });
  assert.equal(existsSync(join(repo, ".trail", "cache")), false, "the old map was moved into .trail/cache");
  assert.ok(existsSync(join(repo, "graft", "INDEX.md")), "the old map was touched");
});

test("retract under GRAFT_STORE targets the repo's store entry", () => {
  const repo = tmpRepo("store-retract");
  const store = tmpRepo("store");
  const plan = withEnv({ GRAFT_STORE: store, GRAFT_DIR: undefined }, () =>
    planRetract(repo, { home: tmpRepo("store-retract-home"), global: false }),
  );
  const caches = plan.filter((t) => t.what === "local graph cache").map((t) => t.path);
  assert.ok(caches.includes(join(store, storeKey(repo), "graft")), `store entry not targeted: ${caches.join(", ")}`);
  assert.ok(!caches.includes(join(repo, "graft")));
});

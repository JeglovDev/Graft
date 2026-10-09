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
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { contextDirFor } from "../src/context/node-file.js";
import { nearestGraftRoot } from "../src/graph/root.js";
import { wiringPath } from "../src/graph/write.js";
import {
  buildConfigPath,
  defaultContextDir,
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
    assert.equal(defaultContextDir(repo), join(repo, "graft"));
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

test("graft build under GRAFT_STORE writes nothing into the checkout", () => {
  const repo = tmpRepo("store-build");
  const store = tmpRepo("store");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "a.ts"), "export function a() { return b(); }\nexport function b() { return 1; }\n");
  const git = spawnSync("git", ["init", "-q"], { cwd: repo });
  assert.equal(git.status, 0, "git init failed");

  const res = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "build", repo], {
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, GRAFT_STORE: store, GRAFT_DIR: undefined, DO_NOT_TRACK: "1" },
  });
  assert.equal(res.status, 0, `build failed:\n${res.stdout}\n${res.stderr}`);

  for (const name of ["graft", ".graft", ".gitignore", ".ignore"]) {
    assert.equal(existsSync(join(repo, name)), false, `${name} appeared in the checkout`);
  }
  assert.ok(existsSync(wiringPath(join(store, storeKey(repo), "graft"))), "no wiring graph in the store");
});

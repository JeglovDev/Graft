/**
 * Files Git marks `linguist-vendored` or `linguist-generated` are not the repo's
 * own code and stay out of the graph.
 *
 * The case behind it: a PHP site with jQuery, Bootstrap, Leaflet and a dozen
 * other libraries copied into `www/js/`. Those files are tracked, sit in an
 * ordinary directory and are under the size cap, so nothing else excluded them,
 * and they made up two thirds of the graph's nodes. The attribute is the
 * convention GitHub Linguist already reads, and `.git/info/attributes` lets a
 * checkout set it without committing anything.
 */
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { walkDir } from "../src/ingest/fs.js";
import { tmpRepo } from "./helpers.js";

function repo(tag: string): string {
  const dir = tmpRepo(`attrs-${tag}`);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

function write(root: string, path: string, content = "export const value = 1;\n"): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), content);
}

function walked(root: string, followNestedRepos = false): string[] {
  return walkDir(root, undefined, { followNestedRepos })
    .map((path) => relative(root, path).replace(/\\/g, "/"))
    .sort();
}

test("walkDir drops files marked linguist-vendored or linguist-generated in .gitattributes", () => {
  const dir = repo("committed");
  try {
    write(dir, ".gitattributes", "js/*.min.js linguist-vendored\napi/client.ts linguist-generated=true\n");
    write(dir, "js/app.js");
    write(dir, "js/jquery.min.js");
    write(dir, "api/client.ts");
    write(dir, "api/server.ts");

    assert.deepEqual(walked(dir), ["api/server.ts", "js/app.js"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("walkDir honors the local .git/info/attributes, so nothing needs committing", () => {
  const dir = repo("local");
  try {
    write(dir, ".git/info/attributes", "js/leaflet.js linguist-vendored\n");
    write(dir, "js/leaflet.js");
    write(dir, "js/map.js");

    assert.deepEqual(walked(dir), ["js/map.js"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unset or false attribute re-admits a file a broader rule marked", () => {
  const dir = repo("unset");
  try {
    write(dir, ".gitattributes", "js/* linguist-vendored\njs/app.js -linguist-vendored\njs/map.js linguist-vendored=false\n");
    write(dir, "js/app.js");
    write(dir, "js/map.js");
    write(dir, "js/lib.js");

    assert.deepEqual(walked(dir), ["js/app.js", "js/map.js"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a followed nested clone is filtered by its own attributes", () => {
  const parent = repo("nested-parent");
  try {
    write(parent, "src/app.ts");
    const child = join(parent, "packages", "ui");
    mkdirSync(child, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: child });
    write(child, ".git/info/attributes", "vendor.js linguist-vendored\n");
    write(child, "index.ts");
    write(child, "vendor.js");

    assert.deepEqual(walked(parent, true), ["packages/ui/index.ts", "src/app.ts"]);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

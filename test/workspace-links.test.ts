import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGraph } from "../src/graph/build.js";
import { federateCallers, federateGrep, loadWorkspaceGraphs, splitWorkspace } from "../src/graph/workspace.js";
import { computeLinks } from "../src/graph/workspace-links.js";
import { psr4Paths, readComposerAutoload } from "../src/graph/composer.js";

/** A workspace of PHP repos: an SDK with a PSR-4 namespace, a Laravel-style app
 * that uses it, and a second app sharing the app's `App\` namespace. */
function phpWorkspace(): string {
  const parent = mkdtempSync(join(tmpdir(), "ws-links-"));
  const files: Record<string, Record<string, string>> = {
    "acme-sdk": {
      "composer.json": JSON.stringify({ autoload: { "psr-4": { "Acme\\Sdk\\": "src/" } } }),
      "src/Client.php": "<?php\nnamespace Acme\\Sdk;\n\nclass Client\n{\n    public function send(): void {}\n}\n",
      "src/Exceptions/ApiException.php":
        "<?php\nnamespace Acme\\Sdk\\Exceptions;\n\nclass ApiException extends \\Exception {}\n",
    },
    shop: {
      // The classmap root is the one place a suffix guess still makes sense.
      "composer.json": JSON.stringify({
        autoload: { "psr-4": { "App\\": "app/" } },
        "autoload-dev": { classmap: ["tests/Support/"] },
      }),
      "tests/Support/Helpers/Factory.php": "<?php\nnamespace Support;\n\nclass Factory {}\n",
      "app/Boot.php": "<?php\nnamespace App;\n\nuse Support\\Factory;\n\nclass Boot {}\n",
      "app/Service.php":
        // A group use: the clause alone holds only the tail.
        "<?php\nnamespace App;\n\nuse Acme\\Sdk\\{Client, Exceptions\\ApiException};\nuse App\\Models\\User;\n\n" +
        "class Service extends Client\n{\n    public function run(): void {}\n}\n",
      // Same short name as the SDK's exception: a suffix guess would bind the SDK import here.
      "app/Exceptions/ApiException.php": "<?php\nnamespace App\\Exceptions;\n\nclass ApiException extends \\Exception {}\n",
      "app/Controller.php": "<?php\nnamespace App;\n\nuse App\\Service;\n\nclass Controller\n{\n}\n",
    },
    admin: {
      "composer.json": JSON.stringify({ autoload: { "psr-4": { "App\\": "app/" } } }),
      "app/Models/User.php": "<?php\nnamespace App\\Models;\n\nclass User {}\n",
    },
  };
  for (const [child, tree] of Object.entries(files)) {
    mkdirSync(join(parent, child, ".git"), { recursive: true });
    for (const [name, content] of Object.entries(tree)) {
      const path = join(parent, child, name);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, content);
    }
  }
  return parent;
}

async function built(): Promise<string> {
  const p = phpWorkspace();
  await splitWorkspace(p, undefined, async (childDir) => {
    await buildGraph(childDir);
  });
  return p;
}

test("composer PSR-4: prefixes map to repo-relative files, most specific first", () => {
  const dir = mkdtempSync(join(tmpdir(), "composer-"));
  writeFileSync(
    join(dir, "composer.json"),
    JSON.stringify({
      autoload: { "psr-4": { "Acme\\": "lib/", "Acme\\Sdk\\": ["src/", "extra"] } },
      "autoload-dev": { "psr-4": { "Acme\\Tests\\": "tests/" }, classmap: ["tests/Legacy/"] },
    }),
  );
  const a = readComposerAutoload([{ abs: join(dir, "composer.json"), dir: "pkg" }]);
  assert.deepEqual(a.otherRoots, ["pkg/tests/Legacy"]);
  assert.deepEqual(psr4Paths("Acme\\Sdk\\Client", a.psr4), ["pkg/src/Client.php", "pkg/extra/Client.php", "pkg/lib/Sdk/Client.php"]);
  assert.deepEqual(psr4Paths("\\Acme\\Tests\\T", a.psr4), ["pkg/tests/T.php", "pkg/lib/Tests/T.php"]);
  assert.deepEqual(psr4Paths("Other\\X", a.psr4), []);
  rmSync(dir, { recursive: true, force: true });
});

test("a use outside the repo's own PSR-4 namespaces stays external instead of hitting a same-named local file", async () => {
  const p = await built();
  const shop = loadWorkspaceGraphs(p).loaded.find((c) => c.child === "shop")!.graph;
  const targets = shop.edges.filter((e) => e.source === "app/Service.php" && e.relation === "imports").map((e) => e.target);
  assert.ok(targets.includes("Acme\\Sdk\\Exceptions\\ApiException"), `got ${targets.join(", ")}`);
  assert.ok(!targets.includes("app/Exceptions/ApiException.php"));
  // An import of the repo's own namespace resolves to the exact PSR-4 file.
  const ctl = shop.edges.find((e) => e.source === "app/Controller.php" && e.relation === "imports");
  assert.equal(ctl?.target, "app/Service.php");
  const boot = shop.edges.find((e) => e.source === "app/Boot.php" && e.relation === "imports");
  assert.equal(boot?.target, "tests/Support/Helpers/Factory.php");
  rmSync(p, { recursive: true, force: true });
});

test("links resolve another repo's FQCN through its PSR-4 map, never through the source repo's own namespace", async () => {
  const p = await built();
  const links = computeLinks(p, loadWorkspaceGraphs(p).loaded);
  const brief = links.map((l) => `${l.fromChild}:${l.sourceId} ${l.relation} ${l.toChild}:${l.targetId}`).sort();
  assert.deepEqual(brief, [
    "shop:app/Service.php imports acme-sdk:src/Client.php#Client",
    "shop:app/Service.php imports acme-sdk:src/Exceptions/ApiException.php#ApiException",
    "shop:app/Service.php#Service extends acme-sdk:src/Client.php#Client",
  ]);
  // `App\Models\User` exists in admin, but App\ is shop's own namespace: no link.
  assert.ok(!links.some((l) => l.toChild === "admin"));
  rmSync(p, { recursive: true, force: true });
});

test("federated callers show callers from other repos, labeled with their repo dir", async () => {
  const p = await built();
  const { text, found } = federateCallers(p, undefined, "Client", {});
  assert.equal(found, true);
  assert.match(text, /## acme-sdk\//);
  assert.match(text, /imports ← Service\.php \(shop\/app\/Service\.php:L\d+-L\d+\)/);
  assert.match(text, /extends ← Service \(shop\/app\/Service\.php:L\d+-L\d+\)/);

  // The FQCN form names the same class.
  const fq = federateCallers(p, undefined, "Acme\\Sdk\\Client", {});
  assert.match(fq.text, /## acme-sdk\/[\s\S]*imports ← Service\.php \(shop\//);
  rmSync(p, { recursive: true, force: true });
});

test("federated callees replace the dangling FQCN with the other repo's node", async () => {
  const p = await built();
  const { text } = federateCallers(p, undefined, "Service.php", { direction: "out" });
  assert.match(text, /imports → Client \(acme-sdk\/src\/Client\.php:L\d+-L\d+\)/);
  assert.ok(!text.includes("Acme\\Sdk\\Client (unresolved import)"), text);
  // Not linkable (own namespace, missing here): still shown as unresolved.
  assert.match(text, /App\\Models\\User \(unresolved import\)/);
  rmSync(p, { recursive: true, force: true });
});

test("depth > 1 walks across repos and keeps going inside the other repo", async () => {
  const p = await built();
  const { text } = federateCallers(p, undefined, "Client", { depth: 2 });
  assert.match(text, /imports ← Service\.php \(shop\/app\/Service\.php:L\d+-L\d+\) \[depth 1\]/);
  assert.match(text, /imports ← Controller\.php \(shop\/app\/Controller\.php:L\d+-L\d+\) \[depth 2\]/);
  rmSync(p, { recursive: true, force: true });
});

test("federated grep counts cross-repo in-edges into coupling", async () => {
  const p = await built();
  const { result } = federateGrep(p, undefined, "class Client", {});
  const g = result.groups.find((x) => x.symbol?.name === "Client");
  assert.ok(g, JSON.stringify(result.groups));
  assert.equal(g!.inDegree, 2); // shop's import + shop's extends
  rmSync(p, { recursive: true, force: true });
});

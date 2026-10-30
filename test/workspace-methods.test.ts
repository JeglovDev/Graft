import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGraph } from "../src/graph/build.js";
import { federateCallers, federateGrep, federateMap, loadWorkspaceGraphs, splitWorkspace } from "../src/graph/workspace.js";
import { computeMethodLinks } from "../src/graph/workspace-links.js";

type Tree = Record<string, string>;

const php = (ns: string, uses: string[], body: string) =>
  `<?php\nnamespace ${ns};\n\n${uses.map((u) => `use ${u};\n`).join("")}\n${body}\n`;

/**
 * An SDK with a facade, the provider that binds its accessor, a root class whose
 * typed methods hand out API classes, and those API classes (a base class, a trait,
 * a fluent setter, a docblock return); a second SDK that defines one class of the
 * first's namespace again; and an app that calls the SDK in every shape.
 */
function methodWorkspace(): string {
  const parent = mkdtempSync(join(tmpdir(), "ws-methods-"));
  const repos: Record<string, Tree> = {
    "acme-sdk": {
      "composer.json": JSON.stringify({ autoload: { "psr-4": { "Acme\\Sdk\\": "src/", "Shared\\": "shared/" } } }),
      "src/Facades/Sdk.php": php(
        "Acme\\Sdk\\Facades",
        ["Illuminate\\Support\\Facades\\Facade", "Acme\\Sdk\\Apis\\BalanceApi", "Acme\\Sdk\\Sdk as SdkRoot"],
        "/**\n * @method static BalanceApi balance()\n * @method static SdkRoot setTimeout(int $s)\n * @method static BalanceApi magic()\n */\n" +
          "class Sdk extends Facade\n{\n    protected static function getFacadeAccessor()\n    {\n        return 'acme.sdk';\n    }\n}",
      ),
      "src/SdkServiceProvider.php": php(
        "Acme\\Sdk",
        ["Illuminate\\Support\\ServiceProvider"],
        "class SdkServiceProvider extends ServiceProvider\n{\n    public function register()\n    {\n" +
          "        $this->app->singleton('acme.sdk', function () {\n            return new Sdk();\n        });\n    }\n}",
      ),
      "src/Sdk.php": php(
        "Acme\\Sdk",
        ["Acme\\Sdk\\Apis\\BalanceApi", "Acme\\Sdk\\Apis\\CurrencyApi"],
        "class Sdk\n{\n" +
          "    public function balance(): BalanceApi\n    {\n        return new BalanceApi();\n    }\n\n" +
          "    public function currency(): ?CurrencyApi\n    {\n        return new CurrencyApi();\n    }\n\n" +
          "    /**\n     * @return CurrencyApi\n     */\n    public function legacy()\n    {\n        return new CurrencyApi();\n    }\n\n" +
          "    public function untyped()\n    {\n        return new CurrencyApi();\n    }\n}",
      ),
      "src/Apis/BaseApi.php": php(
        "Acme\\Sdk\\Apis",
        [],
        "class BaseApi\n{\n    public function request(): array\n    {\n        return [];\n    }\n\n" +
          "    public function withBrand(int $id): self\n    {\n        return $this;\n    }\n}",
      ),
      "src/Concerns/Sends.php": php("Acme\\Sdk\\Concerns", [], "trait Sends\n{\n    public function send(): void {}\n\n    public function dup(): void {}\n}"),
      "src/Concerns/Also.php": php("Acme\\Sdk\\Concerns", [], "trait Also\n{\n    public function dup(): void {}\n}"),
      "src/Apis/BalanceApi.php": php(
        "Acme\\Sdk\\Apis",
        ["Acme\\Sdk\\Concerns\\Sends", "Acme\\Sdk\\Concerns\\Also"],
        "class BalanceApi extends BaseApi\n{\n    use Sends, Also;\n\n" +
          "    public function getUserBalance(int $id): array\n    {\n        return $this->request();\n    }\n\n" +
          "    public function setTimeout(int $s): static\n    {\n        return $this;\n    }\n}",
      ),
      "src/Apis/CurrencyApi.php": php("Acme\\Sdk\\Apis", [], "class CurrencyApi\n{\n    public function getExchangeRates(): array\n    {\n        return [];\n    }\n}"),
      "shared/Util.php": php("Shared", [], "class Util\n{\n    public function run(): void {}\n}"),
    },
    "other-sdk": {
      "composer.json": JSON.stringify({ autoload: { "psr-4": { "Shared\\": "src/" } } }),
      "src/Util.php": php("Shared", [], "class Util\n{\n    public function run(): void {}\n}"),
    },
    shop: {
      "composer.json": JSON.stringify({ autoload: { "psr-4": { "App\\": "app/" } } }),
      "app/Services/Wallet.php": php(
        "App\\Services",
        ["Acme\\Sdk\\Facades\\Sdk", "Acme\\Sdk\\Sdk as SdkRoot", "Acme\\Sdk\\Apis\\CurrencyApi", "Shared\\Util"],
        "class Wallet\n{\n    private CurrencyApi $rates;\n\n    /** @var SdkRoot */\n    private $doc;\n\n    private $root;\n\n" +
          "    public function __construct(private SdkRoot $client, SdkRoot $r)\n    {\n        $this->root = $r;\n    }\n\n" +
          "    public function viaFacade()\n    {\n        return Sdk::balance()->getUserBalance(1);\n    }\n\n" +
          "    public function viaNew()\n    {\n        return (new SdkRoot())->currency()->getExchangeRates();\n    }\n\n" +
          "    public function viaPromoted()\n    {\n        return $this->client->balance()->getUserBalance(2);\n    }\n\n" +
          "    public function viaAssigned()\n    {\n        return $this->root->currency()->getExchangeRates();\n    }\n\n" +
          "    public function viaTypedProp()\n    {\n        return $this->rates->getExchangeRates();\n    }\n\n" +
          "    public function viaDocProp()\n    {\n        return $this->doc->legacy()->getExchangeRates();\n    }\n\n" +
          "    public function viaLocal()\n    {\n        $api = Sdk::balance();\n        return $api->getUserBalance(3);\n    }\n\n" +
          "    public function viaFluent()\n    {\n        return Sdk::balance()->setTimeout(5)->getUserBalance(4);\n    }\n\n" +
          "    public function viaTrait()\n    {\n        Sdk::balance()->send();\n    }\n\n" +
          "    public function viaParent()\n    {\n        return Sdk::balance()->request();\n    }\n\n" +
          "    public function viaContainer()\n    {\n        return app(SdkRoot::class)->balance()->getUserBalance(5);\n    }\n\n" +
          "    public function viaKey()\n    {\n        return app('acme.sdk')->currency()->getExchangeRates();\n    }\n\n" +
          "    public function viaObjectScope(Sdk $sdk)\n    {\n        return $sdk::balance()->getUserBalance(9);\n    }\n\n" +
          "    public function viaOtherCase()\n    {\n        return Sdk::BALANCE()->GetUserBalance(10);\n    }\n\n" +
          "    public function viaParentSelf()\n    {\n        return Sdk::balance()->withBrand(1)->getUserBalance(11);\n    }\n\n" +
          "    public function viaDocblockOnly()\n    {\n        return Sdk::magic()->getUserBalance(6);\n    }\n\n" +
          "    public function unknownReceiver($x)\n    {\n        return $x->getUserBalance(7);\n    }\n\n" +
          "    public function framework()\n    {\n        return \\Illuminate\\Support\\Facades\\Cache::get('k');\n    }\n\n" +
          "    public function ambiguousClass()\n    {\n        (new Util())->run();\n    }\n\n" +
          "    public function ambiguousTrait()\n    {\n        Sdk::balance()->dup();\n    }\n\n" +
          "    public function untypedStep()\n    {\n        return (new SdkRoot())->untyped()->getExchangeRates();\n    }\n\n" +
          "    public function noSuchMethod()\n    {\n        return Sdk::balance()->nope();\n    }\n}",
      ),
      "app/Services/MyApi.php": php(
        "App\\Services",
        ["Acme\\Sdk\\Apis\\BalanceApi"],
        "class MyApi extends BalanceApi\n{\n    public function mine(): array\n    {\n        return $this->getUserBalance(8);\n    }\n}",
      ),
      "app/Http/Controller.php": php(
        "App\\Http",
        ["App\\Services\\Wallet"],
        "class Controller\n{\n    public function show(Wallet $w)\n    {\n        return $w->viaFacade();\n    }\n}",
      ),
    },
  };
  for (const [child, tree] of Object.entries(repos)) {
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
  const p = methodWorkspace();
  await splitWorkspace(p, undefined, async (childDir) => {
    await buildGraph(childDir);
  });
  return p;
}

const W = "app/Services/Wallet.php#Wallet";
const BAL = "src/Apis/BalanceApi.php#BalanceApi";
const CUR = "src/Apis/CurrencyApi.php#CurrencyApi";
const ROOT = "src/Sdk.php#Sdk";

test("method calls through a facade, new, typed properties, locals and the container link to the SDK's methods", async () => {
  const p = await built();
  const { links } = computeMethodLinks(p, loadWorkspaceGraphs(p).loaded);
  const brief = new Set(links.map((l) => `${l.fromChild}:${l.sourceId} -> ${l.toChild}:${l.targetId}`));
  const expect = [
    `${W}.viaFacade -> ${BAL}.getUserBalance`,
    `${W}.viaFacade -> ${ROOT}.balance`, // the inner `Sdk::balance()` itself
    `${W}.viaNew -> ${CUR}.getExchangeRates`,
    `${W}.viaNew -> ${ROOT}.currency`,
    `${W}.viaPromoted -> ${BAL}.getUserBalance`,
    `${W}.viaAssigned -> ${CUR}.getExchangeRates`,
    `${W}.viaTypedProp -> ${CUR}.getExchangeRates`,
    `${W}.viaDocProp -> ${CUR}.getExchangeRates`,
    `${W}.viaLocal -> ${BAL}.getUserBalance`,
    `${W}.viaFluent -> ${BAL}.setTimeout`,
    `${W}.viaFluent -> ${BAL}.getUserBalance`,
    `${W}.viaTrait -> src/Concerns/Sends.php#Sends.send`,
    `${W}.viaParent -> src/Apis/BaseApi.php#BaseApi.request`,
    `${W}.viaContainer -> ${BAL}.getUserBalance`,
    `${W}.viaKey -> ${CUR}.getExchangeRates`,
    // `$sdk::m()` is a static call on the class of `$sdk`.
    `${W}.viaObjectScope -> ${BAL}.getUserBalance`,
    // Method names are case-insensitive in PHP.
    `${W}.viaOtherCase -> ${BAL}.getUserBalance`,
    // A parent's `self` keeps the receiver's own type.
    `${W}.viaParentSelf -> src/Apis/BaseApi.php#BaseApi.withBrand`,
    `${W}.viaParentSelf -> ${BAL}.getUserBalance`,
    // `@method` gives the type to continue with, though no node stands for `magic()`.
    `${W}.viaDocblockOnly -> ${BAL}.getUserBalance`,
    // An app class extending an SDK class calls the inherited method on `$this`.
    `app/Services/MyApi.php#MyApi.mine -> ${BAL}.getUserBalance`,
  ];
  for (const e of expect) assert.ok(brief.has(`shop:${e.replace(" -> ", " -> acme-sdk:")}`), `missing ${e}\n${[...brief].join("\n")}`);

  const from = (m: string) => links.filter((l) => l.sourceId === `${W}.${m}`);
  for (const m of ["unknownReceiver", "framework", "ambiguousClass"]) {
    assert.deepEqual(from(m), [], `${m} must not link`);
  }
  // A chain stops at the step that does not resolve; the calls before it still link.
  assert.deepEqual(from("ambiguousTrait").map((l) => l.targetId), [`${ROOT}.balance`]);
  assert.deepEqual(from("noSuchMethod").map((l) => l.targetId), [`${ROOT}.balance`]);
  assert.deepEqual(from("untypedStep").map((l) => l.targetId), [`${ROOT}.untyped`]);
  assert.ok(links.every((l) => l.relation === "calls" && l.via === "method" && l.fromChild !== l.toChild));
  rmSync(p, { recursive: true, force: true });
});

test("calls the app resolves itself stay out of the kept calls; what leaves the repo is counted by outcome", async () => {
  const p = await built();
  const loaded = loadWorkspaceGraphs(p).loaded;
  const shop = loaded.find((c) => c.child === "shop")!.graph;
  // `$w->viaFacade()` is the app's own call: resolve.ts links it, nothing is kept for it.
  assert.ok(!shop.php!.calls.some((c) => c.s.endsWith("Controller.show")));
  assert.ok(shop.edges.some((e) => e.source.endsWith("Controller.show") && e.target === `${W}.viaFacade` && e.relation === "calls"));
  const { stats, outcomes } = computeMethodLinks(p, loaded);
  const failed = outcomes.filter((o) => !o.result.ok).map((o) => `${o.call.s} ${o.call.r}::${[...(o.call.p ?? []), o.call.m].join("->")} ${JSON.stringify(o.result)}`);
  // Cache::get, and the provider's `$this->app` (a framework base class property)
  assert.equal(stats.external, 2, failed.join("\n"));
  assert.equal(stats.ambiguous, 2); // Util in two repos, dup() in two traits
  assert.equal(stats.untyped, 1);
  // nope(), and `magic()` itself: a docblock, no node to link to
  assert.equal(stats.noMethod, 2);
  assert.equal(stats.inRepo, 0);
  assert.equal(stats.calls, stats.linked + stats.external + stats.ambiguous + stats.untyped + stats.noMethod + stats.inRepo);

  const map = federateMap(p, undefined);
  assert.match(map, /links between repos: \d+ by Composer use, \d+ by method call, 0 by HTTP route/);
  assert.match(
    map,
    new RegExp(`distinct method calls leaving their repo: ${stats.calls} \\(${stats.linked} linked, 0 back in their own repo, 2 to a class outside the workspace, 1 stopped at an untyped step, 2 no such method, 2 ambiguous\\)`),
  );
  rmSync(p, { recursive: true, force: true });
});

test("federated callers of an SDK method list the app methods that call it, and depth 2 keeps walking in the app", async () => {
  const p = await built();
  const { text } = federateCallers(p, undefined, "BalanceApi.getUserBalance", {});
  assert.match(text, /## acme-sdk\//);
  assert.match(text, /calls ← viaFacade \(shop\/app\/Services\/Wallet\.php:L\d+-L\d+\)/);
  assert.match(text, /calls ← mine \(shop\/app\/Services\/MyApi\.php:L\d+-L\d+\)/);

  const deep = federateCallers(p, undefined, "BalanceApi.getUserBalance", { depth: 2 });
  assert.match(deep.text, /calls ← viaFacade \(shop\/app\/Services\/Wallet\.php:L\d+-L\d+\) \[depth 1\]/);
  assert.match(deep.text, /calls ← show \(shop\/app\/Http\/Controller\.php:L\d+-L\d+\) \[depth 2\]/);

  // Callees from the app side land in the SDK.
  const out = federateCallers(p, undefined, "Wallet.viaFacade", { direction: "out" });
  assert.match(out.text, /calls → getUserBalance \(acme-sdk\/src\/Apis\/BalanceApi\.php:L\d+-L\d+\)/);
  assert.match(out.text, /calls → balance \(acme-sdk\/src\/Sdk\.php:L\d+-L\d+\)/);
  const outDeep = federateCallers(p, undefined, "Controller.show", { direction: "out", depth: 3 });
  assert.match(outDeep.text, /calls → request \(acme-sdk\/src\/Apis\/BaseApi\.php:L\d+-L\d+\) \[depth 3\]/);
  rmSync(p, { recursive: true, force: true });
});

test("find_all counts method callers from other repos in the method's in-degree", async () => {
  const p = await built();
  const { result } = federateGrep(p, undefined, "function getExchangeRates", {});
  const g = result.groups.find((x) => x.symbol?.id === `${CUR}.getExchangeRates`);
  assert.ok(g, JSON.stringify(result.groups));
  // viaNew, viaAssigned, viaTypedProp, viaDocProp, viaKey
  assert.equal(g!.inDegree, 5);
  rmSync(p, { recursive: true, force: true });
});

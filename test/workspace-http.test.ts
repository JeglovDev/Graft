import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGraph } from "../src/graph/build.js";
import { federateCallers, federateGrep, federateMap, loadWorkspaceGraphs, splitWorkspace } from "../src/graph/workspace.js";
import { clientPath, matchHttp, normalizeRoutePath, pathScore } from "../src/graph/http.js";
import { httpStats } from "../src/graph/workspace-links.js";
import type { GraphV1 } from "../src/graph/types.js";

type Tree = Record<string, string>;

/** An SDK whose client methods call a service through its own request wrapper, the
 * service that serves those routes, an app that uses the SDK, and (optionally) a
 * second service declaring one of the same routes. */
function httpWorkspace(extra: Record<string, Tree> = {}): string {
  const parent = mkdtempSync(join(tmpdir(), "ws-http-"));
  const repos: Record<string, Tree> = {
    "thing-sdk": {
      "composer.json": JSON.stringify({ autoload: { "psr-4": { "Acme\\Thing\\": "src/" } } }),
      "src/ApiRequest.php":
        "<?php\nnamespace Acme\\Thing;\n\nclass ApiRequest\n{\n" +
        "    public function get(string $path, array $options = []): array\n    {\n        return $this->send('GET', $path, $options);\n    }\n\n" +
        "    public function post(string $path, array $options = []): array\n    {\n        return $this->send('POST', $path, $options);\n    }\n\n" +
        "    private function send(string $method, string $path, array $options): array\n    {\n" +
        "        return $this->client->request($method, $this->prefix . $path, $options);\n    }\n}\n",
      "src/ThingApi.php":
        "<?php\nnamespace Acme\\Thing;\n\nclass ThingApi\n{\n" +
        "    public function getThing(int $id): array\n    {\n        return $this->request->get('/getThing', ['id' => $id]);\n    }\n\n" +
        "    public function item(int $id): array\n    {\n        return $this->request->get('/v2/items/' . $id);\n    }\n\n" +
        "    public function save(): array\n    {\n        return $this->request->post('/v2/items/save');\n    }\n\n" +
        "    public function health(): array\n    {\n        return $this->request->get('/health');\n    }\n\n" +
        "    public function missing(): array\n    {\n        return $this->request->post('/nowhere');\n    }\n\n" +
        // The string parameter makes this a wrapper too; the literal around it is a request.
        "    public function confirm(string $hash): array\n    {\n        return $this->request->get('/v2/items/confirm/' . $hash);\n    }\n}\n",
      // A request object whose path is its method's default, sent by a base class.
      "src/Requests/Base.php":
        "<?php\nnamespace Acme\\Thing\\Requests;\n\nclass Base\n{\n" +
        "    public function doRequest(string $uri): array\n    {\n        return (new \\GuzzleHttp\\Client())->request($this->method(), $uri);\n    }\n}\n",
      "src/Requests/Archive.php":
        "<?php\nnamespace Acme\\Thing\\Requests;\n\nclass Archive extends Base\n{\n" +
        "    public function doRequest(string $uri = '/v2/items/archive'): array\n    {\n        return parent::doRequest($uri);\n    }\n}\n",
      // Its verb is only known at run time, and the service serves the path twice.
      "src/Requests/Lookup.php":
        "<?php\nnamespace Acme\\Thing\\Requests;\n\nclass Lookup extends Base\n{\n" +
        "    public function doRequest(string $uri = '/v2/items/lookup'): array\n    {\n        return parent::doRequest($uri);\n    }\n}\n",
      // The same path, with the verb the class fixes in a property.
      "src/Requests/Store.php":
        "<?php\nnamespace Acme\\Thing\\Requests;\n\nclass Store extends Base\n{\n    protected $_method = 'POST';\n\n" +
        "    public function doRequest(string $uri = '/v2/items/lookup'): array\n    {\n        return parent::doRequest($uri);\n    }\n}\n",
      // A test of the SDK itself requests nothing real.
      "tests/ThingTest.php":
        "<?php\nclass ThingTest\n{\n    public function testIt(): void\n    {\n        $this->get('/getThing');\n    }\n}\n",
    },
    "thing-service": {
      "composer.json": JSON.stringify({ autoload: { "psr-4": { "App\\": "app/" } } }),
      // Lumen: the router group in bootstrap names the controllers' namespace.
      "bootstrap/app.php":
        "<?php\n\n$app->router->group(['namespace' => 'App\\Http\\Controllers'], function ($router) {\n" +
        "    require __DIR__ . '/../routes/web.php';\n});\n",
      "routes/web.php":
        "<?php\n\n$router->get('/getThing', 'ThingController@get');\n" +
        "$router->get('/health', 'HealthController@show');\n" +
        "$router->group(['prefix' => 'v2'], function () use ($router) {\n" +
        "    $router->group(['prefix' => 'items', 'namespace' => 'Items'], function () use ($router) {\n" +
        "        $router->get('/{id}', ['uses' => 'ItemController@show']);\n" +
        "        $router->post('/save', 'ItemController@save');\n" +
        "        $router->post('/archive', 'ItemController@archive');\n" +
        "        $router->get('/confirm/{hash}', 'ItemController@confirm');\n" +
        "        $router->get('/lookup', 'ItemController@show');\n" +
        "        $router->post('/lookup', 'ItemController@save');\n" +
        "    });\n});\n",
      "app/Http/Controllers/ThingController.php":
        "<?php\nnamespace App\\Http\\Controllers;\n\nclass ThingController\n{\n    public function get(): array\n    {\n        return [];\n    }\n}\n",
      "app/Http/Controllers/HealthController.php":
        "<?php\nnamespace App\\Http\\Controllers;\n\nclass HealthController\n{\n    public function show(): array\n    {\n        return [];\n    }\n}\n",
      "app/Http/Controllers/Items/ItemController.php":
        "<?php\nnamespace App\\Http\\Controllers\\Items;\n\nclass ItemController\n{\n" +
        "    public function show($id): array\n    {\n        return [];\n    }\n\n" +
        "    public function save(): array\n    {\n        return [];\n    }\n\n" +
        "    public function archive(): array\n    {\n        return [];\n    }\n\n" +
        "    public function confirm(string $hash): array\n    {\n        return [];\n    }\n}\n",
    },
    // Laravel: RouteServiceProvider mounts routes/api.php under /api; the handler
    // is a `::class` array.
    "other-service": {
      "composer.json": JSON.stringify({ autoload: { "psr-4": { "App\\": "app/" } } }),
      "app/Providers/RouteServiceProvider.php":
        "<?php\nnamespace App\\Providers;\n\nuse Illuminate\\Support\\Facades\\Route;\n\nclass RouteServiceProvider\n{\n" +
        "    public function boot(): void\n    {\n        $this->routes(function () {\n" +
        "            Route::prefix('api')->middleware('api')->group(base_path('routes/api.php'));\n        });\n    }\n}\n",
      "routes/api.php":
        "<?php\n\nuse App\\Http\\Controllers\\HealthController;\nuse Illuminate\\Support\\Facades\\Route;\n\n" +
        "Route::get('/health', [HealthController::class, 'show']);\n" +
        "Route::controller(HealthController::class)->group(function () {\n    Route::get('/ping', 'ping');\n});\n",
      "app/Http/Controllers/HealthController.php":
        "<?php\nnamespace App\\Http\\Controllers;\n\nclass HealthController\n{\n" +
        "    public function show(): array\n    {\n        return [];\n    }\n\n    public function ping(): array\n    {\n        return [];\n    }\n}\n",
    },
    shop: {
      "composer.json": JSON.stringify({ autoload: { "psr-4": { "Shop\\": "src/" } } }),
      "src/Checkout.php":
        "<?php\nnamespace Shop;\n\nuse Acme\\Thing\\ThingApi;\n\nclass Checkout\n{\n" +
        "    public function run(ThingApi $api): void\n    {\n        $api->getThing(1);\n    }\n\n" +
        "    public function ping(): void\n    {\n        \\Http::get($this->base . '/api/ping');\n    }\n}\n",
    },
    ...extra,
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

async function built(extra?: Record<string, Tree>): Promise<string> {
  const p = httpWorkspace(extra);
  await splitWorkspace(p, undefined, async (childDir) => {
    await buildGraph(childDir);
  });
  return p;
}

function graphOf(p: string, child: string): GraphV1 {
  return loadWorkspaceGraphs(p).loaded.find((c) => c.child === child)!.graph;
}

test("http paths: route params match any segment, a run-time base and query are dropped", () => {
  assert.equal(normalizeRoutePath("/v2//items/{id:[0-9]+}/{slug?}/"), "v2/items/{}/{?}");
  assert.equal(normalizeRoutePath("/users[/{id}]"), "users");
  assert.equal(clientPath("\u0001/api/x?y=1"), "api/x");
  assert.equal(clientPath("https://bank.local/getRates"), "getRates");
  assert.equal(clientPath("/sms/\u0001"), "sms/{}");
  assert.equal(clientPath("/events\u0001"), "events");
  assert.equal(clientPath("name"), null, "a bare word is a key, not a path");
  assert.equal(clientPath("v1/users"), "v1/users");
  assert.equal(pathScore("items/{}", "items/{}"), 3);
  assert.equal(pathScore("items/5", "items/{}"), 2);
  assert.equal(pathScore("items/save", "items/save"), 4);
  assert.equal(pathScore("items/{}", "items/save"), 2, "a run-time segment prefers a parameter route");
  assert.equal(pathScore("items", "items/{?}"), 2);
  assert.equal(pathScore("items/save", "other/save"), null);
  assert.equal(pathScore("{}", "{}"), null, "parameters alone are no match");
});

test("routes: Lumen mounts and nested groups give full paths and namespaced handlers", async () => {
  const p = await built();
  const http = graphOf(p, "thing-service").http!;
  const ep = (path: string) => http.endpoints.find((e) => e.path === path);
  assert.deepEqual(ep("getThing"), {
    methods: ["GET"],
    path: "getThing",
    handler: "app/Http/Controllers/ThingController.php#ThingController.get",
    file: "routes/web.php",
    line: 3,
  });
  assert.equal(ep("v2/items/{}")?.handler, "app/Http/Controllers/Items/ItemController.php#ItemController.show");
  assert.equal(ep("v2/items/save")?.handler, "app/Http/Controllers/Items/ItemController.php#ItemController.save");
  const other = graphOf(p, "other-service").http!;
  assert.deepEqual(
    other.endpoints.map((e) => `${e.methods.join(",")} ${e.path} ${e.handler}`).sort(),
    [
      "GET api/health app/Http/Controllers/HealthController.php#HealthController.show",
      "GET api/ping app/Http/Controllers/HealthController.php#HealthController.ping",
    ],
    "base_path() mount under Route::prefix('api'), [X::class, 'm'] and Route::controller()",
  );
  rmSync(p, { recursive: true, force: true });
});

test("client calls: through the repo's own wrappers, with the verb they fix, never from tests", async () => {
  const p = await built();
  const calls = graphOf(p, "thing-sdk").http!.calls.map((c) => `${c.source} ${c.method} ${c.path}`);
  assert.deepEqual(calls.sort(), [
    "src/Requests/Archive.php#Archive.doRequest null v2/items/archive",
    "src/Requests/Lookup.php#Lookup.doRequest null v2/items/lookup",
    "src/Requests/Store.php#Store.doRequest POST v2/items/lookup",
    "src/ThingApi.php#ThingApi.confirm GET v2/items/confirm/{}",
    "src/ThingApi.php#ThingApi.getThing GET getThing",
    "src/ThingApi.php#ThingApi.health GET health",
    "src/ThingApi.php#ThingApi.item GET v2/items/{}",
    "src/ThingApi.php#ThingApi.missing POST nowhere",
    "src/ThingApi.php#ThingApi.save POST v2/items/save",
  ]);
  rmSync(p, { recursive: true, force: true });
});

test("callers of a route handler include the client method in another repo, and depth 2 reaches its users", async () => {
  const p = await built();
  const r = federateCallers(p, undefined, "ThingController.get", { depth: 1 });
  assert.match(r.text, /http ← getThing \(thing-sdk\/src\/ThingApi\.php:L6-L9\)/);
  const deep = federateCallers(p, undefined, "ThingController.get", { depth: 2 });
  assert.match(deep.text, /shop\/src\/Checkout\.php/, "the SDK method's own callers, one hop further");
  // Unknown verb (the request object's method comes from run time) still links by path.
  assert.match(federateCallers(p, undefined, "ItemController.archive", {}).text, /Archive\.php/);
  // The SDK side sees the handler going out.
  assert.match(federateCallers(p, undefined, "ThingApi.getThing", { direction: "out" }).text, /thing-service\/app\/Http\/Controllers\/ThingController\.php/);
  rmSync(p, { recursive: true, force: true });
});

test("a route two other repos declare is ambiguous and gets no link; the most specific route wins", async () => {
  const p = await built();
  const stats = httpStats(p, loadWorkspaceGraphs(p).loaded);
  // /health is served by thing-service and (under /api) not by other-service, so it is unique;
  // a call to /api/ping from shop is other-service's.
  assert.match(federateCallers(p, undefined, "HealthController.ping", {}).text, /shop\/src\/Checkout\.php/);
  assert.match(federateCallers(p, undefined, "ItemController.confirm", {}).text, /http ← confirm \(thing-sdk\/src\/ThingApi\.php/);
  assert.deepEqual(
    stats.ambiguous.map((a) => `${a.call.path} ${a.candidates.join(" | ")}`),
    [
      "v2/items/lookup thing-service: app/Http/Controllers/Items/ItemController.php#ItemController.save | " +
        "thing-service: app/Http/Controllers/Items/ItemController.php#ItemController.show",
    ],
    "a run-time verb against GET and POST of one path picks neither",
  );
  assert.match(federateCallers(p, undefined, "ItemController.save", {}).text, /http ← doRequest \(thing-sdk\/src\/Requests\/Store\.php/);
  // The workspace map says what matched and lists what did not.
  const map = federateMap(p, undefined);
  assert.match(map, /links between repos: 1 by Composer use, 1 by method call, 8 by HTTP route \(of 10 requests: 1 ambiguous, 0 verb mismatch, 0 closure or unresolved handler, 1 no route in another repo\)/);
  assert.match(map, /ambiguous: ANY \/v2\/items\/lookup from thing-sdk\/src\/Requests\/Lookup\.php#Lookup\.doRequest → thing-service: /);
  assert.equal(stats.unmatched, 1, "POST /nowhere");
  rmSync(p, { recursive: true, force: true });

  const dup = await built({
    "mirror-service": {
      "composer.json": JSON.stringify({ autoload: { "psr-4": { "Mirror\\": "app/" } } }),
      "routes/web.php": "<?php\n\n$router->get('/getThing', 'Mirror\\Thing@get');\n$router->get('/v2/items/save2', 'Mirror\\Thing@get');\n",
      "app/Thing.php": "<?php\nnamespace Mirror;\n\nclass Thing\n{\n    public function get(): array\n    {\n        return [];\n    }\n}\n",
    },
  });
  const graphs = loadWorkspaceGraphs(dup).loaded;
  const s = httpStats(dup, graphs);
  assert.deepEqual(
    s.ambiguous.filter((a) => a.call.path === "getThing").map((a) => a.candidates.join(" | ")),
    ["mirror-service: app/Thing.php#Thing.get | thing-service: app/Http/Controllers/ThingController.php#ThingController.get"],
  );
  assert.doesNotMatch(federateCallers(dup, undefined, "ThingController.get", {}).text, /ThingApi/);
  // `items/{}` (one literal) loses to `items/save` (two) within thing-service: no ambiguity.
  const { matches } = matchHttp(graphs.map((c) => ({ child: c.child, http: c.graph.http })));
  assert.equal(matches.find((m) => m.call.path === "v2/items/save")?.endpoint.handler, "app/Http/Controllers/Items/ItemController.php#ItemController.save");
  rmSync(dup, { recursive: true, force: true });
});

test("a closure route links to its closure, bare, in an action array or as an arrow function", async () => {
  const p = await built({
    "report-service": {
      "composer.json": JSON.stringify({ autoload: { "psr-4": { "Report\\": "app/" } } }),
      "routes/web.php":
        "<?php\n\n$router->post('/getRtp', function ($request) {\n    return [];\n});\n" +
        "$router->get('/getCart', [\n    'middleware' => 'auth',\n    function () {\n        return [];\n    },\n]);\n" +
        "$router->get('/getUses', ['uses' => function () {\n    return [];\n}]);\n" +
        "$router->get('/getArrow', fn () => []);\n",
    },
    "report-client": {
      "composer.json": JSON.stringify({ autoload: { "psr-4": { "Client\\": "src/" } } }),
      "src/Reports.php":
        "<?php\nnamespace Client;\n\nclass Reports\n{\n" +
        "    public function rtp(): void\n    {\n        \\Http::post($this->base . '/getRtp');\n    }\n\n" +
        "    public function cart(): void\n    {\n        \\Http::get($this->base . '/getCart');\n    }\n\n" +
        "    public function uses(): void\n    {\n        \\Http::get($this->base . '/getUses');\n    }\n\n" +
        "    public function arrow(): void\n    {\n        \\Http::get($this->base . '/getArrow');\n    }\n}\n",
    },
  });
  const graphs = loadWorkspaceGraphs(p).loaded;
  const service = graphs.find((c) => c.child === "report-service")!.graph;
  const startOf = (id: string | null | undefined) => service.nodes.find((n) => n.id === id)?.span.split("-")[0];
  const { matches } = matchHttp(graphs.map((c) => ({ child: c.child, http: c.graph.http })));
  const target = (path: string) => matches.find((m) => m.fromChild === "report-client" && m.call.path === path)?.endpoint.handler;
  assert.equal(startOf(target("getRtp")), "L3", "bare closure argument");
  assert.equal(startOf(target("getCart")), "L8", "closure among the action array's entries");
  assert.equal(startOf(target("getUses")), "L12", "closure under 'uses'");
  assert.equal(startOf(target("getArrow")), "L15", "arrow function");
  assert.equal(httpStats(p, graphs).noHandler, 0);
  rmSync(p, { recursive: true, force: true });
});

test("find_all counts http callers in a handler's in-degree", async () => {
  const p = await built();
  const r = federateGrep(p, undefined, "function get\\(", {});
  const g = r.result.groups.find((x) => x.path === "thing-service/app/Http/Controllers/ThingController.php");
  assert.ok(g && g.inDegree >= 1, `in-degree ${g?.inDegree}`);
  rmSync(p, { recursive: true, force: true });
});

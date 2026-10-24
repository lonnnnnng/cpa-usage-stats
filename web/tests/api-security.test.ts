import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, mock, test } from "node:test";
import {
  fetchOptions,
  fetchRecords,
  fetchStats,
  fetchStorage,
  fetchSummary,
  reclaimStorage,
  UnauthorizedError,
} from "../src/lib/api.ts";
import { resolveManagementKey } from "../src/lib/auth.ts";

const origin = "http://127.0.0.1:8317";
const basePath = "/v0/management/plugins/cpa-usage-stats";
const key = "synthetic-test-key-not-a-real-secret";
const filters = { range: "all", model: "", provider: "", apiKey: "", authId: "", sessionId: "" };
const endpoints = [
  { path: "/summary", method: "GET", call: (value: string) => fetchSummary(value, filters) },
  { path: "/records", method: "GET", call: (value: string) => fetchRecords(value, filters, 1, 20) },
  { path: "/options", method: "GET", call: fetchOptions },
  { path: "/stats", method: "GET", call: fetchStats },
  { path: "/storage", method: "GET", call: fetchStorage },
  { path: "/storage/reclaim", method: "POST", call: reclaimStorage },
];

const browserGlobals = ["window", "localStorage", "sessionStorage"] as const;
const descriptors = new Map(browserGlobals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));

afterEach(() => {
  mock.restoreAll();
  for (const name of browserGlobals) {
    const descriptor = descriptors.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

function setGlobal(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

function setBrowser(search = "", local = new Map<string, string>(), session = new Map<string, string>()) {
  setGlobal("window", { location: { origin, search, host: "127.0.0.1:8317" } });
  setGlobal("localStorage", { getItem: (name: string) => local.get(name) ?? null });
  setGlobal("sessionStorage", { getItem: (name: string) => session.get(name) ?? null });
}

// 作者：long。链接参数不得改变带管理密钥的目标，逐个覆盖全部管理接口，避免新增出口漏防护。
for (const override of [
  "https://attacker.invalid",
  "//attacker.invalid",
  "http://127.0.0.1:8318",
  "https://127.0.0.1:8317",
  "http://127.0.0.1:8317@attacker.invalid",
  "http://127.0.0.1:8317/path",
  "http://127.0.0.1:8317",
]) {
  test(`api_base cannot redirect credentials: ${override}`, async () => {
    setBrowser(`?api_base=${encodeURIComponent(override)}&api_base=https://other.invalid`);
    const fetchMock = mock.method(globalThis, "fetch", async () => Response.json({ ok: true }));
    for (const endpoint of endpoints) {
      assert.deepEqual(await endpoint.call(key), { ok: true });
      const lastCall = fetchMock.mock.calls.at(-1);
      assert.ok(lastCall);
      const [input, init] = lastCall.arguments;
      const url = new URL(String(input), origin);
      assert.equal(url.origin, origin);
      assert.equal(url.pathname, basePath + endpoint.path);
      assert.equal(init?.method, endpoint.method);
      assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${key}`);
      assert.equal(init?.mode, "same-origin");
      assert.equal(init?.credentials, "same-origin");
      assert.equal(init?.redirect, "error");
    }
    assert.equal(fetchMock.mock.calls.length, endpoints.length);
  });
}

test("normal requests and URL-like filter values stay on the same origin", async () => {
  setBrowser();
  const fetchMock = mock.method(globalThis, "fetch", async () => Response.json({ total: 0 }));
  const keyword = "https://attacker.invalid/?x=1&api_base=//other.invalid";
  assert.deepEqual(await fetchSummary(key, { ...filters, keyword }), { total: 0 });
  const url = new URL(String(fetchMock.mock.calls[0].arguments[0]));
  assert.equal(url.origin, origin);
  assert.equal(url.pathname, `${basePath}/summary`);
  assert.equal(url.searchParams.get("keyword"), keyword);
  assert.equal(url.searchParams.has("api_base"), false);
});

test("no saved key means no management requests, including POST", async () => {
  setBrowser();
  const fetchMock = mock.method(globalThis, "fetch", async () => Response.json({}));
  assert.equal(resolveManagementKey().key, "");
  for (const endpoint of endpoints) await assert.rejects(endpoint.call(""), UnauthorizedError);
  assert.equal(fetchMock.mock.calls.length, 0);
});

for (const source of ["own", "panel", "center"] as const) {
  test(`saved ${source} key cannot be sent to api_base`, async () => {
    const local = new Map<string, string>();
    if (source === "own") local.set("cpa-usage-stats.management-key", key);
    if (source === "panel") local.set("cpa-dashboard.management-key", key);
    if (source === "center") local.set("cli-proxy-auth", JSON.stringify({ managementKey: key }));
    setBrowser("?api_base=https%3A%2F%2Fattacker.invalid", local);
    assert.deepEqual(resolveManagementKey(), { key, source });
    const fetchMock = mock.method(globalThis, "fetch", async () => Response.json({}));
    await fetchOptions(resolveManagementKey().key);
    assert.equal(new URL(String(fetchMock.mock.calls[0].arguments[0])).origin, origin);
  });
}

// 作者：long。真实本地 HTTP 跳转用于核实 redirect:error，断言跳转目标从未收到请求或密钥。
for (const status of [301, 302, 303, 307, 308]) {
  test(`management requests reject HTTP ${status} redirects`, async () => {
    let targetHits = 0;
    const server = createServer((req, res) => {
      if (req.url === "/redirect-target") {
        targetHits++;
        res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
        return;
      }
      res.writeHead(status, { Location: "/redirect-target" }).end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    setGlobal("window", { location: { origin: `http://127.0.0.1:${port}`, search: "" } });
    try {
      for (const endpoint of endpoints) await assert.rejects(endpoint.call(key), TypeError);
      assert.equal(targetHits, 0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });
}

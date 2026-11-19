import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { resolveManagementKey } from "../src/lib/auth.ts";
import { encodeCenterState } from "./helpers/auth-fixture.ts";

const names = ["localStorage", "sessionStorage", "window", "navigator"] as const;
const descriptors = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
let local: Map<string, string>;
let session: Map<string, string>;
const state = { state: { managementKey: "synthetic-center-key", rememberPassword: true }, version: 0 };
const set = (name: string, value: unknown) =>
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

beforeEach(() => {
  local = new Map();
  session = new Map();
  set("localStorage", { getItem: (key: string) => local.get(key) ?? null });
  set("sessionStorage", { getItem: (key: string) => session.get(key) ?? null });
  set("window", { location: { host: "127.0.0.1:8317" } });
});
afterEach(() => {
  for (const name of names) {
    const descriptor = descriptors.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

test("v2 remembered center credentials survive user agent changes", () => {
  local.set("cli-proxy-auth", encodeCenterState(state));
  for (const userAgent of ["old-browser", "new-browser"]) {
    set("navigator", { userAgent });
    assert.deepEqual(resolveManagementKey(), { key: "synthetic-center-key", source: "center" });
  }
});

test("plugin and panel credentials keep priority over remembered center state", () => {
  local.set("cli-proxy-auth", encodeCenterState(state));
  local.set("cpa-dashboard.management-key", "synthetic-panel");
  assert.deepEqual(resolveManagementKey(), { key: "synthetic-panel", source: "panel" });
  session.set("cpa-dashboard.management-key", "synthetic-session");
  assert.deepEqual(resolveManagementKey(), { key: "synthetic-session", source: "panel" });
  local.set("cpa-usage-stats.management-key", "synthetic-own");
  assert.deepEqual(resolveManagementKey(), { key: "synthetic-own", source: "own" });
});

test("retired, foreign-host, corrupt and unremembered center states are ignored", () => {
  for (const raw of [
    encodeCenterState(state, "127.0.0.1:8317", "enc::v1::"),
    encodeCenterState(state, "other.invalid:8317"),
    JSON.stringify(state),
    "enc::v2::invalid!",
    encodeCenterState({ state: { managementKey: "key", rememberPassword: false } }),
    encodeCenterState({ state: { managementKey: "key" } }),
    encodeCenterState({ managementKey: "key" }),
    encodeCenterState({ state: { managementKey: 123, rememberPassword: true } }),
    encodeCenterState({ state: null }),
    encodeCenterState(null),
  ]) {
    local.set("cli-proxy-auth", raw);
    assert.equal(resolveManagementKey().key, "");
  }
});

test("denied storage leaves the page unauthenticated", () => {
  const denied = {
    getItem: () => {
      throw new Error("denied");
    },
  };
  set("localStorage", denied);
  set("sessionStorage", denied);
  assert.equal(resolveManagementKey().key, "");
});

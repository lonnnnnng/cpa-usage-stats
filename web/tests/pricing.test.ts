import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { type PricingTable, priceFor } from "../src/lib/pricing.ts";

const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
afterEach(() => {
  if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

test("Kimi aliases prefer Moonshot pricing over earlier third-party entries", () => {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null } });
  for (const official of ["moonshotai", "moonshot"]) {
    const table: PricingTable = {
      fetchedAt: 0,
      models: { "kimi-test": { reseller: { input: 99, output: 99 }, [official]: { input: 2, output: 3 } } },
    };
    for (const provider of ["kimi", "kimi-ai"]) {
      const match = priceFor(table, { model: "kimi-test", provider });
      assert.equal(match?.providerId, official);
      assert.deepEqual(match?.price, { input: 2, output: 3 });
    }
  }
});

test("custom Kimi prices retain priority and missing Moonshot entries keep fallback", () => {
  const table: PricingTable = { fetchedAt: 0, models: { "kimi-test": { reseller: { input: 9, output: 10 } } } };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null } });
  assert.equal(priceFor(table, { model: "kimi-test", provider: "kimi" })?.providerId, "reseller");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => JSON.stringify({ "kimi-test": { input: 1, output: 2 } }) },
  });
  const match = priceFor(table, { model: "kimi-test", provider: "kimi-ai" });
  assert.equal(match?.providerId, "custom");
  assert.deepEqual(match?.price, { input: 1, output: 2 });
});

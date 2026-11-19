import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { usageQueryOptions } from "../src/lib/usage-queries.ts";
import type { OverviewData, RecordsFilters } from "../src/types/index.ts";

const filters: RecordsFilters = {
  model: "",
  provider: "",
  apiKey: "",
  authId: "",
  sessionId: "",
  traceId: "",
  selectionId: "",
  status: "all",
  keyword: "",
};
const overview: OverviewData = {
  total_requests: 7,
  success_requests: 7,
  failed_requests: 0,
  success_rate: 100,
  total_tokens: 0,
  input_tokens: 0,
  output_tokens: 0,
  reasoning_tokens: 0,
  cached_tokens: 0,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
  cache_hit_rate: 0,
  avg_latency_ms: 0,
  avg_ttft_ms: 0,
  p50_latency_ms: 0,
  p95_latency_ms: 0,
  p99_latency_ms: 0,
  avg_output_tps: 0,
  stream_requests: 0,
  dropped_records: 0,
  model_stats: [],
  provider_stats: [],
  api_key_stats: [],
  auth_stats: [],
  session_stats: [],
  bucket: "day",
  trend: [],
};
const descriptors = Object.getOwnPropertyDescriptor(globalThis, "window");
afterEach(() => {
  mock.restoreAll();
  if (descriptors) Object.defineProperty(globalThis, "window", descriptors);
  else Reflect.deleteProperty(globalThis, "window");
});
function browser() {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { origin: "http://localhost:8317" } },
  });
}

test("pagination never changes summary or option cache keys; credentials isolate caches", () => {
  const a = usageQueryOptions("synthetic-a", "all", filters, 1, 15);
  const b = usageQueryOptions("synthetic-a", "all", filters, 2, 100);
  assert.deepEqual(a.summary.queryKey, b.summary.queryKey);
  assert.deepEqual(a.options.queryKey, b.options.queryKey);
  assert.notDeepEqual(a.records.queryKey, b.records.queryKey);
  assert.notDeepEqual(a.options.queryKey, usageQueryOptions("synthetic-b", "all", filters, 1, 15).options.queryKey);
});

test("invalid authentication probe has no retries or downstream requests", async () => {
  browser();
  const fetchMock = mock.method(globalThis, "fetch", async () => new Response("{}", { status: 401 }));
  const client = new QueryClient();
  try {
    await assert.rejects(client.fetchQuery(usageQueryOptions("synthetic-invalid", "all", filters, 1, 15).options));
    assert.equal(fetchMock.mock.calls.length, 1);
    assert.ok(String(fetchMock.mock.calls[0].arguments[0]).endsWith("/options"));
  } finally {
    client.clear();
  }
});

test("refresh reuses pending request; changing filters aborts obsolete fetch", async () => {
  browser();
  const signals: AbortSignal[] = [];
  const pending: ((value: Response) => void)[] = [];
  mock.method(
    globalThis,
    "fetch",
    (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        signals.push(init?.signal as AbortSignal);
        pending.push(resolve);
        init?.signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")));
      }),
  );
  const client = new QueryClient();
  const first = usageQueryOptions("synthetic-ok", "all", filters, 1, 15).summary;
  client.setQueryData(first.queryKey, overview);
  const observer = new QueryObserver(client, { ...first, staleTime: 0 });
  const unsubscribe = observer.subscribe(() => {});
  try {
    const a = observer.refetch({ cancelRefetch: false });
    const b = observer.refetch({ cancelRefetch: false });
    assert.equal(signals.length, 1);
    pending[0](Response.json({ total_requests: 8 }));
    await Promise.all([a, b]);
    void observer.refetch({ cancelRefetch: false });
    assert.equal(signals.length, 2);
    observer.setOptions(usageQueryOptions("synthetic-ok", "today", filters, 1, 15).summary);
    assert.equal(signals[1].aborted, true);
    assert.equal(signals.length, 3);
    pending[2](Response.json({ total_requests: 1 }));
  } finally {
    unsubscribe();
    observer.destroy();
    client.clear();
  }
});

import { queryOptions } from "@tanstack/react-query";
import type { RecordsFilters } from "../types/index.ts";
import { fetchOptions, fetchOverview, fetchRecords, keyFingerprint, UnauthorizedError } from "./api.ts";

// 作者：long。共享前缀让清理记录后的失效仍覆盖全部用量缓存；分页只参与明细键。
export function usageQueryOptions(key: string, range: string, filters: RecordsFilters, page: number, pageSize: number) {
  const prefix = ["usage", keyFingerprint(key)] as const;
  const shared = {
    ...filters,
    range,
    failed: filters.status === "all" ? undefined : filters.status === "failed" ? "true" : "false",
  };
  const retry = (count: number, error: Error) => !(error instanceof UnauthorizedError) && count < 1;
  // 作者：long。仅相同密钥下切筛选/分页保留旧结果，换密钥不能展示前一个密钥的数据。
  const sameKey = <T>(data: T | undefined, previous: { queryKey: readonly unknown[] } | undefined) =>
    previous?.queryKey[1] === prefix[1] ? data : undefined;
  return {
    options: queryOptions({
      queryKey: [...prefix, "options"],
      queryFn: ({ signal }) => fetchOptions(key, signal),
      staleTime: 60_000,
      retry: false,
      retryOnMount: false,
    }),
    summary: queryOptions({
      queryKey: [...prefix, "summary", "overview", range, filters],
      queryFn: ({ signal }) => fetchOverview(key, shared, signal),
      placeholderData: sameKey,
      retry,
    }),
    records: queryOptions({
      queryKey: [...prefix, "records", range, filters, page, pageSize],
      queryFn: ({ signal }) => fetchRecords(key, shared, page, pageSize, signal),
      placeholderData: sameKey,
      retry,
    }),
    storageKey: [...prefix, "storage"],
  };
}

import { queryOptions } from "@tanstack/react-query";
import type { LifecycleFilters, RecordsFilters } from "../types/index.ts";
import { fetchLifecycle, fetchOptions, fetchOverview, fetchRecords, keyFingerprint, UnauthorizedError } from "./api.ts";

// 作者：long。业务接口的401也撤销会话门控，防止用户切筛选后继续提交已失效密钥。
async function authorizedRequest<T>(request: () => Promise<T>, onUnauthorized?: () => void): Promise<T> {
  try {
    return await request();
  } catch (error) {
    if (error instanceof UnauthorizedError) onUnauthorized?.();
    throw error;
  }
}

export function lifecycleQueryOptions(
  key: string,
  range: string,
  filters: LifecycleFilters,
  page: number,
  onUnauthorized?: () => void,
) {
  const fingerprint = keyFingerprint(key);
  return queryOptions({
    queryKey: ["usage", fingerprint, "lifecycle", range, filters, page],
    queryFn: ({ signal }) => authorizedRequest(() => fetchLifecycle(key, range, filters, page, signal), onUnauthorized),
    // 作者：long。只复用同一密钥的已显示事件，切换凭据时不能泄露前一个身份的记录。
    placeholderData: (data, previous) => (previous?.queryKey[1] === fingerprint ? data : undefined),
    retry: (count, error) => !(error instanceof UnauthorizedError) && count < 1,
  });
}

// 作者：long。共享前缀让清理记录后的失效仍覆盖全部用量缓存；分页只参与明细键。
export function usageQueryOptions(
  key: string,
  range: string,
  filters: RecordsFilters,
  page: number,
  pageSize: number,
  onUnauthorized?: () => void,
) {
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
      queryFn: ({ signal }) => authorizedRequest(() => fetchOverview(key, shared, signal), onUnauthorized),
      placeholderData: sameKey,
      retry,
    }),
    records: queryOptions({
      queryKey: [...prefix, "records", range, filters, page, pageSize],
      queryFn: ({ signal }) =>
        authorizedRequest(() => fetchRecords(key, shared, page, pageSize, signal), onUnauthorized),
      placeholderData: sameKey,
      retry,
    }),
    storageKey: [...prefix, "storage"],
  };
}

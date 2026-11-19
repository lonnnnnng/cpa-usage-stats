package storage

import (
	"fmt"
	"sort"

	"cpa-usage-stats/internal/model"
)

type summaryTotals struct {
	requests, failed, tokens, input, output, reasoning, cached, read, creation int64
	latency, ttft, streams, ttftCount, tpsCount, prompt                        int64
	tps                                                                        float64
	latencies                                                                  []int64
}

type summaryRow struct {
	model, provider, key, auth, authIndex, authType, session, trace, selection, bucket string
	failed, tokens, input, output, reasoning, cached, read, creation, prompt           int64
	latency, ttft, stream                                                              int64
}

func (a *summaryTotals) add(r *summaryRow) {
	a.requests++
	a.failed += r.failed
	a.tokens += r.tokens
	a.input += r.input
	a.output += r.output
	a.reasoning += r.reasoning
	a.cached += r.cached
	a.read += r.read
	a.creation += r.creation
	a.prompt += r.prompt
	a.latency += r.latency
	a.latencies = append(a.latencies, r.latency)
	if r.stream == 1 {
		a.streams++
		if r.ttft > 0 {
			a.ttft += r.ttft
			a.ttftCount++
		}
		if r.latency > r.ttft && r.output > 0 {
			a.tps += float64(r.output) * 1000 / float64(r.latency-r.ttft)
			a.tpsCount++
		}
	}
}

func average(sum, count int64) float64 {
	if count == 0 {
		return 0
	}
	return float64(sum) / float64(count)
}

func (a *summaryTotals) percentiles() (float64, float64, float64) {
	if len(a.latencies) == 0 {
		return 0, 0, 0
	}
	// 作者：long。沿用 CUME_DIST 的最近秩百分位，保留重复延迟、失败请求与小样本的原有统计口径。
	sort.Slice(a.latencies, func(i, j int) bool { return a.latencies[i] < a.latencies[j] })
	at := func(percent int) float64 { return float64(a.latencies[(len(a.latencies)*percent+99)/100-1]) }
	return at(50), at(95), at(99)
}

type summaryGroupKey [3]string
type summaryGroups map[summaryGroupKey]*summaryTotals

func (groups summaryGroups) add(key summaryGroupKey, r *summaryRow) {
	value := groups[key]
	if value == nil {
		value = &summaryTotals{}
		groups[key] = value
	}
	value.add(r)
}

func (groups summaryGroups) stats(auth bool) []model.GroupStat {
	result := make([]model.GroupStat, 0, len(groups))
	for key, a := range groups {
		_, p95, _ := a.percentiles()
		name := key[0]
		if auth && key[2] != "" {
			name += " · " + key[2]
		}
		result = append(result, model.GroupStat{Name: name, Secondary: key[1], Requests: a.requests,
			Failed: a.failed, TotalTokens: a.tokens, InputTokens: a.input, OutputTokens: a.output,
			ReasoningTokens: a.reasoning, CachedTokens: a.cached, CacheReadTokens: a.read,
			CacheCreationTokens: a.creation, AvgLatencyMs: average(a.latency, a.requests),
			P95LatencyMs: p95, AvgTtftMs: average(a.ttft, a.ttftCount), StreamRequests: a.streams})
	}
	// 作者：long。保持 tokens/requests 降序；同值再按身份排序，让刷新与接口对照有稳定次序。
	sort.Slice(result, func(i, j int) bool {
		a, b := result[i], result[j]
		if a.TotalTokens != b.TotalTokens {
			return a.TotalTokens > b.TotalTokens
		}
		if a.Requests != b.Requests {
			return a.Requests > b.Requests
		}
		if a.Name != b.Name {
			return a.Name < b.Name
		}
		return a.Secondary < b.Secondary
	})
	return result
}

// GetSummary 保持原完整响应；首页通过 GetOverview 避免生成数万条无展示用途的 Trace 聚合。作者：long。
func (s *Storage) GetSummary(filter model.UsageFilter, hourly bool) (*model.SummaryResponse, error) {
	return s.summary(filter, hourly, false)
}

func (s *Storage) GetOverview(filter model.UsageFilter, hourly bool) (*model.SummaryResponse, error) {
	return s.summary(filter, hourly, true)
}

func (s *Storage) summary(filter model.UsageFilter, hourly, overview bool) (*model.SummaryResponse, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	where, args := buildWhere(filter)
	bucketLen := 10
	response := &model.SummaryResponse{Bucket: "day", SuccessRate: 100}
	if hourly {
		response.Bucket, bucketLen = "hour", 13
	}
	correlationColumns := "COALESCE(trace_id, ''), COALESCE(selection_id, '')"
	if overview {
		correlationColumns = "'', ''"
	}
	// 作者：long。一次只读取聚合需要的窄列，避免九次窗口排序反复搬运错误正文、响应头与整条明细。
	rows, err := s.db.Query(fmt.Sprintf(`SELECT COALESCE(model, ''), COALESCE(provider, ''),
		COALESCE(api_key, ''), COALESCE(auth_id, ''), COALESCE(auth_index, ''), COALESCE(auth_type, ''),
		COALESCE(session_id, ''), %s, SUBSTR(requested_at, 1, %d),
		failed, total_tokens, input_tokens, output_tokens, reasoning_tokens, cached_tokens,
		%s, cache_creation_tokens, %s, latency_ms, ttft_ms, stream FROM usage_records %s`,
		correlationColumns, bucketLen, effectiveCacheReadSQL, cachePromptSQL, where), args...)
	if err != nil {
		return nil, fmt.Errorf("query summary rows: %w", err)
	}
	total := &summaryTotals{}
	groups := make([]summaryGroups, 5)
	if !overview {
		groups = make([]summaryGroups, 7)
	}
	for i := range groups {
		groups[i] = summaryGroups{}
	}
	buckets := map[string]*summaryTotals{}
	for rows.Next() {
		var r summaryRow
		if err := rows.Scan(&r.model, &r.provider, &r.key, &r.auth, &r.authIndex, &r.authType,
			&r.session, &r.trace, &r.selection, &r.bucket, &r.failed, &r.tokens, &r.input, &r.output,
			&r.reasoning, &r.cached, &r.read, &r.creation, &r.prompt, &r.latency, &r.ttft, &r.stream); err != nil {
			rows.Close()
			return nil, fmt.Errorf("scan summary row: %w", err)
		}
		total.add(&r)
		keys := []summaryGroupKey{{r.model, r.provider}, {r.provider}, {r.key}, {r.auth, r.authIndex, r.authType}, {r.session}, {r.trace}, {r.selection}}
		for i, group := range groups {
			group.add(keys[i], &r)
		}
		if buckets[r.bucket] == nil {
			buckets[r.bucket] = &summaryTotals{}
		}
		buckets[r.bucket].add(&r)
	}
	readErr := rows.Err()
	rows.Close()
	if readErr != nil {
		return nil, fmt.Errorf("read summary rows: %w", readErr)
	}
	response.TotalRequests, response.FailedRequests = total.requests, total.failed
	response.SuccessRequests = total.requests - total.failed
	if total.requests > 0 {
		response.SuccessRate = float64(response.SuccessRequests) / float64(total.requests) * 100
	}
	response.TotalTokens, response.InputTokens, response.OutputTokens = total.tokens, total.input, total.output
	response.ReasoningTokens, response.CachedTokens = total.reasoning, total.cached
	response.CacheReadTokens, response.CacheCreationTokens = total.read, total.creation
	response.AvgLatencyMs, response.AvgTTFTMs = average(total.latency, total.requests), average(total.ttft, total.ttftCount)
	response.P50LatencyMs, response.P95LatencyMs, response.P99LatencyMs = total.percentiles()
	response.StreamRequests = total.streams
	if total.tpsCount > 0 {
		response.AvgOutputTps = total.tps / float64(total.tpsCount)
	}
	if total.prompt > 0 {
		response.CacheHitRate = float64(total.read) / float64(total.prompt) * 100
	}
	response.Models, response.Providers, response.APIKeys = groups[0].stats(false), groups[1].stats(false), groups[2].stats(false)
	response.Auths, response.Sessions = groups[3].stats(true), groups[4].stats(false)
	if !overview {
		response.Traces, response.Selections = groups[5].stats(false), groups[6].stats(false)
		response.UniqueTraces = int64(len(groups[5]))
		if _, ok := groups[5][summaryGroupKey{""}]; ok {
			response.UniqueTraces--
		}
		response.UniqueSessions = int64(len(groups[4]))
		if _, ok := groups[4][summaryGroupKey{""}]; ok {
			response.UniqueSessions--
		}
		// 作者：long。终态与失败汇总只执行一次，禁止再放入维度循环重复扫描。
		if response.Lifecycle, err = s.GetLifecycleSummaryLocked(filter); err != nil {
			return nil, err
		}
		if response.Failures, err = s.failureStats(where, args); err != nil {
			return nil, err
		}
	}
	response.Trend = make([]model.TrendPoint, 0, len(buckets))
	for key, a := range buckets {
		_, p95, _ := a.percentiles()
		response.Trend = append(response.Trend, model.TrendPoint{Bucket: key, Requests: a.requests, Failed: a.failed,
			Tokens: a.tokens, InputTokens: a.input, OutputTokens: a.output, AvgLatencyMs: average(a.latency, a.requests), P95LatencyMs: p95})
	}
	sort.Slice(response.Trend, func(i, j int) bool { return response.Trend[i].Bucket < response.Trend[j].Bucket })
	return response, nil
}

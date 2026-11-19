package storage

// 作者：long。保留发布版 SQL 作为独立对照，防止性能改写悄悄改变计费、分组或百分位口径。
import (
	"cpa-usage-stats/internal/model"
	"fmt"
)

// GetSummary returns aggregated statistics for the filter. The trend is
// bucketed by hour when hourly is true, by day otherwise.
func (s *Storage) legacySummary(filter model.UsageFilter, hourly bool) (*model.SummaryResponse, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	where, args := buildWhere(filter)

	resp := &model.SummaryResponse{Bucket: "day"}
	var cachePromptTokens int64
	// Latency percentiles come from the same single pass: CUME_DIST gives each
	// row its cumulative share, so the first row reaching the target share is
	// the nearest-rank percentile (PERCENT_RANK would return the row below it).
	err := s.db.QueryRow(fmt.Sprintf(`
		SELECT
			COUNT(*),
			COALESCE(SUM(failed), 0),
			COALESCE(SUM(total_tokens), 0),
			COALESCE(SUM(input_tokens), 0),
			COALESCE(SUM(output_tokens), 0),
			COALESCE(SUM(reasoning_tokens), 0),
			COALESCE(SUM(cached_tokens), 0),
			COALESCE(SUM(`+effectiveCacheReadSQL+`), 0),
			COALESCE(SUM(cache_creation_tokens), 0),
			COALESCE(AVG(latency_ms), 0),
			COALESCE(AVG(CASE WHEN stream = 1 AND ttft_ms > 0 THEN ttft_ms END), 0),
			COALESCE(MIN(CASE WHEN pct >= 0.5 THEN latency_ms END), 0),
			COALESCE(MIN(CASE WHEN pct >= 0.95 THEN latency_ms END), 0),
			COALESCE(MIN(CASE WHEN pct >= 0.99 THEN latency_ms END), 0),
			COALESCE(SUM(CASE WHEN stream = 1 THEN 1 ELSE 0 END), 0),
			COALESCE(AVG(CASE WHEN stream = 1 AND latency_ms > ttft_ms AND output_tokens > 0
				THEN output_tokens * 1000.0 / (latency_ms - ttft_ms) END), 0)
			, COALESCE(SUM(`+cachePromptSQL+`), 0)
		FROM (
			SELECT *, CUME_DIST() OVER (ORDER BY latency_ms) AS pct FROM usage_records %s
		)
	`, where), args...).Scan(
		&resp.TotalRequests,
		&resp.FailedRequests,
		&resp.TotalTokens,
		&resp.InputTokens,
		&resp.OutputTokens,
		&resp.ReasoningTokens,
		&resp.CachedTokens,
		&resp.CacheReadTokens,
		&resp.CacheCreationTokens,
		&resp.AvgLatencyMs,
		&resp.AvgTTFTMs,
		&resp.P50LatencyMs,
		&resp.P95LatencyMs,
		&resp.P99LatencyMs,
		&resp.StreamRequests,
		&resp.AvgOutputTps,
		&cachePromptTokens,
	)
	if err != nil {
		return nil, fmt.Errorf("query total summary: %w", err)
	}
	resp.SuccessRequests = resp.TotalRequests - resp.FailedRequests
	if resp.TotalRequests > 0 {
		resp.SuccessRate = float64(resp.SuccessRequests) / float64(resp.TotalRequests) * 100
	} else {
		resp.SuccessRate = 100
	}
	// 同一份汇总可能同时包含 OpenAI/Codex 与 Anthropic；SQL 已按每条记录
	// 的协议语义计算 prompt 分母，避免把两种 token 口径混成一个比例。作者：long
	if cachePromptTokens > 0 {
		resp.CacheHitRate = float64(resp.CacheReadTokens) / float64(cachePromptTokens) * 100
	}

	// Every dimension shares the same shape, so they are declared once and
	// filled in a loop instead of repeating the plumbing per group.
	groups := []struct {
		groupBy   string
		secondary string
		target    *[]model.GroupStat
	}{
		{"model, provider", "model", &resp.Models},
		{"provider", "", &resp.Providers},
		{"api_key", "", &resp.APIKeys},
		{"auth_id, auth_index, auth_type", "auth", &resp.Auths},
		{"session_id", "", &resp.Sessions},
		{"trace_id", "", &resp.Traces},
		{"selection_id", "", &resp.Selections},
	}
	for _, group := range groups {
		stats, err := s.legacyGroupStats(group.groupBy, group.secondary, where, args)
		if err != nil {
			return nil, err
		}
		if err := s.db.QueryRow(fmt.Sprintf("SELECT COUNT(DISTINCT NULLIF(trace_id, '')), COUNT(DISTINCT NULLIF(session_id, '')) FROM usage_records %s", where), args...).Scan(&resp.UniqueTraces, &resp.UniqueSessions); err != nil {
			return nil, fmt.Errorf("query correlation counts: %w", err)
		}
		if resp.Lifecycle, err = s.GetLifecycleSummaryLocked(filter); err != nil {
			return nil, err
		}
		*group.target = stats
	}

	if resp.Failures, err = s.failureStats(where, args); err != nil {
		return nil, err
	}

	// "2006-01-02 15" for hours, "2006-01-02" for days.
	bucketLen := 10
	if hourly {
		resp.Bucket = "hour"
		bucketLen = 13
	}
	rows, err := s.db.Query(fmt.Sprintf(`
		SELECT
			bucket,
			COUNT(*),
			COALESCE(SUM(failed), 0),
			COALESCE(SUM(total_tokens), 0),
			COALESCE(SUM(input_tokens), 0),
			COALESCE(SUM(output_tokens), 0),
			COALESCE(AVG(latency_ms), 0),
			COALESCE(MIN(CASE WHEN pct >= 0.95 THEN latency_ms END), 0)
		FROM (
			SELECT *, SUBSTR(requested_at, 1, %[1]d) AS bucket,
				CUME_DIST() OVER (PARTITION BY SUBSTR(requested_at, 1, %[1]d) ORDER BY latency_ms) AS pct
			FROM usage_records %[2]s
		)
		GROUP BY bucket
		ORDER BY bucket
	`, bucketLen, where), args...)
	if err != nil {
		return nil, fmt.Errorf("query trend: %w", err)
	}
	defer rows.Close()

	resp.Trend = []model.TrendPoint{}
	for rows.Next() {
		var p model.TrendPoint
		if err := rows.Scan(
			&p.Bucket,
			&p.Requests,
			&p.Failed,
			&p.Tokens,
			&p.InputTokens,
			&p.OutputTokens,
			&p.AvgLatencyMs,
			&p.P95LatencyMs,
		); err != nil {
			return nil, fmt.Errorf("scan trend: %w", err)
		}
		resp.Trend = append(resp.Trend, p)
	}
	return resp, rows.Err()
}

// groupStats aggregates usage by one dimension. groupBy and secondary are
// fixed column lists from GetSummary, never user input. secondary selects the
// extra columns carried into GroupStat.Secondary:
//   - "model": the provider the model was served by
//   - "auth": the upstream credential identity
func (s *Storage) legacyGroupStats(groupBy, secondary, where string, args []interface{}) ([]model.GroupStat, error) {
	// auth rows carry three identity columns; everything else groups on the
	// raw column list (model, provider groups on two).
	selectCols := groupBy
	if secondary == "auth" {
		selectCols = "auth_id, auth_index, auth_type"
	}

	rows, err := s.db.Query(fmt.Sprintf(`
		SELECT
			%[1]s,
			COUNT(*) AS requests,
			COALESCE(SUM(failed), 0),
			COALESCE(SUM(total_tokens), 0) AS tokens,
			COALESCE(SUM(input_tokens), 0),
			COALESCE(SUM(output_tokens), 0),
			COALESCE(SUM(reasoning_tokens), 0),
			COALESCE(SUM(cached_tokens), 0),
			COALESCE(SUM(`+effectiveCacheReadSQL+`), 0),
			COALESCE(SUM(cache_creation_tokens), 0),
			COALESCE(AVG(latency_ms), 0),
			COALESCE(MIN(CASE WHEN pct >= 0.95 THEN latency_ms END), 0),
			COALESCE(AVG(CASE WHEN stream = 1 AND ttft_ms > 0 THEN ttft_ms END), 0),
			COALESCE(SUM(CASE WHEN stream = 1 THEN 1 ELSE 0 END), 0)
		FROM (
			SELECT *, CUME_DIST() OVER (PARTITION BY %[1]s ORDER BY latency_ms) AS pct
			FROM usage_records %[2]s
		)
		GROUP BY %[1]s
		ORDER BY tokens DESC, requests DESC
	`, selectCols, where), args...)
	if err != nil {
		return nil, fmt.Errorf("query %s stats: %w", groupBy, err)
	}
	defer rows.Close()

	stats := []model.GroupStat{}
	for rows.Next() {
		var g model.GroupStat
		var name, second, third string
		dest := []any{&name}
		if secondary != "" {
			dest = append(dest, &second)
		}
		if secondary == "auth" {
			dest = append(dest, &third)
		}
		dest = append(dest,
			&g.Requests,
			&g.Failed,
			&g.TotalTokens,
			&g.InputTokens,
			&g.OutputTokens,
			&g.ReasoningTokens,
			&g.CachedTokens,
			&g.CacheReadTokens,
			&g.CacheCreationTokens,
			&g.AvgLatencyMs,
			&g.P95LatencyMs,
			&g.AvgTtftMs,
			&g.StreamRequests,
		)
		if err := rows.Scan(dest...); err != nil {
			return nil, fmt.Errorf("scan %s stats: %w", groupBy, err)
		}
		g.Name = name
		g.Secondary = second
		if secondary == "auth" {
			// auth_id is the group key; show its type alongside for readability.
			if third != "" {
				g.Name = fmt.Sprintf("%s · %s", name, third)
			}
		}
		stats = append(stats, g)
	}
	return stats, rows.Err()
}

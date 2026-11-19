package storage

import (
	"encoding/json"
	"fmt"
	"math"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"cpa-usage-stats/internal/model"
)

func TestSummaryMatchesReleasedSQL(t *testing.T) {
	s, err := New(filepath.Join(t.TempDir(), "usage.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	now := time.Date(2026, 11, 19, 15, 59, 0, 0, time.UTC)
	records := make([]model.UsageRecord, 257)
	for i := range records {
		r := model.UsageRecord{RequestID: fmt.Sprint(i), TraceID: fmt.Sprintf("t%d", i%41), SelectionID: fmt.Sprintf("x%d", i%7),
			SessionID: fmt.Sprintf("s%d", i%9), Provider: []string{"openai", "claude", "custom"}[i%3],
			Model: fmt.Sprintf("m%d", i%5), AuthID: fmt.Sprintf("a%d", i%4), AuthIndex: fmt.Sprint(i % 3), AuthType: "oauth",
			APIKey: fmt.Sprintf("k%d", i%2), RequestedAt: now.Add(-time.Duration(i) * time.Hour),
			Latency: time.Duration(i%13) * time.Millisecond, TTFT: time.Duration(i%4) * time.Millisecond, Stream: i%3 != 0,
			Failed: i%11 == 0, Detail: model.UsageDetail{InputTokens: int64(i%5) * 100, OutputTokens: int64(i%9) * 10,
				ReasoningTokens: int64(i % 7), CachedTokens: int64(i%4) * 20, CacheReadTokens: int64(i%3) * 30,
				CacheCreationTokens: int64(i%6) * 10, TotalTokens: int64(i%9) * 110}}
		if i%17 == 0 {
			r.TraceID, r.SessionID, r.SelectionID = "", "", ""
		}
		if r.Failed {
			r.Failure = model.UsageFailure{StatusCode: 429, Body: `{"error":{"type":"rate_limit_error"}}`}
		}
		records[i] = r
	}
	if err := s.InsertBatch(records); err != nil {
		t.Fatal(err)
	}
	for _, outcome := range []string{"succeeded", "failed", "rejected", "canceled"} {
		if err := s.StoreLifecycle(model.RequestCompletion{RequestID: outcome, TraceID: "t1", Outcome: outcome, CompletedAt: now}); err != nil {
			t.Fatal(err)
		}
	}
	start, end := now.Add(-150*time.Hour), now.Add(-24*time.Hour)
	failed := true
	for i, filter := range []model.UsageFilter{{}, {StartTime: &start}, {StartTime: &start, EndTime: &end},
		{Model: "m1"}, {Provider: "claude", APIKey: "k1"}, {AuthID: "a1"}, {Session: "s1"},
		{Trace: "t1"}, {Selection: "x1"}, {Failed: &failed}, {Keyword: "rate_limit"}, {Model: "absent"}} {
		for _, hourly := range []bool{false, true} {
			t.Run(fmt.Sprintf("filter%d/hourly%v", i, hourly), func(t *testing.T) {
				want, err := s.legacySummary(filter, hourly)
				if err != nil {
					t.Fatal(err)
				}
				got, err := s.GetSummary(filter, hourly)
				if err != nil {
					t.Fatal(err)
				}
				overview, err := s.GetOverview(filter, hourly)
				if err != nil {
					t.Fatal(err)
				}
				canonical := func(v *model.SummaryResponse, compact bool) map[string]any {
					if compact {
						v.Traces, v.Selections, v.Failures = nil, nil, nil
						v.Lifecycle = model.LifecycleSummary{}
						v.UniqueTraces, v.UniqueSessions = 0, 0
					}
					for _, group := range []*[]model.GroupStat{&v.Models, &v.Providers, &v.APIKeys, &v.Auths, &v.Sessions, &v.Traces, &v.Selections} {
						sort.Slice(*group, func(i, j int) bool {
							a, _ := json.Marshal((*group)[i])
							b, _ := json.Marshal((*group)[j])
							return string(a) < string(b)
						})
					}
					raw, _ := json.Marshal(v)
					var result map[string]any
					_ = json.Unmarshal(raw, &result)
					return result
				}
				compareJSON(t, canonical(got, false), canonical(want, false), "full")
				compareJSON(t, canonical(overview, true), canonical(want, true), "overview")
			})
		}
	}
}

// 作者：long。SQL AVG 与逐行浮点累加的末位允许误差，整数计数与全部JSON结构必须完全一致。
func compareJSON(t *testing.T, got, want any, path string) {
	t.Helper()
	switch w := want.(type) {
	case map[string]any:
		g, ok := got.(map[string]any)
		if !ok || len(g) != len(w) {
			t.Fatalf("%s shape differs", path)
		}
		for k, v := range w {
			compareJSON(t, g[k], v, path+"/"+k)
		}
	case []any:
		g, ok := got.([]any)
		if !ok || len(g) != len(w) {
			t.Fatalf("%s lengths differ", path)
		}
		for i, v := range w {
			compareJSON(t, g[i], v, fmt.Sprintf("%s/%d", path, i))
		}
	case float64:
		g, ok := got.(float64)
		if !ok || math.Abs(g-w) > 1e-9*math.Max(1, math.Abs(w)) {
			t.Fatalf("%s got=%v want=%v", path, got, w)
		}
	default:
		if got != want {
			t.Fatalf("%s got=%v want=%v", path, got, want)
		}
	}
}

func TestPaginationAndStorageBounds(t *testing.T) {
	s, err := New(filepath.Join(t.TempDir(), "usage.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	stats, err := s.Stats(90)
	if err != nil || stats.RecordCount != 0 || stats.OldestRecordAt != "" || stats.NewestRecordAt != "" {
		t.Fatalf("empty stats=%+v err=%v", stats, err)
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	if err := s.InsertBatch([]model.UsageRecord{{RequestID: "later", RequestedAt: now}, {RequestID: "earlier", RequestedAt: now.Add(-time.Hour)}}); err != nil {
		t.Fatal(err)
	}
	stats, err = s.Stats(90)
	if err != nil || stats.RecordCount != 2 || !strings.HasPrefix(stats.OldestRecordAt, now.Add(-time.Hour).Format("2006-01-02 15:04:05")) {
		t.Fatalf("stats=%+v err=%v", stats, err)
	}
	for _, page := range []int{2, int(^uint(0) >> 1)} {
		r, err := s.GetRecords(model.UsageFilter{Page: page, PageSize: 100})
		if err != nil || r.Total != 2 || len(r.Items) != 0 || r.Items == nil {
			t.Fatalf("empty records=%+v err=%v", r, err)
		}
		l, err := s.GetLifecycle(model.UsageFilter{Page: page, PageSize: 100})
		if err != nil || len(l.Items) != 0 || l.Items == nil {
			t.Fatalf("empty lifecycle=%+v err=%v", l, err)
		}
	}
	r, err := s.GetRecords(model.UsageFilter{})
	if err != nil || r.Items[0].RequestID != "earlier" {
		t.Fatalf("id order changed=%+v err=%v", r, err)
	}
}

func TestLifecycleTimeIndexesAndUpsert(t *testing.T) {
	s, err := New(filepath.Join(t.TempDir(), "usage.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	for _, name := range []string{"idx_lifecycle_completed", "idx_lifecycle_received"} {
		var count int
		err := s.db.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name=?", name).Scan(&count)
		if err != nil || count != 1 {
			t.Fatalf("missing index %s: %v", name, err)
		}
	}
	now := time.Now()
	for _, event := range []model.RequestCompletion{{RequestID: "a", TraceID: "t", Outcome: "failed", CompletedAt: now.Add(-time.Hour)}, {RequestID: "b", Outcome: "rejected"}, {RequestID: "a", TraceID: "t", Outcome: "succeeded", CompletedAt: now}} {
		if err := s.StoreLifecycle(event); err != nil {
			t.Fatal(err)
		}
	}
	start := now.Add(-time.Minute)
	r, err := s.GetLifecycle(model.UsageFilter{StartTime: &start, Trace: "t"})
	if err != nil || r.Total != 1 || r.Items[0].Outcome != "succeeded" {
		t.Fatalf("lifecycle=%+v err=%v", r, err)
	}
}

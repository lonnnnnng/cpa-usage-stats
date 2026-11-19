package handler

import (
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"cpa-usage-stats/internal/model"
	"cpa-usage-stats/internal/storage"
	"cpa-usage-stats/internal/timezone"
)

func TestOverviewProjectionPreservesFullSummary(t *testing.T) {
	s, err := storage.New(filepath.Join(t.TempDir(), "usage.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err := s.InsertBatch([]model.UsageRecord{{RequestID: "one", TraceID: "trace", SessionID: "session", RequestedAt: time.Now()}}); err != nil {
		t.Fatal(err)
	}
	for _, compact := range []bool{false, true} {
		query := map[string][]string{"range": {"all"}}
		if compact {
			query["view"] = []string{"overview"}
		}
		response := Handle(s, nil, model.ManagementRequest{Path: APIBasePath + "/summary", Query: query}, 90, model.RuntimeStats{DroppedRecords: 3})
		var body map[string]json.RawMessage
		if err := json.Unmarshal(response.Body, &body); err != nil || response.StatusCode != 200 {
			t.Fatalf("response=%+v err=%v", response, err)
		}
		if string(body["dropped_records"]) != "3" {
			t.Fatal("missing runtime counters")
		}
		_, hasTrace := body["trace_stats"]
		if hasTrace == compact {
			t.Fatalf("compact=%v trace=%v", compact, hasTrace)
		}
		for _, name := range []string{"model_stats", "provider_stats", "api_key_stats", "auth_stats", "session_stats", "trend", "p95_latency_ms"} {
			if _, ok := body[name]; !ok {
				t.Fatal("missing overview field " + name)
			}
		}
	}
}

func TestParseFilterUsesBeijingTodayAndYesterday(t *testing.T) {
	now := time.Date(2026, 10, 24, 16, 30, 0, 0, time.UTC) // 2026-10-25 00:30 Beijing

	today, hourly := parseFilterAt(map[string][]string{"range": {"today"}}, now)
	if !hourly || today.StartTime == nil || today.EndTime != nil {
		t.Fatalf("today filter = %+v, hourly=%v", today, hourly)
	}
	if got := timezone.FormatStorage(*today.StartTime); got != "2026-10-24 16:00:00.000" {
		t.Fatalf("today start = %s, want Beijing midnight converted to storage", got)
	}

	yesterday, hourly := parseFilterAt(map[string][]string{"range": {"yesterday"}}, now)
	if !hourly || yesterday.StartTime == nil || yesterday.EndTime == nil {
		t.Fatalf("yesterday filter = %+v, hourly=%v", yesterday, hourly)
	}
	if got := timezone.FormatStorage(*yesterday.StartTime); got != "2026-10-23 16:00:00.000" {
		t.Fatalf("yesterday start = %s", got)
	}
	if got := timezone.FormatStorage(*yesterday.EndTime); got != "2026-10-24 16:00:00.000" {
		t.Fatalf("yesterday end = %s", got)
	}
}

func TestParseCleanupRangeUsesSameBeijingBoundaries(t *testing.T) {
	now := time.Date(2026, 10, 24, 16, 30, 0, 0, time.UTC)
	start, end, err := parseCleanupRangeAt(map[string][]string{"range": {"7d"}}, now)
	if err != nil || start == nil || end == nil {
		t.Fatalf("cleanup range = %v, %v, %v", start, end, err)
	}
	if got := timezone.FormatStorage(*start); got != "2026-10-18 16:00:00.000" {
		t.Fatalf("7d start = %s", got)
	}
	if got := timezone.FormatStorage(*end); got != "2026-10-25 16:00:00.000" {
		t.Fatalf("7d end = %s", got)
	}
}

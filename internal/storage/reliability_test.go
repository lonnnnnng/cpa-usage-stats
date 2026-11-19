package storage

import (
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"cpa-usage-stats/internal/model"
	"cpa-usage-stats/internal/timezone"
)

func TestReplayDedupPreservesAttemptsAndHistoricalDuplicates(t *testing.T) {
	path := filepath.Join(t.TempDir(), "usage.db")
	s, err := New(path)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		_, err = s.db.Exec(`INSERT INTO usage_records(request_id,requested_at,total_tokens) VALUES ('historical','2026-11-19 00:00:00.000',10)`)
		if err != nil {
			t.Fatal(err)
		}
	}
	r := model.UsageRecord{RequestID: "attempt-1", TraceID: "same-trace", RequestedAt: time.Now(), Detail: model.UsageDetail{TotalTokens: 100}}
	for i := 0; i < 2; i++ {
		if err := s.InsertBatch([]model.UsageRecord{r, r}); err != nil {
			t.Fatal(err)
		}
	}
	r.RequestID = "attempt-2"
	if err := s.InsertBatch([]model.UsageRecord{r}); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"", "", " ", " ", "historical"} {
		r.RequestID = id
		if err := s.InsertBatch([]model.UsageRecord{r}); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = New(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	r.RequestID = "attempt-1"
	r.Detail.TotalTokens = 999
	if err := s.InsertBatch([]model.UsageRecord{r}); err != nil {
		t.Fatal(err)
	}
	summary, err := s.GetSummary(model.UsageFilter{}, false)
	if err != nil || summary.TotalRequests != 8 || summary.TotalTokens != 620 {
		t.Fatalf("summary=%+v err=%v", summary, err)
	}
	rows, err := s.db.Query(`EXPLAIN QUERY PLAN SELECT 1 FROM usage_records WHERE request_id = ?`, "attempt-1")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	indexed := false
	for rows.Next() {
		var a, b, c int
		var detail string
		if err := rows.Scan(&a, &b, &c, &detail); err != nil {
			t.Fatal(err)
		}
		indexed = indexed || strings.Contains(detail, "idx_usage_request_id")
	}
	if !indexed {
		t.Fatal("replay lookup does not use request-id index")
	}
}

func TestLifecycleViewFiltersAndMetadataProjection(t *testing.T) {
	s, err := New(filepath.Join(t.TempDir(), "usage.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	now := time.Date(2026, 11, 20, 0, 0, 0, 0, time.UTC)
	for i, outcome := range []string{"succeeded", "failed", "rejected", "canceled"} {
		e := model.RequestCompletion{RequestID: fmt.Sprintf("terminal-%d", i), TraceID: "shared", Model: "model-a", Outcome: outcome, StartedAt: now.Add(-time.Second), CompletedAt: now,
			Metadata: map[string]any{"synthetic-secret": "do-not-serialize"}, Error: strings.Repeat("x", 5000)}
		if err := s.StoreLifecycle(e); err != nil {
			t.Fatal(err)
		}
	}
	// 作者：long。同一Trace可有多个终态和不同用量尝试，独立分页不能复制或制造用量行。
	if err := s.InsertBatch([]model.UsageRecord{{RequestID: "attempt-a", TraceID: "shared"}, {RequestID: "attempt-b", TraceID: "shared"}}); err != nil {
		t.Fatal(err)
	}
	start, end := now, now.Add(time.Second)
	list, err := s.GetLifecycleView(model.UsageFilter{Trace: "shared", Model: "model-a", Outcome: "canceled", StartTime: &start, EndTime: &end})
	if err != nil || list.Total != 1 || list.Items[0].RequestID != "terminal-3" || list.Items[0].StatusCode != 0 || len(list.Items[0].Error) != 4096 {
		t.Fatalf("list=%+v err=%v", list, err)
	}
	list, err = s.GetLifecycleView(model.UsageFilter{RequestID: "terminal-2"})
	if err != nil || list.Total != 1 || list.Items[0].Outcome != "rejected" {
		t.Fatalf("exact=%+v err=%v", list, err)
	}
	list, err = s.GetLifecycleView(model.UsageFilter{Model: "absent"})
	if err != nil || list.Total != 0 || list.Items == nil {
		t.Fatalf("empty=%+v err=%v", list, err)
	}
	list, err = s.GetLifecycleView(model.UsageFilter{EndTime: &now})
	if err != nil || list.Total != 0 {
		t.Fatal("end boundary must be exclusive")
	}
	if err := s.StoreLifecycle(model.RequestCompletion{RequestID: "missing-time", Outcome: "canceled"}); err != nil {
		t.Fatal(err)
	}
	received := timezone.FormatStorage(now)
	if _, err := s.db.Exec(`UPDATE request_lifecycle SET received_at=? WHERE request_id='missing-time'`, received); err != nil {
		t.Fatal(err)
	}
	list, err = s.GetLifecycleView(model.UsageFilter{RequestID: "missing-time", StartTime: &start, EndTime: &end})
	if err != nil || list.Total != 1 || list.Items[0].StartedAt != nil || list.Items[0].CompletedAt != nil || !list.Items[0].ReceivedAt.Equal(now) {
		t.Fatalf("fallback=%+v err=%v", list, err)
	}
	if _, err := s.db.Exec(`UPDATE request_lifecycle SET received_at=?`, received); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		list, err = s.GetLifecycleView(model.UsageFilter{Page: i + 1, PageSize: 1})
		if err != nil || list.Items[0].RequestID != fmt.Sprintf("terminal-%d", 3-i) {
			t.Fatalf("stable order page%d=%+v", i, list)
		}
	}
	usage, err := s.GetRecords(model.UsageFilter{})
	if err != nil || usage.Total != 2 {
		t.Fatal("lifecycle changed usage count")
	}
}

func TestCleanupBothTablesIsAtomicAndUsesEventTime(t *testing.T) {
	s, err := New(filepath.Join(t.TempDir(), "usage.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	start := time.Now().UTC().Truncate(time.Second)
	end := start.Add(time.Hour)
	for i, at := range []time.Time{start.Add(-time.Second), start, end} {
		if err := s.InsertBatch([]model.UsageRecord{{RequestID: fmt.Sprint(i), RequestedAt: at}}); err != nil {
			t.Fatal(err)
		}
		if err := s.StoreLifecycle(model.RequestCompletion{RequestID: fmt.Sprint(i), Outcome: "canceled", CompletedAt: at}); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.StoreLifecycle(model.RequestCompletion{RequestID: "no-completion", Outcome: "rejected"}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`UPDATE request_lifecycle SET received_at=? WHERE request_id='no-completion'`, timezone.FormatStorage(start)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec(`CREATE TRIGGER block_cleanup BEFORE DELETE ON request_lifecycle BEGIN SELECT RAISE(ABORT,'synthetic failure'); END`); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.DeleteRangeWithCounts(&start, &end); err == nil {
		t.Fatal("expected rollback")
	}
	stats, err := s.Stats(90)
	if err != nil || stats.RecordCount != 3 || stats.LifecycleRecordCount != 4 {
		t.Fatal("cleanup was not atomic")
	}
	if _, err := s.db.Exec(`DROP TRIGGER block_cleanup`); err != nil {
		t.Fatal(err)
	}
	u, l, err := s.DeleteRangeWithCounts(&start, &end)
	if err != nil || u != 1 || l != 2 {
		t.Fatalf("counts=%d/%d err=%v", u, l, err)
	}
	u, l, err = s.DeleteRangeWithCounts(nil, nil)
	if err != nil || u != 2 || l != 2 {
		t.Fatalf("all=%d/%d err=%v", u, l, err)
	}
	stats, err = s.Stats(90)
	if err != nil || stats.RecordCount != 0 || stats.LifecycleRecordCount != 0 {
		t.Fatal("tables not empty")
	}
}

func TestRetentionIncludesEventsWithoutCompletionTime(t *testing.T) {
	s, err := New(filepath.Join(t.TempDir(), "usage.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	old := time.Now().Add(-100 * 24 * time.Hour)
	if err := s.InsertBatch([]model.UsageRecord{{RequestID: "old", RequestedAt: old}, {RequestID: "new"}}); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"old", "fallback", "new"} {
		e := model.RequestCompletion{RequestID: id, Outcome: "canceled"}
		if id == "old" {
			e.CompletedAt = old
		}
		if err := s.StoreLifecycle(e); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.db.Exec(`UPDATE request_lifecycle SET received_at=? WHERE request_id='fallback'`, timezone.FormatStorage(old)); err != nil {
		t.Fatal(err)
	}
	if n, err := s.CleanRetention(0); err != nil || n != 0 {
		t.Fatal("permanent retention changed records")
	}
	if n, err := s.CleanRetention(90); err != nil || n != 3 {
		t.Fatalf("retention=%d err=%v", n, err)
	}
	stats, err := s.Stats(90)
	if err != nil || stats.RecordCount != 1 || stats.LifecycleRecordCount != 1 {
		t.Fatalf("stats=%+v err=%v", stats, err)
	}
}

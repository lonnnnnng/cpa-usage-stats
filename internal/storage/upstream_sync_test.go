package storage

import (
	"database/sql"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"cpa-usage-stats/internal/model"
)

// 作者：long。旧库追加可空明细列后，重开两次仍保留原记录和总量，不能把缺失细分伪造成零。
func TestOptionalTokenMigrationPreservesOldRecords(t *testing.T) {
	path := filepath.Join(t.TempDir(), "usage.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE TABLE usage_records (id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL,
		requested_at DATETIME NOT NULL, total_tokens INTEGER NOT NULL DEFAULT 0);
		INSERT INTO usage_records (request_id, requested_at, total_tokens) VALUES ('old', '2026-11-19 01:00:00.000', 123);
		PRAGMA user_version = 1;`)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	for attempt := 0; attempt < 2; attempt++ {
		store, err := New(path)
		if err != nil {
			t.Fatal(err)
		}
		list, err := store.GetRecords(model.UsageFilter{})
		if err != nil || list.Total != 1 || list.Items[0].RequestID != "old" || list.Items[0].TotalTokens != 123 {
			t.Fatalf("migration records=%+v err=%v", list, err)
		}
		raw, _ := json.Marshal(list.Items[0])
		var record map[string]any
		_ = json.Unmarshal(raw, &record)
		for _, field := range []string{"cache_creation_5m_tokens", "cache_creation_1h_tokens", "text_input_tokens",
			"image_input_tokens", "audio_input_tokens", "video_input_tokens", "file_input_tokens", "cached_text_tokens",
			"cached_image_tokens", "cached_audio_tokens", "text_output_tokens", "image_output_tokens", "audio_output_tokens"} {
			if _, ok := record[field]; ok {
				t.Fatalf("old record acquired %s", field)
			}
		}
		summary, err := store.GetOverview(model.UsageFilter{}, false)
		if err != nil || summary.TotalRequests != 1 || summary.TotalTokens != 123 {
			t.Fatalf("summary=%+v err=%v", summary, err)
		}
		if err := store.Close(); err != nil {
			t.Fatal(err)
		}
	}
}

func TestGoogleErrorClassificationAndFailureSummary(t *testing.T) {
	store, err := New(filepath.Join(t.TempDir(), "usage.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	cases := []struct{ body, want string }{
		{`{"error":{"code":403,"status":"PERMISSION_DENIED","details":[{"reason":"OTHER"},{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"TOS_VIOLATION"}]}}`, "TOS_VIOLATION"},
		{`{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}`, "RESOURCE_EXHAUSTED"},
		{`{"error":{"type":"existing_type","details":[{"reason":"ignored"}]}}`, "existing_type"},
		{`{"error":{"details":[null,1,{"reason":""},{"reason":" FALLBACK "}]}}`, "FALLBACK"},
		{`{"status":"UNAVAILABLE"}`, "UNAVAILABLE"},
		{`{"error":{"details":[{"reason":42}]}}`, ""},
		{`{"error":{"status":42}}`, ""},
		{`{"error":`, ""},
		{`{"error":{"details":[{"reason":"` + strings.Repeat("x", 80) + `"}]}}`, strings.Repeat("x", maxErrorType)},
	}
	for i, c := range cases {
		if got := extractErrorType(c.body); got != c.want {
			t.Fatalf("case %d got=%q want=%q", i, got, c.want)
		}
	}
	if err := store.InsertBatch([]model.UsageRecord{{RequestID: "google", RequestedAt: time.Now(), Failed: true,
		Failure: model.UsageFailure{StatusCode: 403, Body: cases[0].body}}}); err != nil {
		t.Fatal(err)
	}
	summary, err := store.GetSummary(model.UsageFilter{}, false)
	if err != nil || len(summary.Failures) != 1 || summary.Failures[0].ErrorType != "TOS_VIOLATION" || summary.Failures[0].StatusCode != 403 {
		t.Fatalf("failure summary=%+v err=%v", summary, err)
	}
}

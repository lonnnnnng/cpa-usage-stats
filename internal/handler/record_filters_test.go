package handler

import (
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"cpa-usage-stats/internal/model"
	"cpa-usage-stats/internal/storage"
)

// 作者：long。从HTTP查询参数到真实SQLite结果逐项覆盖，不能仅验证参数被拼到URL上。
func TestRecordsEveryFilterAndCombinations(t *testing.T) {
	s, err := storage.New(filepath.Join(t.TempDir(), "usage.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	now := time.Now()
	base := model.UsageRecord{RequestID: "target", Model: "model_a", Provider: "provider", APIKey: "synthetic-client", AuthID: "credential", SessionID: "session", TraceID: "trace", SelectionID: "selection", Alias: "literal%_!", RequestedAt: now, Failed: true, Failure: model.UsageFailure{StatusCode: 0, Body: "network failed"}}
	rows := []model.UsageRecord{base}
	for i := 0; i < 8; i++ {
		r := base
		r.RequestID = string(rune('a' + i))
		switch i {
		case 0:
			r.Model = "other"
		case 1:
			r.Provider = "other"
		case 2:
			r.APIKey = "other"
		case 3:
			r.AuthID = "other"
		case 4:
			r.SessionID = "other"
		case 5:
			r.TraceID = "other"
		case 6:
			r.SelectionID = "other"
		case 7:
			r.Failed = false
		}
		rows = append(rows, r)
	}
	if err := s.InsertBatch(rows); err != nil {
		t.Fatal(err)
	}
	filters := map[string]string{"model": "model_a", "provider": "provider", "api_key": "synthetic-client", "auth_id": "credential", "session_id": "session", "trace_id": "trace", "selection_id": "selection", "failed": "true"}
	query := func(q map[string][]string) model.RecordListResponse {
		t.Helper()
		response := Handle(s, nil, model.ManagementRequest{Path: APIBasePath + "/records", Query: q}, 90, model.RuntimeStats{})
		var list model.RecordListResponse
		if response.StatusCode != 200 || json.Unmarshal(response.Body, &list) != nil {
			t.Fatalf("response=%s", response.Body)
		}
		return list
	}
	for key, value := range filters {
		list := query(map[string][]string{"range": {"all"}, key: {" " + value + " "}})
		if list.Total != 8 {
			t.Errorf("%s matched %d want 8", key, list.Total)
		}
	}
	combined := map[string][]string{"range": {"all"}}
	for key, value := range filters {
		combined[key] = []string{value}
	}
	list := query(combined)
	if list.Total != 1 || list.Items[0].RequestID != "target" {
		t.Fatalf("combined=%+v", list)
	}
	combined["keyword"] = []string{"not-present"}
	if query(combined).Total != 0 {
		t.Fatal("keyword OR escaped other AND filters")
	}
	for _, invalid := range []string{"bad", "TRUE", "2"} {
		response := Handle(s, nil, model.ManagementRequest{Path: APIBasePath + "/records", Query: map[string][]string{"failed": {invalid}}}, 90, model.RuntimeStats{})
		if response.StatusCode != 400 {
			t.Fatalf("invalid failed=%s accepted", invalid)
		}
	}
	if query(map[string][]string{"range": {"all"}, "failed": {"false"}}).Total != 1 {
		t.Fatal("success status filter incorrect")
	}
	options, err := s.GetOptions()
	if err != nil {
		t.Fatal(err)
	}
	if len(options.Models) != 2 || len(options.Providers) != 2 || len(options.APIKeys) != 2 || len(options.Auths) != 2 {
		t.Fatalf("options=%+v", options)
	}
}

func TestRecordsLiteralKeywordSearch(t *testing.T) {
	s, err := storage.New(filepath.Join(t.TempDir(), "usage.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	rows := []model.UsageRecord{
		{RequestID: "percent", Model: "model%name"}, {RequestID: "underscore", Model: "model_name"},
		{RequestID: "plain", Model: "modelXname"}, {RequestID: "escape", Alias: "bang!name"},
		{RequestID: "failure", Failed: true, Failure: model.UsageFailure{Body: "rate 10% exhausted"}},
	}
	if err := s.InsertBatch(rows); err != nil {
		t.Fatal(err)
	}
	for keyword, want := range map[string]int64{"%": 2, "_": 1, "!": 1, "model_name": 1, "' OR 1=1 --": 0, "exhausted": 1} {
		list, err := s.GetRecords(model.UsageFilter{Keyword: keyword})
		if err != nil || list.Total != want {
			t.Errorf("keyword %q total=%v err=%v", keyword, list, err)
		}
	}
}

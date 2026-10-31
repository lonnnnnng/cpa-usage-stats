package plugin

import (
	"encoding/json"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"cpa-usage-stats/internal/config"
	"cpa-usage-stats/internal/handler"
	"cpa-usage-stats/internal/model"
	"cpa-usage-stats/internal/storage"
)

// hostRegistration mirrors the fields CLIProxyAPI's validPlugin checks after
// both plugin.register and plugin.reconfigure.
type hostRegistration struct {
	SchemaVersion uint32 `json:"schema_version"`
	Metadata      struct {
		Name, Version, Author, GitHubRepository string
	} `json:"metadata"`
	Capabilities map[string]bool `json:"capabilities"`
}

// 作者：long。先持读锁再确认写者排队，稳定重现统计查询递归读锁被写者阻塞的交错。
func TestStatsWithPendingLifecycleWriter(t *testing.T) {
	for _, operation := range []string{"reconfigure", "quiesce"} {
		t.Run(operation, func(t *testing.T) {
			p := GetInstance()
			cfg := config.DefaultConfig()
			cfg.DBPath = filepath.Join(t.TempDir(), "usage.db")
			cfg.RetentionDays = 0
			if err := p.apply(cfg); err != nil {
				t.Fatal(err)
			}
			defer p.handleShutdown()
			p.mu.RLock()
			writerDone := make(chan error, 1)
			go func() {
				if operation == "reconfigure" {
					writerDone <- p.apply(cfg)
				} else {
					p.handleQuiesce()
					writerDone <- nil
				}
			}()
			deadline := time.Now().Add(5 * time.Second)
			for p.mu.TryRLock() {
				p.mu.RUnlock()
				if time.Now().After(deadline) {
					p.mu.RUnlock()
					<-writerDone
					t.Fatal("lifecycle writer did not reach the instance lock")
				}
				runtime.Gosched()
			}
			response := make(chan model.ManagementResponse, 1)
			go func() {
				response <- p.handleManagementLocked(model.ManagementRequest{Method: "GET", Path: handler.APIBasePath + "/stats"})
			}()
			select {
			case resp := <-response:
				if resp.StatusCode != 200 {
					t.Errorf("stats status = %d, body = %s", resp.StatusCode, resp.Body)
				}
				var stats model.RuntimeStats
				if err := json.Unmarshal(resp.Body, &stats); err != nil || stats.QueueCapacity != cfg.ChannelSize {
					t.Errorf("stats snapshot = %+v, error = %v", stats, err)
				}
			case <-time.After(time.Second):
				t.Error("stats blocked behind a writer while already holding the instance read lock")
				// 作者：long。失败时先撤销读锁以解开旧实现的循环等待，避免测试永久挂起。
				p.mu.RUnlock()
				<-response
				<-writerDone
				return
			}
			p.mu.RUnlock()
			if err := <-writerDone; err != nil {
				t.Fatal(err)
			}
		})
	}
}

// 作者：long。不同实例不能共用统计回调；数据库切换必须先落盘旧队列，再为新库启动独立 worker。
func TestStatsIsolationAndStorageLifecycle(t *testing.T) {
	p, other := &Instance{}, &Instance{}
	defer p.handleShutdown()
	defer other.handleShutdown()
	cfg := config.DefaultConfig()
	cfg.DBPath = filepath.Join(t.TempDir(), "first.db")
	cfg.ChannelSize, cfg.RetentionDays = 17, 0
	if err := p.apply(cfg); err != nil {
		t.Fatal(err)
	}
	otherCfg := cfg
	otherCfg.DBPath = filepath.Join(t.TempDir(), "other.db")
	otherCfg.ChannelSize = 29
	if err := other.apply(otherCfg); err != nil {
		t.Fatal(err)
	}
	statsFor := func(instance *Instance) model.RuntimeStats {
		t.Helper()
		payload, err := json.Marshal(model.ManagementRequest{Method: "GET", Path: handler.APIBasePath + "/stats"})
		if err != nil {
			t.Fatal(err)
		}
		raw, err := instance.HandleCall("management.handle", payload)
		if err != nil {
			t.Fatal(err)
		}
		var env model.Envelope
		if err := json.Unmarshal(raw, &env); err != nil || !env.OK {
			t.Fatalf("stats envelope = %s, error = %v", raw, err)
		}
		var response model.ManagementResponse
		if err := json.Unmarshal(env.Result, &response); err != nil || response.StatusCode != 200 {
			t.Fatalf("stats response = %s, error = %v", env.Result, err)
		}
		var stats model.RuntimeStats
		if err := json.Unmarshal(response.Body, &stats); err != nil {
			t.Fatal(err)
		}
		return stats
	}
	if statsFor(p).QueueCapacity != 17 || statsFor(other).QueueCapacity != 29 {
		t.Fatal("runtime counters leaked across plugin instances")
	}
	record, err := json.Marshal(model.UsageRecord{RequestID: "before-switch", Model: "test-model", RequestedAt: time.Now()})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.HandleCall("usage.handle", record); err != nil {
		t.Fatal(err)
	}
	newCfg := cfg
	newCfg.DBPath = filepath.Join(t.TempDir(), "second.db")
	newCfg.ChannelSize = 31
	if err := p.apply(newCfg); err != nil {
		t.Fatal(err)
	}
	oldStore, err := storage.New(cfg.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	defer oldStore.Close()
	oldRecords, err := oldStore.GetRecords(model.UsageFilter{})
	if err != nil || oldRecords.Total != 1 || oldRecords.Items[0].RequestID != "before-switch" {
		t.Fatalf("old database was not drained before replacement: %+v, error = %v", oldRecords, err)
	}
	newRecords, err := p.store.GetRecords(model.UsageFilter{})
	if err != nil || newRecords.Total != 0 || statsFor(p).QueueCapacity != 31 {
		t.Fatalf("new database/worker state = %+v, error = %v", newRecords, err)
	}
	p.handleQuiesce()
	if statsFor(p) != (model.RuntimeStats{}) || statsFor(other).QueueCapacity != 29 {
		t.Fatal("quiesced instance must report zero counters without affecting another instance")
	}
}

func call(t *testing.T, method string, req any) json.RawMessage {
	t.Helper()
	payload, _ := json.Marshal(req)
	raw, err := GetInstance().HandleCall(method, payload)
	if err != nil {
		t.Fatalf("%s: %v", method, err)
	}
	var env model.Envelope
	if err := json.Unmarshal(raw, &env); err != nil || !env.OK {
		t.Fatalf("%s: envelope %s", method, raw)
	}
	return env.Result
}

func manage(t *testing.T, path string, query map[string][]string) model.ManagementResponse {
	t.Helper()
	var resp model.ManagementResponse
	result := call(t, "management.handle", model.ManagementRequest{Method: "GET", Path: path, Query: query})
	if err := json.Unmarshal(result, &resp); err != nil {
		t.Fatalf("decode management response: %v", err)
	}
	return resp
}

func TestPluginLifecycle(t *testing.T) {
	GetInstance().SetEmbeddedHTML([]byte("<!doctype html><title>dashboard</title>"))
	cfgYAML := []byte("db_path: " + filepath.Join(t.TempDir(), "usage.db") + "\nbatch_size: 1\nflush_interval_ms: 50\n")

	// Startup calls register once, then reconfigure on every later config
	// apply. An empty reconfigure reply made the host unregister the plugin.
	for _, tc := range []struct {
		method     string
		hostSchema uint32
		wantSchema uint32
	}{
		{"plugin.register", 6, 6},
		{"plugin.reconfigure", 6, 6},
		// The plugin speaks v8 only: it claims its schema regardless of what
		// an older host advertises, so pre-v8 hosts drop it instead of
		// silently mis-decoding management responses.
		{"plugin.reconfigure", 1, 6},
	} {
		var reg hostRegistration
		result := call(t, tc.method, map[string]any{"config_yaml": cfgYAML, "schema_version": tc.hostSchema})
		if err := json.Unmarshal(result, &reg); err != nil {
			t.Fatalf("%s: decode: %v", tc.method, err)
		}
		m := reg.Metadata
		if m.Name == "" || m.Version == "" || m.Author == "" || m.GitHubRepository == "" || !reg.Capabilities["usage_plugin"] {
			t.Fatalf("%s: host would reject registration %+v", tc.method, reg)
		}
		if reg.SchemaVersion != tc.wantSchema {
			t.Errorf("%s with host schema %d: got schema %d, want %d", tc.method, tc.hostSchema, reg.SchemaVersion, tc.wantSchema)
		}
	}

	completedAt := time.Now()
	call(t, "request.complete", model.RequestCompletion{RequestID: "req-1", TraceID: "trace-1", Model: "gpt-5", RequestedModel: "gpt-5", Outcome: "succeeded", StatusCode: 200, StartedAt: completedAt.Add(-time.Second), CompletedAt: completedAt})
	call(t, "usage.handle", model.UsageRecord{RequestID: "req-1", TraceID: "trace-1", SelectionID: "selection-1", Model: "gpt-5", SessionID: "sess-1", ResponseModel: "gpt-5.2", RequestedAt: completedAt, Detail: model.UsageDetail{TotalTokens: 100, CacheReadTokens: 30}})
	time.Sleep(200 * time.Millisecond)

	resp := manage(t, handler.APIBasePath+"/summary", map[string][]string{"range": {"today"}})
	var summary model.SummaryResponse
	if err := json.Unmarshal(resp.Body, &summary); err != nil || resp.StatusCode != 200 {
		t.Fatalf("summary: status %d body %s", resp.StatusCode, resp.Body)
	}
	if summary.TotalRequests != 1 || summary.TotalTokens != 100 || summary.Bucket != "hour" {
		t.Errorf("summary = %+v", summary)
	}
	if summary.SuccessRequests != 1 || summary.SuccessRate != 100 {
		t.Errorf("success accounting = %+v", summary)
	}
	if len(summary.Models) != 1 || summary.Models[0].Secondary != "" {
		t.Errorf("model stats = %+v", summary.Models)
	}
	if summary.UniqueTraces != 1 || summary.UniqueSessions != 1 || summary.Lifecycle.Succeeded != 1 || len(summary.Selections) != 1 || summary.Selections[0].Name != "selection-1" {
		t.Errorf("correlation summary = %+v", summary)
	}

	resp = manage(t, handler.APIBasePath+"/records", nil)
	var records model.RecordListResponse
	if err := json.Unmarshal(resp.Body, &records); err != nil || resp.StatusCode != 200 {
		t.Fatalf("records: status %d body %s", resp.StatusCode, resp.Body)
	}
	if records.Total != 1 || records.Items[0].SessionID != "sess-1" || records.Items[0].SelectionID != "selection-1" || records.Items[0].ResponseModel != "gpt-5.2" {
		t.Errorf("records = %+v", records)
	}

	resp = manage(t, handler.APIBasePath+"/lifecycle", nil)
	var lifecycle model.LifecycleListResponse
	if err := json.Unmarshal(resp.Body, &lifecycle); err != nil || resp.StatusCode != 200 || lifecycle.Total != 1 || lifecycle.Items[0].Outcome != "succeeded" {
		t.Errorf("lifecycle = status %d body %s decoded %+v", resp.StatusCode, resp.Body, lifecycle)
	}

	resp = manage(t, handler.APIBasePath+"/options", nil)
	var options model.OptionsResponse
	if err := json.Unmarshal(resp.Body, &options); err != nil || resp.StatusCode != 200 {
		t.Fatalf("options: status %d body %s", resp.StatusCode, resp.Body)
	}
	if len(options.Models) != 1 || options.Models[0] != "gpt-5" {
		t.Errorf("options = %+v", options)
	}

	// Quiesce drains and stops the worker: later records are dropped, but the
	// management API and storage stay alive until shutdown.
	call(t, "plugin.quiesce", nil)
	call(t, "usage.handle", model.UsageRecord{RequestID: "req-2", Model: "gpt-5", RequestedAt: time.Now()})
	time.Sleep(120 * time.Millisecond)
	resp = manage(t, handler.APIBasePath+"/records", nil)
	if err := json.Unmarshal(resp.Body, &records); err != nil {
		t.Fatalf("records after quiesce: %v", resp.Body)
	}
	if records.Total != 1 {
		t.Errorf("quiesced plugin must drop new records, got total %d", records.Total)
	}

	// The resource route is unauthenticated: it must never answer with data.
	resp = manage(t, "/v0/resource/plugins/cpa-usage-stats/dashboard", map[string][]string{"action": {"records"}})
	if !strings.HasPrefix(resp.Headers.Get("Content-Type"), "text/html") || strings.Contains(string(resp.Body), "req-1") {
		t.Errorf("resource route leaked data: %s %s", resp.Headers.Get("Content-Type"), resp.Body)
	}

	call(t, "plugin.shutdown", nil)
}

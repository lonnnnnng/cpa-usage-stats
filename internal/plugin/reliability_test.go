package plugin

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"cpa-usage-stats/internal/config"
	"cpa-usage-stats/internal/model"
	"cpa-usage-stats/internal/storage"
)

func TestUsageReportsFullQueueAndUnavailableWorker(t *testing.T) {
	p := &Instance{}
	defer p.handleShutdown()
	cfg := config.DefaultConfig()
	cfg.DBPath = filepath.Join(t.TempDir(), "usage.db")
	cfg.RetentionDays = 0
	cfg.BatchSize = 1
	cfg.ChannelSize = 1
	if err := p.apply(cfg); err != nil {
		t.Fatal(err)
	}
	// 作者：long。用独立写事务阻塞落盘，让队列必然饱和，不依赖定时sleep抢执行顺序。
	db, err := sql.Open("sqlite", cfg.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec("BEGIN IMMEDIATE"); err != nil {
		t.Fatal(err)
	}
	defer db.Exec("ROLLBACK")
	full := false
	for i := 0; i < 10; i++ {
		raw, err := p.HandleCall("usage.handle", []byte(fmt.Sprintf(`{"RequestID":"%d"}`, i)))
		var env model.Envelope
		if err != nil || json.Unmarshal(raw, &env) != nil {
			t.Fatal(err)
		}
		if !env.OK {
			if env.Error == nil || env.Error.Code != "usage_queue_full" {
				t.Fatalf("unexpected %s", raw)
			}
			full = true
			break
		}
	}
	if !full {
		t.Fatal("full queue acknowledged as success")
	}
	if _, err := db.Exec("ROLLBACK"); err != nil {
		t.Fatal(err)
	}
	p.handleQuiesce()
	raw, err := p.HandleCall("usage.handle", []byte(`{"RequestID":"after-stop"}`))
	var env model.Envelope
	if err != nil || json.Unmarshal(raw, &env) != nil || env.OK || env.Error.Code != "usage_unavailable" {
		t.Fatalf("unavailable=%s", raw)
	}
}

func TestLifecycleWritesSurviveConcurrentDatabaseSwitches(t *testing.T) {
	p := &Instance{}
	cfg := config.DefaultConfig()
	cfg.RetentionDays = 0
	dir := t.TempDir()
	cfg.DBPath = filepath.Join(dir, "a.db")
	if err := p.apply(cfg); err != nil {
		t.Fatal(err)
	}
	defer p.handleShutdown()
	start := make(chan struct{})
	errors := make(chan string, 120)
	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			raw, err := p.HandleCall("request.complete", []byte(fmt.Sprintf(`{"RequestID":"terminal-%d","Outcome":"canceled"}`, i)))
			var env model.Envelope
			if err != nil || json.Unmarshal(raw, &env) != nil || !env.OK {
				errors <- fmt.Sprintf("%s %v", raw, err)
			}
		}(i)
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		<-start
		for i := 0; i < 20; i++ {
			next := cfg
			if i%2 == 0 {
				next.DBPath = filepath.Join(dir, "b.db")
			}
			if err := p.apply(next); err != nil {
				errors <- err.Error()
			}
		}
	}()
	close(start)
	wg.Wait()
	close(errors)
	for err := range errors {
		t.Error(err)
	}
	p.handleShutdown()
	var count int64
	for _, name := range []string{"a.db", "b.db"} {
		s, err := storage.New(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		events, err := s.GetLifecycle(model.UsageFilter{})
		if err != nil {
			t.Fatal(err)
		}
		count += events.Total
		s.Close()
	}
	if count != 100 {
		t.Fatalf("accepted completion events lost: %d", count)
	}
}

func TestLifecycleViewDoesNotExposeMetadata(t *testing.T) {
	p := &Instance{}
	cfg := config.DefaultConfig()
	cfg.DBPath = filepath.Join(t.TempDir(), "usage.db")
	cfg.RetentionDays = 0
	if err := p.apply(cfg); err != nil {
		t.Fatal(err)
	}
	defer p.handleShutdown()
	if _, err := p.HandleCall("request.complete", []byte(`{"RequestID":"life-id","TraceID":"trace-id","Outcome":"rejected","Metadata":{"synthetic_secret":"private-value"}}`)); err != nil {
		t.Fatal(err)
	}
	raw, err := p.HandleCall("management.handle", []byte(`{"Method":"GET","Path":"/v0/management/plugins/cpa-usage-stats/lifecycle","Query":{"range":["all"],"view":["events"],"outcome":["rejected"]}}`))
	var env model.Envelope
	var response model.ManagementResponse
	if err != nil || json.Unmarshal(raw, &env) != nil || json.Unmarshal(env.Result, &response) != nil || response.StatusCode != 200 {
		t.Fatalf("response=%s", raw)
	}
	if strings.Contains(string(response.Body), "private-value") || strings.Contains(string(response.Body), "Metadata") || !strings.Contains(string(response.Body), `"request_id":"life-id"`) {
		t.Fatalf("projection=%s", response.Body)
	}
}

package plugin

import (
	"encoding/json"
	"path/filepath"
	"testing"

	"cpa-usage-stats/internal/config"
	"cpa-usage-stats/internal/handler"
	"cpa-usage-stats/internal/model"
)

// 作者：long。从宿主原始JSON贯穿异步队列、SQLite及管理API，防止可选字段只声明却未真正落盘。
func TestOptionalTokenDetailsThroughPlugin(t *testing.T) {
	p := &Instance{}
	cfg := config.DefaultConfig()
	cfg.DBPath = filepath.Join(t.TempDir(), "usage.db")
	cfg.RetentionDays = 0
	if err := p.apply(cfg); err != nil {
		t.Fatal(err)
	}
	defer p.handleShutdown()
	fields := []struct{ input, output string }{
		{"CacheCreation5mTokens", "cache_creation_5m_tokens"}, {"CacheCreation1hTokens", "cache_creation_1h_tokens"},
		{"TextInputTokens", "text_input_tokens"}, {"ImageInputTokens", "image_input_tokens"},
		{"AudioInputTokens", "audio_input_tokens"}, {"VideoInputTokens", "video_input_tokens"},
		{"FileInputTokens", "file_input_tokens"}, {"CachedTextTokens", "cached_text_tokens"},
		{"CachedImageTokens", "cached_image_tokens"}, {"CachedAudioTokens", "cached_audio_tokens"},
		{"TextOutputTokens", "text_output_tokens"}, {"ImageOutputTokens", "image_output_tokens"},
		{"AudioOutputTokens", "audio_output_tokens"},
	}
	for _, variant := range []string{"values", "zeros", "missing"} {
		detail := map[string]any{"InputTokens": 100, "OutputTokens": 20, "TotalTokens": 120}
		for i, field := range fields {
			if variant == "values" {
				detail[field.input] = i + 1
			} else if variant == "zeros" {
				detail[field.input] = 0
			} else if i%2 == 0 {
				detail[field.input] = nil
			}
		}
		payload, _ := json.Marshal(map[string]any{"RequestID": variant, "Detail": detail})
		raw, err := p.HandleCall("usage.handle", payload)
		var env model.Envelope
		if err != nil || json.Unmarshal(raw, &env) != nil || !env.OK {
			t.Fatalf("usage failed: %s %v", raw, err)
		}
	}
	p.handleQuiesce()
	response := p.handleManagementLocked(model.ManagementRequest{Method: "GET", Path: handler.APIBasePath + "/records"})
	var list struct {
		Items []map[string]any `json:"items"`
	}
	if response.StatusCode != 200 || json.Unmarshal(response.Body, &list) != nil || len(list.Items) != 3 {
		t.Fatalf("records: %s", response.Body)
	}
	for _, record := range list.Items {
		for i, field := range fields {
			value, present := record[field.output]
			switch record["request_id"] {
			case "values":
				if !present || value != float64(i+1) {
					t.Fatalf("%s = %v", field.output, value)
				}
			case "zeros":
				if !present || value != float64(0) {
					t.Fatalf("zero %s = %v", field.output, value)
				}
			case "missing":
				if present {
					t.Fatalf("missing %s was serialized", field.output)
				}
			}
		}
	}
	for _, overview := range []bool{false, true} {
		query := map[string][]string{"range": {"all"}}
		if overview {
			query["view"] = []string{"overview"}
		}
		response = p.handleManagementLocked(model.ManagementRequest{Method: "GET", Path: handler.APIBasePath + "/summary", Query: query})
		var summary model.SummaryResponse
		if json.Unmarshal(response.Body, &summary) != nil || summary.TotalRequests != 3 || summary.TotalTokens != 360 {
			t.Fatalf("optional breakdown changed totals: %s", response.Body)
		}
	}
}

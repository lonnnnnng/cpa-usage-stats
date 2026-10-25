package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"cpa-usage-stats/internal/model"
	"cpa-usage-stats/internal/storage"
	"cpa-usage-stats/internal/timezone"
)

// APIBasePath is where the host mounts this plugin's authenticated routes.
const APIBasePath = "/v0/management/plugins/cpa-usage-stats"

// Handle serves plugin HTTP requests. Data is only returned on the
// management routes, which the host protects with the management key; the
// unauthenticated resource route only ever gets the dashboard HTML.
func Handle(store *storage.Storage, html []byte, req model.ManagementRequest, retentionDays int, stats model.RuntimeStats) model.ManagementResponse {
	if !strings.HasPrefix(req.Path, APIBasePath+"/") {
		return htmlResponse(html)
	}
	if store == nil {
		return jsonError(http.StatusServiceUnavailable, "storage_unavailable", "usage storage is not initialized")
	}

	filter, hourly := parseFilter(req.Query)
	switch strings.TrimPrefix(req.Path, APIBasePath) {
	case "/summary":
		summary, err := store.GetSummary(filter, hourly)
		if err != nil {
			return jsonError(http.StatusInternalServerError, "query_summary_failed", err.Error())
		}
		return jsonOK(summary)
	case "/records":
		records, err := store.GetRecords(filter)
		if err != nil {
			return jsonError(http.StatusInternalServerError, "query_records_failed", err.Error())
		}
		return jsonOK(records)
	case "/options":
		options, err := store.GetOptions()
		if err != nil {
			return jsonError(http.StatusInternalServerError, "query_options_failed", err.Error())
		}
		return jsonOK(options)
	case "/stats":
		// 作者：long。使用所属实例传入的统计快照，不在持锁查询中回调实例再次加锁。
		return jsonOK(stats)
	case "/storage":
		stats, err := store.Stats(retentionDays)
		if err != nil {
			return jsonError(http.StatusInternalServerError, "query_storage_failed", err.Error())
		}
		return jsonOK(stats)
	case "/storage/reclaim":
		if req.Method != http.MethodPost {
			return jsonError(http.StatusMethodNotAllowed, "method_not_allowed", "use POST")
		}
		if err := store.Vacuum(); err != nil {
			return jsonError(http.StatusInternalServerError, "reclaim_failed", err.Error())
		}
		stats, err := store.Stats(retentionDays)
		if err != nil {
			return jsonError(http.StatusInternalServerError, "query_storage_failed", err.Error())
		}
		return jsonOK(stats)
	case "/storage/clear":
		if req.Method != http.MethodPost {
			return jsonError(http.StatusMethodNotAllowed, "method_not_allowed", "use POST")
		}
		start, end, err := parseCleanupRange(req.Query)
		if err != nil {
			return jsonError(http.StatusBadRequest, "invalid_cleanup_range", err.Error())
		}
		deleted, err := store.DeleteRange(start, end)
		if err != nil {
			return jsonError(http.StatusInternalServerError, "clear_failed", err.Error())
		}
		if err := store.Vacuum(); err != nil {
			return jsonError(http.StatusInternalServerError, "clear_reclaim_failed", err.Error())
		}
		stats, err := store.Stats(retentionDays)
		if err != nil {
			return jsonError(http.StatusInternalServerError, "query_storage_failed", err.Error())
		}
		return jsonOK(model.StorageCleanupResponse{DeletedRecords: deleted, Stats: stats})
	default:
		return jsonError(http.StatusNotFound, "not_found", "unknown endpoint")
	}
}

// parseCleanupRange uses the dashboard's Beijing calendar. An omitted range is
// rejected to avoid an accidental full-database delete from a malformed
// management request. 作者：long
func parseCleanupRange(q map[string][]string) (*time.Time, *time.Time, error) {
	return parseCleanupRangeAt(q, time.Now())
}

func parseCleanupRangeAt(q map[string][]string, now time.Time) (*time.Time, *time.Time, error) {
	rangeValue := ""
	if values := q["range"]; len(values) > 0 {
		rangeValue = strings.TrimSpace(values[0])
	}
	today, tomorrow := timezone.DayBounds(now)
	switch rangeValue {
	case "today":
		return &today, &tomorrow, nil
	case "7d":
		return timePtr(today.AddDate(0, 0, -6)), &tomorrow, nil
	case "30d":
		return timePtr(today.AddDate(0, 0, -29)), &tomorrow, nil
	case "all":
		return nil, nil, nil
	default:
		return nil, nil, fmt.Errorf("range must be today, 7d, 30d, or all")
	}
}

func timePtr(value time.Time) *time.Time { return &value }

func htmlResponse(body []byte) model.ManagementResponse {
	headers := http.Header{}
	headers.Set("Content-Type", "text/html; charset=utf-8")
	headers.Set("Cache-Control", "no-cache")
	return model.ManagementResponse{StatusCode: http.StatusOK, Headers: headers, Body: body}
}

// parseFilter maps query params to a filter. range is one of today,
// yesterday, 7d, 30d or all (default); today/yesterday get hourly trends.
func parseFilter(q map[string][]string) (model.UsageFilter, bool) {
	return parseFilterAt(q, time.Now())
}

func parseFilterAt(q map[string][]string, now time.Time) (model.UsageFilter, bool) {
	get := func(key string) string {
		if v := q[key]; len(v) > 0 {
			return strings.TrimSpace(v[0])
		}
		return ""
	}

	filter := model.UsageFilter{
		Model:    get("model"),
		Provider: get("provider"),
		APIKey:   get("api_key"),
		AuthID:   get("auth_id"),
		Session:  get("session_id"),
		Keyword:  get("keyword"),
	}
	filter.Page, _ = strconv.Atoi(get("page"))
	filter.PageSize, _ = strconv.Atoi(get("page_size"))
	if failed := get("failed"); failed != "" {
		f := failed == "true" || failed == "1"
		filter.Failed = &f
	}

	today, _ := timezone.DayBounds(now)
	daysBack := func(n int) *time.Time {
		t := today.AddDate(0, 0, -n)
		return &t
	}
	hourly := false
	switch get("range") {
	case "today":
		filter.StartTime, hourly = &today, true
	case "yesterday":
		filter.StartTime, filter.EndTime, hourly = daysBack(1), &today, true
	case "7d":
		filter.StartTime = daysBack(6)
	case "30d":
		filter.StartTime = daysBack(29)
	}
	return filter, hourly
}

func jsonOK(data any) model.ManagementResponse {
	body, err := json.Marshal(data)
	if err != nil {
		return jsonError(http.StatusInternalServerError, "marshal_error", err.Error())
	}
	return jsonResponse(http.StatusOK, body)
}

func jsonError(statusCode int, code, message string) model.ManagementResponse {
	body, _ := json.Marshal(map[string]string{"code": code, "message": message})
	return jsonResponse(statusCode, body)
}

func jsonResponse(statusCode int, body []byte) model.ManagementResponse {
	headers := http.Header{}
	headers.Set("Content-Type", "application/json; charset=utf-8")
	return model.ManagementResponse{StatusCode: statusCode, Headers: headers, Body: body}
}

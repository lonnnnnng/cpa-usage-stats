package storage

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"

	"cpa-usage-stats/internal/model"
	"cpa-usage-stats/internal/timezone"
)

const (
	timeLayout = timezone.TimeLayout
	// schemaVersion is the table layout this build writes. Adding a column or
	// an index does NOT require a bump: ensureSchema applies those additively on
	// every open. Bump it only for a change ALTER TABLE cannot express (column
	// type or meaning, dropping a column). A database reporting a higher version
	// than this constant was written by a newer plugin and is refused rather
	// than silently rebuilt.
	schemaVersion = 1
	// Upstream error pages can be large HTML documents; keep enough to debug.
	maxFailureBody = 4 << 10
	// Response headers for failed requests; filtered and capped to avoid database bloat.
	maxFailureHeaders = 2 << 10
	// Lifecycle metadata is an extension bag supplied by the host; cap it so a
	// malformed callback cannot grow the database without bound.
	maxLifecycleMetadata = 8 << 10
	// Extracted error type strings are short identifiers (rate_limit_error).
	maxErrorType = 64
)

// These expressions normalize the two cache counter layouts emitted by CPA:
// OpenAI-compatible records include cache reads inside input_tokens, whereas
// Anthropic records keep uncached input, cache reads, and cache writes apart.
// 作者：long
const (
	effectiveCacheReadSQL = "CASE WHEN cache_read_tokens > 0 THEN cache_read_tokens ELSE cached_tokens END"
	anthropicCacheSQL     = "(INSTR(LOWER(COALESCE(provider, '')), 'anthropic') > 0 OR INSTR(LOWER(COALESCE(provider, '')), 'claude') > 0 OR INSTR(LOWER(COALESCE(executor_type, '')), 'anthropic') > 0 OR INSTR(LOWER(COALESCE(executor_type, '')), 'claude') > 0 OR INSTR(LOWER(COALESCE(source, '')), 'anthropic') > 0 OR INSTR(LOWER(COALESCE(source, '')), 'claude') > 0)"
	cachePromptSQL        = "CASE WHEN " + anthropicCacheSQL + " THEN input_tokens + (" + effectiveCacheReadSQL + ") + cache_creation_tokens WHEN input_tokens > 0 THEN input_tokens ELSE (" + effectiveCacheReadSQL + ") + cache_creation_tokens END"
)

// errorTypeKeys are the JSON paths upstream APIs use for a machine-readable
// error identifier, in priority order.
var errorTypeKeys = []string{"$.error.type", "$.error.code", "$.type", "$.code"}

// 作者：long。Google没有字符串错误码时才以状态文本兜底，保留原有错误类型优先级。
var errorStatusKeys = []string{"$.error.status", "$.status"}

// extractErrorType pulls a short machine-readable error identifier out of an
// upstream failure body. Upstream error shapes vary (OpenAI/Anthropic nest it
// under "error", Google RPC uses numeric error.code + error.status + details[],
// Azure keeps it flat), so several paths are probed.
// It returns "" when the body is not a JSON object or carries no identifier.
func extractErrorType(body string) string {
	trimmed := strings.TrimSpace(body)
	if !strings.HasPrefix(trimmed, "{") {
		return ""
	}
	var parsed map[string]any
	if err := json.Unmarshal([]byte(trimmed), &parsed); err != nil {
		return ""
	}
	for _, path := range errorTypeKeys {
		value, ok := resolveString(parsed, strings.Split(strings.TrimPrefix(path, "$."), "."))
		if !ok || value == "" {
			continue
		}
		return value[:min(len(value), maxErrorType)]
	}
	if reason := extractGoogleErrorReason(parsed); reason != "" {
		return reason[:min(len(reason), maxErrorType)]
	}
	for _, path := range errorStatusKeys {
		value, ok := resolveString(parsed, strings.Split(strings.TrimPrefix(path, "$."), "."))
		if !ok || value == "" {
			continue
		}
		return value[:min(len(value), maxErrorType)]
	}
	return ""
}

// 作者：long。优先提取Google ErrorInfo的具体原因，让封禁、权限和配额失败可按原因分组。
func extractGoogleErrorReason(parsed map[string]any) string {
	errObj, ok := parsed["error"].(map[string]any)
	if !ok {
		return ""
	}
	details, ok := errObj["details"].([]any)
	if !ok {
		return ""
	}
	fallback := ""
	for _, item := range details {
		detail, ok := item.(map[string]any)
		if !ok {
			continue
		}
		reason, _ := detail["reason"].(string)
		reason = strings.TrimSpace(reason)
		if reason == "" {
			continue
		}
		if typ, _ := detail["@type"].(string); strings.HasSuffix(typ, "google.rpc.ErrorInfo") {
			return reason
		}
		if fallback == "" {
			fallback = reason
		}
	}
	return fallback
}

// resolveString walks a parsed JSON object along path segments.
func resolveString(current any, segments []string) (string, bool) {
	for _, segment := range segments {
		object, ok := current.(map[string]any)
		if !ok {
			return "", false
		}
		current, ok = object[segment]
		if !ok {
			return "", false
		}
	}
	value, ok := current.(string)
	return strings.TrimSpace(value), ok
}

func serializeFailureHeaders(failed bool, headers http.Header) string {
	if !failed || len(headers) == 0 {
		return ""
	}
	filtered := make(map[string][]string)
	for k, vals := range headers {
		lower := strings.ToLower(k)
		if lower == "authorization" || lower == "proxy-authorization" || lower == "cookie" || lower == "set-cookie" {
			continue
		}
		cleanVals := make([]string, 0, len(vals))
		for _, v := range vals {
			if len(v) > 256 {
				v = v[:256] + "..."
			}
			cleanVals = append(cleanVals, v)
		}
		filtered[k] = cleanVals
	}
	if len(filtered) == 0 {
		return ""
	}
	b, err := json.Marshal(filtered)
	if err != nil || len(b) > maxFailureHeaders {
		return ""
	}
	return string(b)
}

// Storage handles SQLite persistent storage.
type Storage struct {
	db     *sql.DB
	dbPath string
	mu     sync.RWMutex
}

// New creates and initializes a SQLite storage instance.
func New(dbPath string) (*Storage, error) {
	// WAL + NORMAL sync for write throughput. SQLite rows are legacy UTC wall
	// text; parsing them as UTC keeps results independent of the server locale.
	dsn := fmt.Sprintf("%s?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=synchronous(NORMAL)&_timezone=UTC", dbPath)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite db: %w", err)
	}

	// Connection pool tuning for embedded SQLite
	db.SetMaxOpenConns(1) // Single writer safe for WAL
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(0)

	s := &Storage{db: db, dbPath: dbPath}
	if err := s.ensureSchema(); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("init sqlite schema: %w", err)
	}

	return s, nil
}

// Close closes the underlying database.
func (s *Storage) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.db != nil {
		return s.db.Close()
	}
	return nil
}

// tableColumns is the full usage_records layout in creation order, and the
// single source of truth for it. ensureSchema creates the table from this list
// and appends any column a pre-existing table lacks, so adding a field is a
// one-line change here. A column added later must be nullable or carry a
// DEFAULT: SQLite refuses ALTER TABLE ADD COLUMN for NOT NULL without default.
var tableColumns = []struct{ name, ddl string }{
	{"id", "INTEGER PRIMARY KEY AUTOINCREMENT"},
	{"request_id", "TEXT NOT NULL"},
	{"trace_id", "TEXT"},
	{"selection_id", "TEXT"},
	{"session_id", "TEXT"},
	{"parent_session_id", "TEXT"},
	{"provider", "TEXT"},
	{"base_url", "TEXT"},
	{"executor_type", "TEXT"},
	{"model", "TEXT"},
	{"response_model", "TEXT"},
	{"alias", "TEXT"},
	{"api_key", "TEXT"},
	{"is_native_key", "INTEGER NOT NULL DEFAULT 0"},
	{"access_provider", "TEXT"},
	{"auth_id", "TEXT"},
	{"auth_index", "TEXT"},
	{"auth_type", "TEXT"},
	{"source", "TEXT"},
	{"reasoning_effort", "TEXT"},
	{"service_tier", "TEXT"},
	{"effective_service_tier", "TEXT"},
	{"response_service_tier", "TEXT"},
	{"stream", "INTEGER NOT NULL DEFAULT 0"},
	{"generate", "INTEGER NOT NULL DEFAULT 1"},
	{"requested_at", "DATETIME NOT NULL"},
	{"latency_ms", "INTEGER NOT NULL DEFAULT 0"},
	{"ttft_ms", "INTEGER NOT NULL DEFAULT 0"},
	{"failed", "INTEGER NOT NULL DEFAULT 0"},
	{"status_code", "INTEGER NOT NULL DEFAULT 0"},
	{"error_type", "TEXT"},
	{"failure_body", "TEXT"},
	{"response_headers", "TEXT"},
	{"input_tokens", "INTEGER NOT NULL DEFAULT 0"},
	{"output_tokens", "INTEGER NOT NULL DEFAULT 0"},
	{"reasoning_tokens", "INTEGER NOT NULL DEFAULT 0"},
	{"cached_tokens", "INTEGER NOT NULL DEFAULT 0"},
	{"cache_read_tokens", "INTEGER NOT NULL DEFAULT 0"},
	{"cache_creation_tokens", "INTEGER NOT NULL DEFAULT 0"},
	{"total_tokens", "INTEGER NOT NULL DEFAULT 0"},
	// 作者：long。只追加可空列，历史记录不补零，升级及回退都保留原有统计。
	{"cache_creation_5m_tokens", "INTEGER"},
	{"cache_creation_1h_tokens", "INTEGER"},
	{"text_input_tokens", "INTEGER"},
	{"image_input_tokens", "INTEGER"},
	{"audio_input_tokens", "INTEGER"},
	{"video_input_tokens", "INTEGER"},
	{"file_input_tokens", "INTEGER"},
	{"cached_text_tokens", "INTEGER"},
	{"cached_image_tokens", "INTEGER"},
	{"cached_audio_tokens", "INTEGER"},
	{"text_output_tokens", "INTEGER"},
	{"image_output_tokens", "INTEGER"},
	{"audio_output_tokens", "INTEGER"},
}

// tableIndexes are applied on every open. requested_at leads every range query;
// the composites cover the common "recent failures" and "group by model within
// a range" access patterns.
var tableIndexes = []string{
	// 作者：long。保留历史重复行，非唯一索引用于阻止后续重放重复计费，不会因旧数据重复而升级失败。
	`CREATE INDEX IF NOT EXISTS idx_usage_request_id ON usage_records(request_id)`,
	`CREATE INDEX IF NOT EXISTS idx_usage_requested_at ON usage_records(requested_at DESC)`,
	`CREATE INDEX IF NOT EXISTS idx_usage_model ON usage_records(model, requested_at)`,
	`CREATE INDEX IF NOT EXISTS idx_usage_provider ON usage_records(provider, requested_at)`,
	`CREATE INDEX IF NOT EXISTS idx_usage_api_key ON usage_records(api_key, requested_at)`,
	`CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_records(session_id)`,
	`CREATE INDEX IF NOT EXISTS idx_usage_trace ON usage_records(trace_id, requested_at)`,
	`CREATE INDEX IF NOT EXISTS idx_usage_selection ON usage_records(selection_id, requested_at)`,
	`CREATE INDEX IF NOT EXISTS idx_usage_auth ON usage_records(auth_id, auth_index)`,
	`CREATE INDEX IF NOT EXISTS idx_usage_failed ON usage_records(failed, status_code) WHERE failed = 1`,
}

// ensureSchema brings the database up to the layout this build expects. It is
// idempotent and additive: a fresh database is created from tableColumns, and a
// pre-existing one has only the columns and indexes it is missing added, so
// accumulated statistics survive plugin upgrades.
func (s *Storage) ensureSchema() error {
	var version int
	if err := s.db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		return fmt.Errorf("read user_version: %w", err)
	}
	// A newer database was written by a newer plugin. Its extra columns and
	// any layout change we cannot express additively mean we must not touch it.
	if version > schemaVersion {
		return fmt.Errorf("database schema v%d is newer than this plugin supports (v%d): upgrade the plugin", version, schemaVersion)
	}

	defs := make([]string, len(tableColumns))
	for i, c := range tableColumns {
		defs[i] = c.name + " " + c.ddl
	}
	if _, err := s.db.Exec("CREATE TABLE IF NOT EXISTS usage_records (" + strings.Join(defs, ", ") + ")"); err != nil {
		return fmt.Errorf("create table: %w", err)
	}

	existing, err := s.existingColumns()
	if err != nil {
		return err
	}
	for _, c := range tableColumns {
		if existing[c.name] {
			continue
		}
		if _, err := s.db.Exec("ALTER TABLE usage_records ADD COLUMN " + c.name + " " + c.ddl); err != nil {
			return fmt.Errorf("add column %s: %w", c.name, err)
		}
	}
	for _, idx := range tableIndexes {
		if _, err := s.db.Exec(idx); err != nil {
			return fmt.Errorf("create index: %w", err)
		}
	}
	if _, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS request_lifecycle (
		request_id TEXT PRIMARY KEY,
		trace_id TEXT,
		source_format TEXT,
		model TEXT,
		requested_model TEXT,
		stream INTEGER NOT NULL DEFAULT 0,
		outcome TEXT NOT NULL,
		status_code INTEGER NOT NULL DEFAULT 0,
		error TEXT,
		started_at DATETIME,
		completed_at DATETIME,
		metadata TEXT,
		received_at DATETIME NOT NULL
	)`); err != nil {
		return fmt.Errorf("create lifecycle table: %w", err)
	}
	if _, err := s.db.Exec(`CREATE INDEX IF NOT EXISTS idx_lifecycle_trace ON request_lifecycle(trace_id, completed_at)`); err != nil {
		return fmt.Errorf("create lifecycle trace index: %w", err)
	}

	// 作者：long。终态列表按接收时间排序，范围统计按完成时间筛选，分别建索引避免每次扫描并排序全表。
	for _, index := range []string{
		`CREATE INDEX IF NOT EXISTS idx_lifecycle_event_time ON request_lifecycle(COALESCE(NULLIF(completed_at, ''), received_at))`,
		`CREATE INDEX IF NOT EXISTS idx_lifecycle_completed ON request_lifecycle(completed_at)`,
		`CREATE INDEX IF NOT EXISTS idx_lifecycle_received ON request_lifecycle(received_at DESC)`,
	} {
		if _, err := s.db.Exec(index); err != nil {
			return fmt.Errorf("create lifecycle time index: %w", err)
		}
	}

	if version != schemaVersion {
		if _, err := s.db.Exec("PRAGMA user_version = " + fmt.Sprint(schemaVersion)); err != nil {
			return fmt.Errorf("set user_version: %w", err)
		}
	}
	return nil
}

// existingColumns lists the columns currently present on usage_records.
func (s *Storage) existingColumns() (map[string]bool, error) {
	rows, err := s.db.Query("SELECT name FROM pragma_table_info('usage_records')")
	if err != nil {
		return nil, fmt.Errorf("read table info: %w", err)
	}
	defer rows.Close()

	columns := make(map[string]bool, len(tableColumns))
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, fmt.Errorf("scan table info: %w", err)
		}
		columns[name] = true
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate table info: %w", err)
	}
	return columns, nil
}

// InsertBatch inserts multiple usage records in a single transaction.
func (s *Storage) InsertBatch(records []model.UsageRecord) error {
	if len(records) == 0 {
		return nil
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	stmt, err := tx.Prepare(`
		INSERT INTO usage_records (
			request_id, trace_id, selection_id, session_id, parent_session_id, provider, base_url,
			executor_type, model, response_model, alias, api_key, is_native_key, access_provider,
			auth_id, auth_index, auth_type, source,
			reasoning_effort, service_tier, effective_service_tier, response_service_tier,
			stream, generate, requested_at, latency_ms, ttft_ms,
			failed, status_code, error_type, failure_body, response_headers,
			input_tokens, output_tokens, reasoning_tokens,
			cached_tokens, cache_read_tokens, cache_creation_tokens, total_tokens,
			cache_creation_5m_tokens, cache_creation_1h_tokens, text_input_tokens, image_input_tokens,
			audio_input_tokens, video_input_tokens, file_input_tokens, cached_text_tokens,
			cached_image_tokens, cached_audio_tokens, text_output_tokens, image_output_tokens,
			audio_output_tokens
		) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
		WHERE ? OR NOT EXISTS (SELECT 1 FROM usage_records WHERE request_id = ?)
	`)
	if err != nil {
		return fmt.Errorf("prepare insert: %w", err)
	}
	defer stmt.Close()

	for _, r := range records {
		reqAt := r.RequestedAt
		if reqAt.IsZero() {
			reqAt = time.Now()
		}
		failureBody := r.Failure.Body
		if len(failureBody) > maxFailureBody {
			failureBody = strings.ToValidUTF8(failureBody[:maxFailureBody], "")
		}
		// The error identifier is extracted at write time so failure grouping
		// stays a plain indexed GROUP BY instead of a JSON scan per query.
		errorType := ""
		if r.Failed {
			errorType = extractErrorType(failureBody)
		}

		_, err := stmt.Exec(
			r.RequestID,
			r.TraceID,
			r.SelectionID,
			r.SessionID,
			r.ParentSessionID,
			r.Provider,
			r.BaseURL,
			r.ExecutorType,
			r.Model,
			r.ResponseModel,
			r.Alias,
			r.APIKey,
			r.IsNativeKey,
			r.AccessProvider,
			r.AuthID,
			r.AuthIndex,
			r.AuthType,
			r.Source,
			r.ReasoningEffort,
			r.ServiceTier,
			r.EffectiveServiceTier,
			r.ResponseServiceTier,
			r.Stream,
			r.Generate,
			// Keep the zone-less legacy representation in UTC wall time. Query
			// boundaries are converted from the Beijing calendar before binding.
			timezone.FormatStorage(reqAt),
			r.Latency.Milliseconds(),
			r.TTFT.Milliseconds(),
			r.Failed,
			r.Failure.StatusCode,
			errorType,
			failureBody,
			serializeFailureHeaders(r.Failed, r.ResponseHeaders),
			r.Detail.InputTokens,
			r.Detail.OutputTokens,
			r.Detail.ReasoningTokens,
			r.Detail.CachedTokens,
			r.Detail.CacheReadTokens,
			r.Detail.CacheCreationTokens,
			r.Detail.TotalTokens,
			r.Detail.CacheCreation5mTokens,
			r.Detail.CacheCreation1hTokens,
			r.Detail.TextInputTokens,
			r.Detail.ImageInputTokens,
			r.Detail.AudioInputTokens,
			r.Detail.VideoInputTokens,
			r.Detail.FileInputTokens,
			r.Detail.CachedTextTokens,
			r.Detail.CachedImageTokens,
			r.Detail.CachedAudioTokens,
			r.Detail.TextOutputTokens,
			r.Detail.ImageOutputTokens,
			r.Detail.AudioOutputTokens,
			strings.TrimSpace(r.RequestID) == "",
			r.RequestID,
		)
		if err != nil {
			return fmt.Errorf("exec insert: %w", err)
		}
	}

	return tx.Commit()
}

// StoreLifecycle persists the terminal state separately from usage rows. A
// lifecycle event may arrive before usage.handle, so keeping it in its own
// table avoids manufacturing a zero-token usage record or losing the event.
func (s *Storage) StoreLifecycle(event model.RequestCompletion) error {
	if strings.TrimSpace(event.RequestID) == "" {
		return fmt.Errorf("request lifecycle event has no request_id")
	}
	metadata := ""
	if len(event.Metadata) > 0 {
		b, err := json.Marshal(event.Metadata)
		if err != nil {
			return fmt.Errorf("marshal lifecycle metadata: %w", err)
		}
		if len(b) <= maxLifecycleMetadata {
			metadata = string(b)
		}
	}
	startedAt, completedAt := "", ""
	// 作者：long。错误文本仅保留诊断所需长度，避免终态事件绕过用量失败正文的容量限制。
	if len(event.Error) > maxFailureBody {
		event.Error = strings.ToValidUTF8(event.Error[:maxFailureBody], "")
	}
	if !event.StartedAt.IsZero() {
		startedAt = timezone.FormatStorage(event.StartedAt)
	}
	if !event.CompletedAt.IsZero() {
		completedAt = timezone.FormatStorage(event.CompletedAt)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`INSERT INTO request_lifecycle
		(request_id, trace_id, source_format, model, requested_model, stream, outcome,
		 status_code, error, started_at, completed_at, metadata, received_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(request_id) DO UPDATE SET
		 trace_id=excluded.trace_id, source_format=excluded.source_format,
		 model=excluded.model, requested_model=excluded.requested_model,
		 stream=excluded.stream, outcome=excluded.outcome,
		 status_code=excluded.status_code, error=excluded.error,
		 started_at=excluded.started_at, completed_at=excluded.completed_at,
		 metadata=excluded.metadata, received_at=excluded.received_at`,
		event.RequestID, event.TraceID, event.SourceFormat, event.Model,
		event.RequestedModel, event.Stream, event.Outcome, event.StatusCode,
		event.Error, startedAt, completedAt, metadata, timezone.FormatStorage(time.Now()))
	return err
}

func lifecycleWhere(filter model.UsageFilter) (string, []interface{}) {
	var clauses []string
	var args []interface{}
	if filter.StartTime != nil {
		clauses = append(clauses, lifecycleTimeSQL+" >= ?")
		args = append(args, timezone.FormatStorage(*filter.StartTime))
	}
	if filter.EndTime != nil {
		clauses = append(clauses, lifecycleTimeSQL+" < ?")
		args = append(args, timezone.FormatStorage(*filter.EndTime))
	}
	if filter.Trace != "" {
		clauses = append(clauses, "trace_id = ?")
		args = append(args, filter.Trace)
	}
	for _, field := range []struct{ column, value string }{{"request_id", filter.RequestID}, {"outcome", filter.Outcome}, {"model", filter.Model}} {
		if field.value != "" {
			clauses = append(clauses, field.column+" = ?")
			args = append(args, field.value)
		}
	}
	where := ""
	if len(clauses) > 0 {
		where = "WHERE " + strings.Join(clauses, " AND ")
	}
	return where, args
}

func (s *Storage) GetLifecycleSummaryLocked(filter model.UsageFilter) (model.LifecycleSummary, error) {
	where, args := lifecycleWhere(filter)
	var summary model.LifecycleSummary
	var succeeded, failed, rejected, canceled int64
	err := s.db.QueryRow(`SELECT COUNT(*),
		COALESCE(SUM(outcome = 'succeeded'), 0),
		COALESCE(SUM(outcome = 'failed'), 0),
		COALESCE(SUM(outcome = 'rejected'), 0),
		COALESCE(SUM(outcome = 'canceled'), 0)
		FROM request_lifecycle `+where, args...).Scan(&summary.Total, &succeeded, &failed, &rejected, &canceled)
	if err != nil {
		return summary, fmt.Errorf("query lifecycle summary: %w", err)
	}
	summary.Succeeded, summary.Failed, summary.Rejected, summary.Canceled = succeeded, failed, rejected, canceled
	return summary, nil
}

// GetLifecycle returns terminal events for management clients.
func (s *Storage) GetLifecycle(filter model.UsageFilter) (*model.LifecycleListResponse, error) {
	return s.getLifecycle(filter, true)
}

// 作者：long。精简终态视图不读取Metadata；老管理客户端仍可使用原始接口。
func (s *Storage) getLifecycle(filter model.UsageFilter, includeMetadata bool) (*model.LifecycleListResponse, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	where, args := lifecycleWhere(filter)
	var total int64
	if err := s.db.QueryRow("SELECT COUNT(*) FROM request_lifecycle "+where, args...).Scan(&total); err != nil {
		return nil, fmt.Errorf("count lifecycle events: %w", err)
	}
	page, pageSize := max(filter.Page, 1), filter.PageSize
	if pageSize <= 0 {
		pageSize = 20
	}
	pageSize = min(pageSize, 100)
	// 作者：long。先用总数判断空页，避免无效列表扫描，也避免极大页码乘法溢出。
	if total == 0 || int64(page-1) > (total-1)/int64(pageSize) {
		return &model.LifecycleListResponse{Total: total, Page: page, PageSize: pageSize, Items: []model.LifecycleEvent{}}, nil
	}
	metadataColumn := "''"
	if includeMetadata {
		metadataColumn = "COALESCE(metadata, '')"
	}
	rows, err := s.db.Query(`SELECT request_id, COALESCE(trace_id, ''), COALESCE(source_format, ''),
		COALESCE(model, ''), COALESCE(requested_model, ''), stream, outcome, status_code,
		COALESCE(error, ''), COALESCE(started_at, ''), COALESCE(completed_at, ''),
		`+metadataColumn+`, received_at FROM request_lifecycle `+where+
		` ORDER BY received_at DESC, request_id DESC LIMIT ? OFFSET ?`, append(args, pageSize, (page-1)*pageSize)...)
	if err != nil {
		return nil, fmt.Errorf("query lifecycle events: %w", err)
	}
	defer rows.Close()
	items := make([]model.LifecycleEvent, 0, pageSize)
	for rows.Next() {
		var e model.LifecycleEvent
		var started, completed, received, metadata string
		if err := rows.Scan(&e.RequestID, &e.TraceID, &e.SourceFormat, &e.Model,
			&e.RequestedModel, &e.Stream, &e.Outcome, &e.StatusCode, &e.Error,
			&started, &completed, &metadata, &received); err != nil {
			return nil, err
		}
		e.StartedAt = parseStorageTime(started)
		e.CompletedAt = parseStorageTime(completed)
		e.ReceivedAt = parseStorageTime(received)
		if metadata != "" {
			_ = json.Unmarshal([]byte(metadata), &e.Metadata)
		}
		items = append(items, e)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return &model.LifecycleListResponse{Total: total, Page: page, PageSize: pageSize, Items: items}, nil
}

func parseStorageTime(value string) time.Time {
	if value == "" {
		return time.Time{}
	}
	// 作者：long。SQLite的DATETIME列可能经驱动转成RFC3339，兼容它与原UTC无时区格式，避免终态时间变为零值。
	for _, layout := range []string{time.RFC3339Nano, timeLayout, "2006-01-02 15:04:05"} {
		if parsed, err := time.Parse(layout, value); err == nil {
			return parsed.UTC()
		}
	}
	return time.Time{}
}

func buildWhere(filter model.UsageFilter) (string, []interface{}) {
	var clauses []string
	var args []interface{}

	if filter.StartTime != nil {
		clauses = append(clauses, "requested_at >= ?")
		args = append(args, timezone.FormatStorage(*filter.StartTime))
	}
	if filter.EndTime != nil {
		clauses = append(clauses, "requested_at < ?")
		args = append(args, timezone.FormatStorage(*filter.EndTime))
	}
	if filter.Model != "" {
		clauses = append(clauses, "model = ?")
		args = append(args, filter.Model)
	}
	if filter.Provider != "" {
		clauses = append(clauses, "provider = ?")
		args = append(args, filter.Provider)
	}
	if filter.APIKey != "" {
		clauses = append(clauses, "api_key = ?")
		args = append(args, filter.APIKey)
	}
	if filter.AuthID != "" {
		clauses = append(clauses, "auth_id = ?")
		args = append(args, filter.AuthID)
	}
	if filter.Session != "" {
		clauses = append(clauses, "session_id = ?")
		args = append(args, filter.Session)
	}
	if filter.Trace != "" {
		clauses = append(clauses, "trace_id = ?")
		args = append(args, filter.Trace)
	}
	if filter.Selection != "" {
		clauses = append(clauses, "selection_id = ?")
		args = append(args, filter.Selection)
	}
	if filter.Failed != nil {
		if *filter.Failed {
			clauses = append(clauses, "failed = 1")
		} else {
			clauses = append(clauses, "failed = 0")
		}
	}
	if filter.Keyword != "" {
		// 作者：long。搜索框表示字面子串，模型名中的下划线和输入的百分号不能扩大成SQL通配符。
		kw := "%" + strings.NewReplacer("!", "!!", "%", "!%", "_", "!_").Replace(filter.Keyword) + "%"
		clauses = append(clauses, "(request_id LIKE ? ESCAPE '!' OR trace_id LIKE ? ESCAPE '!' OR selection_id LIKE ? ESCAPE '!' OR session_id LIKE ? ESCAPE '!' OR model LIKE ? ESCAPE '!' OR alias LIKE ? ESCAPE '!' OR api_key LIKE ? ESCAPE '!' OR failure_body LIKE ? ESCAPE '!')")
		args = append(args, kw, kw, kw, kw, kw, kw, kw, kw)
	}

	where := ""
	if len(clauses) > 0 {
		where = "WHERE " + strings.Join(clauses, " AND ")
	}
	return where, args
}

// failureStats groups failed requests by upstream status and error type, and
// attaches one truncated sample body per group for quick triage.
func (s *Storage) failureStats(where string, args []interface{}) ([]model.FailureStat, error) {
	// The failure-only clause is ANDed onto the caller's filter.
	clause := "failed = 1"
	if where != "" {
		clause = strings.TrimPrefix(where, "WHERE ") + " AND failed = 1"
	}

	rows, err := s.db.Query(fmt.Sprintf(`
		SELECT
			status_code,
			COALESCE(error_type, ''),
			COUNT(*),
			COALESCE(MAX(CASE WHEN failure_body != '' THEN SUBSTR(failure_body, 1, 300) END), '')
		FROM usage_records
		WHERE %s
		GROUP BY status_code, error_type
		ORDER BY COUNT(*) DESC, status_code
		LIMIT 20
	`, clause), args...)
	if err != nil {
		return nil, fmt.Errorf("query failure stats: %w", err)
	}
	defer rows.Close()

	stats := []model.FailureStat{}
	for rows.Next() {
		var f model.FailureStat
		if err := rows.Scan(&f.StatusCode, &f.ErrorType, &f.Requests, &f.Sample); err != nil {
			return nil, fmt.Errorf("scan failure stats: %w", err)
		}
		stats = append(stats, f)
	}
	return stats, rows.Err()
}

// GetRecords returns paginated usage records.
func (s *Storage) GetRecords(filter model.UsageFilter) (*model.RecordListResponse, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	where, args := buildWhere(filter)

	var total int64
	if err := s.db.QueryRow("SELECT COUNT(*) FROM usage_records "+where, args...).Scan(&total); err != nil {
		return nil, fmt.Errorf("count records: %w", err)
	}

	page := max(filter.Page, 1)
	pageSize := filter.PageSize
	if pageSize <= 0 {
		pageSize = 20
	}
	pageSize = min(pageSize, 100)
	// 作者：long。超末页只返回总数与空数组，保持原分页契约并避免 OFFSET 溢出。
	if total == 0 || int64(page-1) > (total-1)/int64(pageSize) {
		return &model.RecordListResponse{Total: total, Page: page, PageSize: pageSize, Items: []model.StoredRecord{}}, nil
	}

	rows, err := s.db.Query(fmt.Sprintf(`
		SELECT
			id, request_id, COALESCE(trace_id, ''), COALESCE(selection_id, ''), COALESCE(session_id, ''), COALESCE(parent_session_id, ''),
			COALESCE(provider, ''), COALESCE(base_url, ''), COALESCE(executor_type, ''),
			COALESCE(model, ''), COALESCE(response_model, ''), COALESCE(alias, ''), COALESCE(api_key, ''),
			COALESCE(is_native_key, 0), COALESCE(access_provider, ''),
			COALESCE(auth_id, ''), COALESCE(auth_index, ''), COALESCE(auth_type, ''), COALESCE(source, ''),
			COALESCE(reasoning_effort, ''), COALESCE(service_tier, ''), COALESCE(effective_service_tier, ''), COALESCE(response_service_tier, ''),
			stream, generate, requested_at, latency_ms, ttft_ms,
			failed, status_code, COALESCE(error_type, ''), COALESCE(failure_body, ''), COALESCE(response_headers, ''),
			input_tokens, output_tokens, reasoning_tokens,
			cached_tokens, cache_read_tokens, cache_creation_tokens, total_tokens,
			cache_creation_5m_tokens, cache_creation_1h_tokens, text_input_tokens, image_input_tokens,
			audio_input_tokens, video_input_tokens, file_input_tokens, cached_text_tokens,
			cached_image_tokens, cached_audio_tokens, text_output_tokens, image_output_tokens,
			audio_output_tokens
		FROM usage_records
		%s
		ORDER BY id DESC
		LIMIT ? OFFSET ?
	`, where), append(args, pageSize, (page-1)*pageSize)...)
	if err != nil {
		return nil, fmt.Errorf("query records: %w", err)
	}
	defer rows.Close()

	items := make([]model.StoredRecord, 0, pageSize)
	for rows.Next() {
		var rawHeaders string
		var r model.StoredRecord
		if err := rows.Scan(
			&r.ID,
			&r.RequestID,
			&r.TraceID,
			&r.SelectionID,
			&r.SessionID,
			&r.ParentSessionID,
			&r.Provider,
			&r.BaseURL,
			&r.ExecutorType,
			&r.Model,
			&r.ResponseModel,
			&r.Alias,
			&r.APIKey,
			&r.IsNativeKey,
			&r.AccessProvider,
			&r.AuthID,
			&r.AuthIndex,
			&r.AuthType,
			&r.Source,
			&r.ReasoningEffort,
			&r.ServiceTier,
			&r.EffectiveServiceTier,
			&r.ResponseServiceTier,
			&r.Stream,
			&r.Generate,
			&r.RequestedAt,
			&r.LatencyMs,
			&r.TTFTMs,
			&r.Failed,
			&r.StatusCode,
			&r.ErrorType,
			&r.FailureBody,
			&rawHeaders,
			&r.InputTokens,
			&r.OutputTokens,
			&r.ReasoningTokens,
			&r.CachedTokens,
			&r.CacheReadTokens,
			&r.CacheCreationTokens,
			&r.TotalTokens,
			&r.CacheCreation5mTokens,
			&r.CacheCreation1hTokens,
			&r.TextInputTokens,
			&r.ImageInputTokens,
			&r.AudioInputTokens,
			&r.VideoInputTokens,
			&r.FileInputTokens,
			&r.CachedTextTokens,
			&r.CachedImageTokens,
			&r.CachedAudioTokens,
			&r.TextOutputTokens,
			&r.ImageOutputTokens,
			&r.AudioOutputTokens,
		); err != nil {
			return nil, fmt.Errorf("scan record: %w", err)
		}
		if rawHeaders != "" {
			_ = json.Unmarshal([]byte(rawHeaders), &r.ResponseHeaders)
		}
		items = append(items, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate records: %w", err)
	}

	return &model.RecordListResponse{
		Total:    total,
		Page:     page,
		PageSize: pageSize,
		Items:    items,
	}, nil
}

// GetOptions returns distinct non-empty filter values for dashboard dropdowns.
func (s *Storage) GetOptions() (*model.OptionsResponse, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	distinct := func(column string) ([]string, error) {
		rows, err := s.db.Query(fmt.Sprintf(
			"SELECT DISTINCT %s FROM usage_records WHERE %s != '' ORDER BY %s", column, column, column))
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		values := []string{}
		for rows.Next() {
			var v string
			if err := rows.Scan(&v); err != nil {
				return nil, err
			}
			values = append(values, v)
		}
		return values, rows.Err()
	}

	var err error
	resp := &model.OptionsResponse{}
	if resp.Models, err = distinct("model"); err != nil {
		return nil, fmt.Errorf("query model options: %w", err)
	}
	if resp.Providers, err = distinct("provider"); err != nil {
		return nil, fmt.Errorf("query provider options: %w", err)
	}
	if resp.APIKeys, err = distinct("api_key"); err != nil {
		return nil, fmt.Errorf("query api_key options: %w", err)
	}
	if resp.Auths, err = distinct("auth_id"); err != nil {
		return nil, fmt.Errorf("query auth options: %w", err)
	}
	return resp, nil
}

// Stats reports file sizes, record counts and reclaimable space. File sizes
// include the WAL and shared-memory sidecars; free pages are what VACUUM can
// return to the filesystem.
func (s *Storage) Stats(retentionDays int) (*model.StorageStats, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	var pageCount, freePages, pageSize int64
	if err := s.db.QueryRow("PRAGMA page_count").Scan(&pageCount); err != nil {
		return nil, fmt.Errorf("read page_count: %w", err)
	}
	if err := s.db.QueryRow("PRAGMA freelist_count").Scan(&freePages); err != nil {
		return nil, fmt.Errorf("read freelist_count: %w", err)
	}
	if err := s.db.QueryRow("PRAGMA page_size").Scan(&pageSize); err != nil {
		return nil, fmt.Errorf("read page_size: %w", err)
	}

	var recordCount, lifecycleRecordCount int64
	var oldest, newest sql.NullString
	if err := s.db.QueryRow(
		// 作者：long。独立标量子查询让 COUNT 使用计数路径，最早/最晚时间各取索引端点。
		`SELECT (SELECT COUNT(*) FROM usage_records),
		 (SELECT MIN(requested_at) FROM usage_records), (SELECT MAX(requested_at) FROM usage_records),
		 (SELECT COUNT(*) FROM request_lifecycle)`,
	).Scan(&recordCount, &oldest, &newest, &lifecycleRecordCount); err != nil {
		return nil, fmt.Errorf("query storage totals: %w", err)
	}

	dbSize := fileSize(s.dbPath)
	walSize := fileSize(s.dbPath + "-wal")
	shmSize := fileSize(s.dbPath + "-shm")

	return &model.StorageStats{
		DBPath:               s.dbPath,
		DBSizeBytes:          dbSize,
		WALSizeBytes:         walSize,
		SHMSizeBytes:         shmSize,
		TotalSizeBytes:       dbSize + walSize + shmSize,
		RecordCount:          recordCount,
		LifecycleRecordCount: lifecycleRecordCount,
		OldestRecordAt:       oldest.String,
		NewestRecordAt:       newest.String,
		ReclaimableBytes:     freePages * pageSize,
		RetentionDays:        retentionDays,
	}, nil
}

// Vacuum rebuilds the database file and truncates the WAL, releasing pages
// left behind by deleted records. It blocks writes for the duration.
func (s *Storage) Vacuum() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, err := s.db.Exec("PRAGMA wal_checkpoint(TRUNCATE)"); err != nil {
		return fmt.Errorf("checkpoint before vacuum: %w", err)
	}
	if _, err := s.db.Exec("VACUUM"); err != nil {
		return fmt.Errorf("vacuum: %w", err)
	}
	if _, err := s.db.Exec("PRAGMA wal_checkpoint(TRUNCATE)"); err != nil {
		return fmt.Errorf("checkpoint after vacuum: %w", err)
	}
	return nil
}

func fileSize(path string) int64 {
	info, err := os.Stat(path)
	if err != nil {
		return 0
	}
	return info.Size()
}

// CleanRetention applies the configured retention window to both usage and terminal events.
func (s *Storage) CleanRetention(retentionDays int) (int64, error) {
	if retentionDays <= 0 {
		return 0, nil
	}
	cutoff := time.Now().In(timezone.BusinessLocation).AddDate(0, 0, -retentionDays)
	usage, lifecycle, err := s.DeleteRangeWithCounts(nil, &cutoff)
	return usage + lifecycle, err
}

// DeleteRange retains the usage-only count contract for existing internal callers. 作者：long。
func (s *Storage) DeleteRange(start, end *time.Time) (int64, error) {
	usage, _, err := s.DeleteRangeWithCounts(start, end)
	return usage, err
}

// 作者：long。两类记录各按自身事件时间在同一事务删除；缺完成时间的终态按接收时间清理，防止永久残留。
func (s *Storage) DeleteRangeWithCounts(start, end *time.Time) (int64, int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return 0, 0, err
	}
	defer tx.Rollback()
	counts := [2]int64{}
	for i, spec := range []struct{ table, column string }{{"usage_records", "requested_at"}, {"request_lifecycle", lifecycleTimeSQL}} {
		clauses, args := []string{}, []any{}
		if start != nil {
			clauses = append(clauses, spec.column+" >= ?")
			args = append(args, timezone.FormatStorage(*start))
		}
		if end != nil {
			clauses = append(clauses, spec.column+" < ?")
			args = append(args, timezone.FormatStorage(*end))
		}
		query := "DELETE FROM " + spec.table
		if len(clauses) > 0 {
			query += " WHERE " + strings.Join(clauses, " AND ")
		}
		result, err := tx.Exec(query, args...)
		if err != nil {
			return 0, 0, fmt.Errorf("delete %s: %w", spec.table, err)
		}
		counts[i], err = result.RowsAffected()
		if err != nil {
			return 0, 0, err
		}
	}
	if err := tx.Commit(); err != nil {
		return 0, 0, err
	}
	return counts[0], counts[1], nil
}

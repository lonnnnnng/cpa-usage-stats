package handler

import (
	"testing"
	"time"

	"cpa-usage-stats/internal/timezone"
)

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

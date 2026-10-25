package timezone

import (
	"testing"
	"time"
)

func TestDayBoundsUsesBeijingCalendarAcrossUTCDateBoundary(t *testing.T) {
	// 16:30 UTC is already 00:30 in Beijing on the following calendar day.
	now := time.Date(2026, 10, 24, 16, 30, 0, 0, time.UTC)
	start, end := DayBounds(now)
	if got := start.Format(TimeLayout); got != "2026-10-25 00:00:00.000" {
		t.Fatalf("start = %s, want Beijing midnight", got)
	}
	if got := FormatStorage(start); got != "2026-10-24 16:00:00.000" {
		t.Fatalf("storage start = %s, want UTC wall time", got)
	}
	if got := FormatStorage(end); got != "2026-10-25 16:00:00.000" {
		t.Fatalf("storage end = %s, want next Beijing midnight", got)
	}
}

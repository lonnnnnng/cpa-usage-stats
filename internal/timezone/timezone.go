// Package timezone centralizes the two clocks used by the plugin.
package timezone

import "time"

const (
	// TimeLayout is the legacy SQLite wall-clock format. Existing databases use
	// it without an offset, so the format must remain stable across upgrades.
	TimeLayout = "2006-01-02 15:04:05.000"
	// businessOffset is Beijing time (UTC+8), which is the dashboard's calendar.
	businessOffset = 8 * 60 * 60
)

// BusinessLocation is the fixed dashboard calendar. A fixed zone is deliberate:
// this plugin has no daylight-saving transition and must work even when tzdata
// is absent from a small server image.
var BusinessLocation = time.FixedZone("Asia/Shanghai", businessOffset)

// StorageLocation is the canonical zone for SQLite's zone-less legacy values.
// Keeping storage in UTC wall time preserves all existing rows and lets the
// browser convert them to Beijing consistently.
var StorageLocation = time.UTC

// DayBounds returns the half-open [start,end) calendar day in Beijing time.
func DayBounds(now time.Time) (time.Time, time.Time) {
	local := now.In(BusinessLocation)
	start := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, BusinessLocation)
	return start, start.AddDate(0, 0, 1)
}

// FormatStorage converts an instant or business-calendar boundary to the
// canonical UTC wall-clock text used by existing SQLite rows.
func FormatStorage(value time.Time) string {
	return value.In(StorageLocation).Format(TimeLayout)
}

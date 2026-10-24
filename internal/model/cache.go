package model

import "strings"

// CacheSemantics describes whether the host reports cached tokens as a subset
// of input tokens or as a separate prompt bucket.
type CacheSemantics string

const (
	CacheSubset      CacheSemantics = "subset"
	CacheIndependent CacheSemantics = "independent"
)

// ClassifyCacheSemantics keeps the aggregate metric aligned with the upstream
// protocol. OpenAI/Codex reports cached input as a subset of input_tokens,
// while Anthropic reports uncached, read, and creation buckets separately.
// 作者：long
func ClassifyCacheSemantics(provider, executorType, source, model string) CacheSemantics {
	value := strings.ToLower(strings.Join([]string{provider, executorType, source, model}, " "))
	if strings.Contains(value, "anthropic") || strings.Contains(value, "claude") {
		return CacheIndependent
	}
	return CacheSubset
}

// CacheHitRate returns the percentage of prompt tokens served from cache.
// The fallback for a missing input total keeps malformed/legacy records from
// producing a divide-by-zero result while preserving the provider-specific
// denominator for valid records.
// 作者：long
func CacheHitRate(input, cacheRead, cacheCreation int64, semantics CacheSemantics) (float64, bool) {
	if cacheRead < 0 || cacheCreation < 0 {
		return 0, false
	}
	denominator := input
	if semantics == CacheIndependent {
		denominator = input + cacheRead + cacheCreation
	} else if denominator <= 0 {
		denominator = cacheRead + cacheCreation
	}
	if denominator <= 0 {
		return 0, false
	}
	return float64(cacheRead) / float64(denominator) * 100, true
}

package storage

import (
	"strings"
	"time"

	"cpa-usage-stats/internal/model"
)

// 作者：long。终态通常有完成时间；异常或旧事件用接收时间兜底，筛选和保留策略采用同一口径。
const lifecycleTimeSQL = "COALESCE(NULLIF(completed_at, ''), received_at)"

func (s *Storage) GetLifecycleView(filter model.UsageFilter) (*model.LifecycleViewResponse, error) {
	list, err := s.getLifecycle(filter, false)
	if err != nil {
		return nil, err
	}
	result := &model.LifecycleViewResponse{Total: list.Total, Page: list.Page, PageSize: list.PageSize,
		Items: make([]model.LifecycleViewEvent, 0, len(list.Items))}
	timeValue := func(value time.Time) *time.Time {
		if value.IsZero() {
			return nil
		}
		return &value
	}
	for _, event := range list.Items {
		message := event.Error
		if len(message) > maxFailureBody {
			message = strings.ToValidUTF8(message[:maxFailureBody], "")
		}
		result.Items = append(result.Items, model.LifecycleViewEvent{RequestID: event.RequestID, TraceID: event.TraceID,
			SourceFormat: event.SourceFormat, Model: event.Model, RequestedModel: event.RequestedModel,
			Stream: event.Stream, Outcome: event.Outcome, StatusCode: event.StatusCode, Error: message,
			StartedAt: timeValue(event.StartedAt), CompletedAt: timeValue(event.CompletedAt), ReceivedAt: event.ReceivedAt})
	}
	return result, nil
}

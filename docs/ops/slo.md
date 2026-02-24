# SLOs and Alerts

## Service Level Objectives

1. Text sync propagation latency: p95 < 1 second under normal network conditions.
2. Sync API availability: 99.9% monthly for `/v1/vaults/*/sync/*`.
3. Operation durability: 0 acknowledged operations lost.
4. Blob commit success: 99.5% within 5 minutes of first chunk upload.

## Error Budget Policy

1. Breach warning at 50% budget consumed in rolling 14 days.
2. Freeze non-critical feature rollout if 100% budget is consumed.

## Alert Conditions

1. `health.status != ok` for 2 consecutive minutes.
2. p95 push or pull request latency > 1s for 10 minutes.
3. Realtime reconnect rate exceeds baseline by 2x for 15 minutes.
4. Blob incomplete (409) ratio > 5% for 30 minutes.

## Key Dashboards

1. API throughput, latency, and error rate by endpoint.
2. OpLog ingestion rate and queue depth.
3. Blob upload chunk failure and retry counts.
4. Device activity and cursor lag distribution.

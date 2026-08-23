# Observability: traces, metrics, and terminal-failure alerting

The background processes (the standalone worker and the web server's Node
runtime) emit OpenTelemetry traces and metrics for every unit of durable work.
Telemetry is **off by default** and costs nothing when off: all emission goes
through the `@opentelemetry/api` no-op until a collector endpoint is
configured. There is no vendor SDK — any OTLP/HTTP receiver (Grafana Alloy,
Jaeger, Datadog OTel gateway, an OpenTelemetry Collector, …) receives the same
protocol.

## Enabling

Set the standard OpenTelemetry variables in the deployment environment (the
compose file passes them through to both the `web` and `worker` services):

| Variable | Meaning |
| --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base URL of an OTLP/HTTP collector. The exporter appends `/v1/traces` or `/v1/metrics` to its path. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | Optional per-signal endpoint override. Per spec, each override is used as supplied (a pathless URL uses `/`); include `/v1/traces` or `/v1/metrics` when the collector expects the standard signal path. A per-signal endpoint alone enables that signal. |
| `OTEL_EXPORTER_OTLP_HEADERS` | Optional `key=value,key2=value2` headers (URL-encoded values), e.g. collector auth tokens. |
| `OTEL_SERVICE_NAME` | Resource name reported to the collector (default `openbooks`). Distinguish replicas with per-deployment values. |
| `OTEL_RESOURCE_ATTRIBUTES` | Optional extra resource attributes (`k=v,k2=v2`, URL-encoded). |
| `OTEL_METRIC_EXPORT_INTERVAL` | Metric export interval in ms (default `60000`). |
| `OTEL_TRACES_EXPORTER=none` / `OTEL_METRICS_EXPORTER=none` | Disable one signal while keeping the other. |

Boot is logged as one structured line: `{"event":"telemetry.started",…}`. A
failed boot or shutdown is logged loudly but is never fatal.

## Signals

All signals are emitted under the instrumentation scope `openbooks.engine`
(see `engine/src/telemetry.ts`).

Spans:

| Name | Emitted around |
| --- | --- |
| `scheduler.tick` | One full scheduler pass on a replica that won the tick claim (worker/scheduler.ts). Every outbox attempt in the pass joins it as a child. |
| `outbox.attempt` | One claimed scheduler_outbox row attempt (dunning, subscription/property billing, FX providers, approval escalations). |
| `report_run.process` | One scheduled report run: definition check, render, artifact retention, recipient outbox creation. |

Metrics:

| Name | Type | Attributes |
| --- | --- | --- |
| `openbooks.outbox.attempts` | counter | `openbooks.surface` (`scheduler_outbox` \| `report_runs`), `openbooks.kind`, `openbooks.outcome` (`succeeded` \| `failed`) |
| `openbooks.outbox.attempt_duration` | histogram (ms) | surface + kind |
| `openbooks.terminal_failures` | counter | `openbooks.surface` (`scheduler_outbox` \| `report_runs` \| `report_delivery_outbox`), `openbooks.kind` where the surface has one |

Suggested dashboard baselines: attempts by outcome (failure ratio per kind),
attempt duration p95 per kind, and terminal failures flat at zero.

## Alerting on terminal failures

Both outboxes stop retrying a row once its attempt ceiling is reached. That
transition is never silent: the poison row itself is stamped durably with
`terminal_failed_at`, `terminal_failed_by`, the last error, and the attempt
count (exactly once, crash-safe — see `engine/src/terminal-failure.ts`), one
structured log line `{"event":"scheduler.terminal_failure",…}` is emitted, and
the `openbooks.terminal_failures` counter increments by exactly 1.

Page on any increase:

```
rate(openbooks.terminal_failures[5m]) > 0
```

Every increment has a matching durable row to investigate. Query the stamped
rows directly when telemetry is unavailable or for post-mortems:

```sql
select kind, id, org_id, subject_id, error, attempt_count,
       terminal_failed_at, terminal_failed_by
  from scheduler_outbox
 where terminal_failed_at is not null
 order by terminal_failed_at desc;

select id, org_id, definition_id, error, attempt_count,
       terminal_failed_at, terminal_failed_by
  from report_runs
 where terminal_failed_at is not null
 order by terminal_failed_at desc;

select id, org_id, recipient, error, attempt_count,
       terminal_failed_at, terminal_failed_by
  from report_delivery_outbox
 where terminal_failed_at is not null
 order by terminal_failed_at desc;
```

All three tables are partial-indexed on `terminal_failed_at` for that
predicate.

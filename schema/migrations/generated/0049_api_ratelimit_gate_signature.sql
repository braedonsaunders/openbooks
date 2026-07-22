-- API key per-minute rate limiting: a fixed-window counter kept on the key row
-- itself (one atomic UPDATE per request, no extra table). rate_limit_per_min
-- backfills to 120 for existing keys; NULL means unlimited.
alter table api_keys add column if not exists rate_limit_per_min integer default 120;
alter table api_keys add column if not exists rate_window_start timestamptz;
alter table api_keys add column if not exists rate_window_count integer not null default 0;

-- Flow gate e-signature: the typed attestation captured when a signature-required
-- gate is approved (decidedBy/decidedAt already record who and when).
alter table flow_gates add column if not exists signature text;

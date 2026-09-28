-- OpenBooks forward migration 0455_saas_metrics_normalization_evidence.
-- Additive SaaS normalization foundation. The three SaaS metric tables gain a
-- nullable all-null-or-complete reporting triple (currency, denomination
-- machine version, evidence). Two new tenant tables record reproducible FX evidence
-- and the guarded normalization request lifecycle. Attempt and per-row
-- history lives in the canonical audit_log, appended atomically by the
-- request guard with lease-token digests only. No row backfill, no data
-- rewrite, no new defaults on existing rows.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

-- Nullable reporting triple: absent together, or complete together with a
-- well-formed ISO currency, a machine denomination version, and evidence
-- naming its digest inputs hash. Existing rows keep all three null.
ALTER TABLE public.saas_metrics_monthly
  ADD COLUMN reporting_currency text,
  ADD COLUMN denomination_version text,
  ADD COLUMN normalization_evidence jsonb,
  ADD CONSTRAINT saas_metrics_monthly_norm_complete CHECK (
    (reporting_currency IS NULL AND denomination_version IS NULL AND normalization_evidence IS NULL)
    OR (reporting_currency IS NOT NULL AND denomination_version IS NOT NULL AND normalization_evidence IS NOT NULL)
  ),
  ADD CONSTRAINT saas_metrics_monthly_norm_shape CHECK (
    reporting_currency IS NULL
    OR (reporting_currency ~ '^[A-Z]{3}$'
        AND denomination_version ~ '^v[0-9]+$'
        AND char_length(denomination_version) <= 64
        AND jsonb_typeof(normalization_evidence) = 'object'
        AND (normalization_evidence ->> 'inputs_hash') ~ '^[0-9a-f]{64}$')
  );

ALTER TABLE public.saas_metrics_facts_monthly
  ADD COLUMN reporting_currency text,
  ADD COLUMN denomination_version text,
  ADD COLUMN normalization_evidence jsonb,
  ADD CONSTRAINT saas_metrics_facts_monthly_norm_complete CHECK (
    (reporting_currency IS NULL AND denomination_version IS NULL AND normalization_evidence IS NULL)
    OR (reporting_currency IS NOT NULL AND denomination_version IS NOT NULL AND normalization_evidence IS NOT NULL)
  ),
  ADD CONSTRAINT saas_metrics_facts_monthly_norm_shape CHECK (
    reporting_currency IS NULL
    OR (reporting_currency ~ '^[A-Z]{3}$'
        AND denomination_version ~ '^v[0-9]+$'
        AND char_length(denomination_version) <= 64
        AND jsonb_typeof(normalization_evidence) = 'object'
        AND (normalization_evidence ->> 'inputs_hash') ~ '^[0-9a-f]{64}$')
  );

ALTER TABLE public.saas_metrics_cohort_monthly
  ADD COLUMN reporting_currency text,
  ADD COLUMN denomination_version text,
  ADD COLUMN normalization_evidence jsonb,
  ADD CONSTRAINT saas_metrics_cohort_monthly_norm_complete CHECK (
    (reporting_currency IS NULL AND denomination_version IS NULL AND normalization_evidence IS NULL)
    OR (reporting_currency IS NOT NULL AND denomination_version IS NOT NULL AND normalization_evidence IS NOT NULL)
  ),
  ADD CONSTRAINT saas_metrics_cohort_monthly_norm_shape CHECK (
    reporting_currency IS NULL
    OR (reporting_currency ~ '^[A-Z]{3}$'
        AND denomination_version ~ '^v[0-9]+$'
        AND char_length(denomination_version) <= 64
        AND jsonb_typeof(normalization_evidence) = 'object'
        AND (normalization_evidence ->> 'inputs_hash') ~ '^[0-9a-f]{64}$')
  );

-- Append-only FX evidence: one observation per organization, month, pair,
-- source, and quotation instant. The evidence document carries the complete
-- reproducible shape a later normalization run replays.
CREATE TABLE public.saas_metrics_fx_evidence (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  month date NOT NULL,
  base_currency text NOT NULL,
  quote_currency text NOT NULL,
  rate numeric(19,10) NOT NULL,
  source text NOT NULL,
  quoted_at timestamp with time zone NOT NULL,
  evidence jsonb NOT NULL,
  inputs_hash text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  CONSTRAINT saas_metrics_fx_evidence_pkey PRIMARY KEY (id),
  CONSTRAINT saas_metrics_fx_evidence_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT saas_metrics_fx_evidence_org_observation_unique UNIQUE (org_id, month, base_currency, quote_currency, source, quoted_at),
  CONSTRAINT saas_metrics_fx_evidence_org_fk FOREIGN KEY (org_id)
    REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT saas_metrics_fx_evidence_month_start CHECK (extract(day FROM month) = 1),
  CONSTRAINT saas_metrics_fx_evidence_currencies_valid CHECK (
    base_currency ~ '^[A-Z]{3}$' AND quote_currency ~ '^[A-Z]{3}$' AND base_currency <> quote_currency
  ),
  CONSTRAINT saas_metrics_fx_evidence_rate_positive CHECK (rate > 0),
  CONSTRAINT saas_metrics_fx_evidence_source_valid CHECK (source IN ('manual', 'bank_of_canada', 'ecb', 'open_exchange_rates')),
  CONSTRAINT saas_metrics_fx_evidence_inputs_hash_digest CHECK (inputs_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT saas_metrics_fx_evidence_shape CHECK (
    jsonb_typeof(evidence) = 'object'
    AND (evidence ->> 'base_currency') = base_currency
    AND (evidence ->> 'quote_currency') = quote_currency
    AND (evidence ->> 'rate')::numeric(19,10) = rate
    AND (evidence ->> 'source') = source
    AND (evidence ->> 'quoted_at')::timestamptz = quoted_at
    AND (evidence ->> 'inputs_hash') = inputs_hash
  )
);

ALTER TABLE public.saas_metrics_fx_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.saas_metrics_fx_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.saas_metrics_fx_evidence
  USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));

CREATE INDEX saas_metrics_fx_evidence_org_month ON public.saas_metrics_fx_evidence (org_id, month);

COMMENT ON TABLE public.saas_metrics_fx_evidence IS
  'Append-only reproducible FX observations for SaaS normalization. Evidence documents replay the quotation; rows are never updated or deleted.';

CREATE FUNCTION public.saas_metrics_fx_evidence_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'saas FX evidence is append-only and cannot be deleted; record a superseding observation instead'
      USING ERRCODE = 'check_violation';
  END IF;
  RAISE EXCEPTION 'saas FX evidence is immutable and cannot be updated; record a new observation instead'
    USING ERRCODE = 'check_violation';
END
$fn$;

CREATE TRIGGER saas_metrics_fx_evidence_guard
  BEFORE UPDATE OR DELETE ON public.saas_metrics_fx_evidence
  FOR EACH ROW EXECUTE FUNCTION public.saas_metrics_fx_evidence_guard();

-- Guarded normalization requests: one lifecycle row per organization and
-- month. The row owns current fenced liveness only (status, live lease,
-- heartbeat, progress, outcome); attempt and per-row history lives in the
-- canonical audit_log, appended atomically by the guard below with
-- lease-token digests only, never raw tokens.
CREATE TABLE public.saas_metrics_normalization_requests (
  id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
  org_id uuid NOT NULL,
  month date NOT NULL,
  reason text NOT NULL,
  requested_by uuid NOT NULL,
  approved_by uuid,
  approved_at timestamp with time zone,
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  progress jsonb NOT NULL DEFAULT '{}',
  result jsonb,
  failure text,
  remedy text,
  lease_token uuid,
  lease_expires_at timestamp with time zone,
  attempt_count integer NOT NULL DEFAULT 0,
  last_heartbeat_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  created_by uuid,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_by uuid,
  CONSTRAINT saas_metrics_normalization_requests_pkey PRIMARY KEY (id),
  CONSTRAINT saas_metrics_normalization_requests_org_id_id_unique UNIQUE (org_id, id),
  CONSTRAINT saas_metrics_normalization_requests_org_idempotency_unique UNIQUE (org_id, idempotency_key),
  CONSTRAINT saas_metrics_normalization_requests_org_fk FOREIGN KEY (org_id)
    REFERENCES public.orgs(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT saas_metrics_normalization_requests_requested_by_fk FOREIGN KEY (requested_by)
    REFERENCES public.users(id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT saas_metrics_normalization_requests_approved_by_fk FOREIGN KEY (approved_by)
    REFERENCES public.users(id) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT saas_metrics_normalization_requests_month_start CHECK (extract(day FROM month) = 1),
  CONSTRAINT saas_metrics_normalization_requests_reason_nonblank CHECK (char_length(btrim(reason)) BETWEEN 8 AND 1000),
  CONSTRAINT saas_metrics_normalization_requests_request_hash_digest CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT saas_metrics_normalization_requests_status_valid CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
  CONSTRAINT saas_metrics_normalization_requests_approved_pair CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
  CONSTRAINT saas_metrics_normalization_requests_approver_distinct CHECK (approved_by IS NULL OR approved_by <> requested_by),
  CONSTRAINT saas_metrics_normalization_requests_lease_pair CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL)),
  CONSTRAINT saas_metrics_normalization_requests_attempt_nonnegative CHECK (attempt_count >= 0),
  CONSTRAINT saas_metrics_normalization_requests_outcome_shape CHECK (
    (status IN ('pending', 'running', 'cancelled') AND result IS NULL AND failure IS NULL AND remedy IS NULL)
    OR (status = 'succeeded' AND result IS NOT NULL AND failure IS NULL AND remedy IS NULL)
    OR (status = 'failed' AND result IS NULL AND failure IS NOT NULL AND remedy IS NOT NULL
        AND btrim(failure) <> '' AND btrim(remedy) <> '')
  )
);

ALTER TABLE public.saas_metrics_normalization_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.saas_metrics_normalization_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON public.saas_metrics_normalization_requests
  USING (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true))
  WITH CHECK (public.app_bypass_rls_active() OR org_id::text = current_setting('app.current_org', true));

-- One live request per organization and month: terminal rows leave the
-- partial index, so a later retry month-row starts clean while a live one
-- stays fenced.
CREATE UNIQUE INDEX saas_metrics_normalization_requests_org_month_live
  ON public.saas_metrics_normalization_requests (org_id, month)
  WHERE status IN ('pending', 'running');
CREATE INDEX saas_metrics_normalization_requests_org_status
  ON public.saas_metrics_normalization_requests (org_id, status);

COMMENT ON TABLE public.saas_metrics_normalization_requests IS
  'Guarded SaaS normalization request lifecycle. The row owns current fenced liveness; append-only attempt history lives in audit_log.';

CREATE FUNCTION public.saas_metrics_normalization_request_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  actor_org uuid;
  live boolean;
  prior_digest text;
  new_digest text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF public.openbooks_sandbox_wipe_allowed(OLD.org_id) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'saas normalization requests are durable audit and cannot be deleted; cancel the request instead'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Actor identities are validated against the subject: the requester and
  -- the approver must belong to the requesting organization.
  IF NEW.requested_by IS NOT NULL THEN
    SELECT org_id INTO actor_org FROM public.users WHERE id = NEW.requested_by;
    IF actor_org IS DISTINCT FROM NEW.org_id THEN
      RAISE EXCEPTION 'saas normalization requester must be a user of the requesting organization; choose a requester in this organization'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.approved_by IS NOT NULL THEN
    SELECT org_id INTO actor_org FROM public.users WHERE id = NEW.approved_by;
    IF actor_org IS DISTINCT FROM NEW.org_id THEN
      RAISE EXCEPTION 'saas normalization approver must be a user of the requesting organization; choose an approver in this organization'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.approved_by IS NOT DISTINCT FROM NEW.requested_by THEN
      RAISE EXCEPTION 'saas normalization approver must be distinct from the requester; choose a separate approver in this organization'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'pending' THEN
      RAISE EXCEPTION 'new saas normalization requests start as pending; claim the pending request to begin work'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.approved_by IS NOT NULL OR NEW.approved_at IS NOT NULL THEN
      RAISE EXCEPTION 'saas normalization approval is recorded by updating the pending request, not at insert; insert without approver, then record approval'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.lease_token IS NOT NULL OR NEW.lease_expires_at IS NOT NULL OR NEW.last_heartbeat_at IS NOT NULL THEN
      RAISE EXCEPTION 'new saas normalization requests hold no lease; claim the pending request to take a lease token'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.attempt_count <> 0 THEN
      RAISE EXCEPTION 'new saas normalization requests start at attempt zero; claims pending attempts'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.result IS NOT NULL OR NEW.failure IS NOT NULL OR NEW.remedy IS NOT NULL THEN
      RAISE EXCEPTION 'new saas normalization requests carry no outcome; finalize a running claim to record one'
        USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO public.audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
    VALUES (NEW.org_id, 'saas_metrics_normalization_requests', NEW.id, 'saas_normalization_requested',
      jsonb_build_object('event', 'saas_normalization_requested', 'requestId', NEW.id,
        'month', NEW.month, 'attempt', 0,
        'statusBefore', NULL, 'statusAfter', NEW.status,
        'priorLeaseDigest', NULL, 'newLeaseDigest', NULL,
        'actor', NEW.requested_by, 'reason', NEW.reason),
      NEW.requested_by, NEW.idempotency_key::text);
    RETURN NEW;
  END IF;

  -- Request identity is immutable; a new month or idempotency key is a new request.
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.month IS DISTINCT FROM OLD.month
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by THEN
    RAISE EXCEPTION 'saas normalization request identity (organization, month, idempotency key, request hash, requester) is immutable; file a new request instead'
      USING ERRCODE = 'check_violation';
  END IF;
  -- The approver is immutable once recorded; the approval timestamp follows it.
  IF OLD.approved_by IS NOT NULL AND NEW.approved_by IS DISTINCT FROM OLD.approved_by THEN
    RAISE EXCEPTION 'saas normalization approver is immutable once recorded; the recorded approval stands'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.approved_at IS NOT NULL AND NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN
    RAISE EXCEPTION 'saas normalization approval time is immutable once recorded; the recorded approval stands'
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.approved_by IS NULL) <> (NEW.approved_at IS NULL) THEN
    RAISE EXCEPTION 'saas normalization approval needs both approver and approval time; record them together on the pending request'
      USING ERRCODE = 'check_violation';
  END IF;
  -- Terminal rows are immutable; further work is a new request.
  IF OLD.status IN ('succeeded', 'cancelled') THEN
    RAISE EXCEPTION 'saas normalization requests in terminal state % are immutable; file a new request for further work', OLD.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- Liveness: the presented token must equal the stored live token and the
  -- stored lease must not have expired. Every later mutation and
  -- finalization funnels through this flag.
  live := OLD.lease_token IS NOT NULL
          AND NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token
          AND OLD.lease_expires_at IS NOT NULL
          AND OLD.lease_expires_at > now();
  prior_digest := CASE WHEN OLD.lease_token IS NULL THEN NULL
    ELSE 'sha256:' || encode(public.digest(convert_to(OLD.lease_token::text, 'UTF8'), 'sha256'), 'hex') END;
  new_digest := CASE WHEN NEW.lease_token IS NULL THEN NULL
    ELSE 'sha256:' || encode(public.digest(convert_to(NEW.lease_token::text, 'UTF8'), 'sha256'), 'hex') END;

  -- Pending rows change only by recording approval, claiming, or cancelling.
  IF OLD.status = 'pending' AND NEW.status = 'pending' THEN
    IF NEW.lease_token IS DISTINCT FROM OLD.lease_token
       OR NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at
       OR NEW.last_heartbeat_at IS DISTINCT FROM OLD.last_heartbeat_at
       OR NEW.attempt_count <> OLD.attempt_count
       OR NEW.result IS NOT NULL OR NEW.failure IS NOT NULL OR NEW.remedy IS NOT NULL
       OR NEW.progress IS DISTINCT FROM OLD.progress THEN
      RAISE EXCEPTION 'pending saas normalization requests change only by recording approval, claiming to running, or cancelling'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.updated_at := now();
    IF OLD.approved_by IS NULL AND NEW.approved_by IS NOT NULL THEN
      INSERT INTO public.audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
      VALUES (NEW.org_id, 'saas_metrics_normalization_requests', NEW.id, 'saas_normalization_approved',
        jsonb_build_object('event', 'saas_normalization_approved', 'requestId', NEW.id,
          'month', NEW.month, 'attempt', NEW.attempt_count,
          'statusBefore', OLD.status, 'statusAfter', NEW.status,
          'priorLeaseDigest', prior_digest, 'newLeaseDigest', new_digest,
          'actor', NEW.approved_by, 'reason', NEW.reason),
        NEW.approved_by, NEW.idempotency_key::text);
    END IF;
    RETURN NEW;
  END IF;

  -- First claim: pending to running opens attempt one with a fresh live lease.
  -- Execution requires a recorded approval and a presented transition actor.
  IF OLD.status = 'pending' AND NEW.status = 'running' THEN
    IF NEW.approved_by IS NULL OR NEW.approved_at IS NULL THEN
      RAISE EXCEPTION 'claiming a saas normalization request requires a recorded approval; record approver and approval time on the pending request, then claim'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.updated_by IS DISTINCT FROM NEW.approved_by THEN
      RAISE EXCEPTION 'claiming a saas normalization request requires the approver as the acting user; record the approver as updated_by when claiming'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.lease_token IS NULL OR NEW.lease_expires_at IS NULL OR NEW.lease_expires_at <= now() THEN
      RAISE EXCEPTION 'claiming a saas normalization request needs a fresh lease token with a future expiry; generate a token and claim again'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.attempt_count <> OLD.attempt_count + 1 THEN
      RAISE EXCEPTION 'claiming a saas normalization request opens attempt %; set attempt_count accordingly', OLD.attempt_count + 1
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.result IS NOT NULL OR NEW.failure IS NOT NULL OR NEW.remedy IS NOT NULL THEN
      RAISE EXCEPTION 'a claimed saas normalization request carries no outcome yet; finalize after work completes'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.last_heartbeat_at := now();
    NEW.updated_at := now();
    INSERT INTO public.audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
    VALUES (NEW.org_id, 'saas_metrics_normalization_requests', NEW.id, 'saas_normalization_claimed',
      jsonb_build_object('event', 'saas_normalization_claimed', 'requestId', NEW.id,
        'month', NEW.month, 'attempt', NEW.attempt_count,
        'statusBefore', OLD.status, 'statusAfter', NEW.status,
        'priorLeaseDigest', prior_digest, 'newLeaseDigest', new_digest,
        'progressBefore', OLD.progress, 'progressAfter', NEW.progress,
        'actor', NEW.updated_by, 'reason', NEW.reason),
      NEW.updated_by, NEW.idempotency_key::text);
    RETURN NEW;
  END IF;

  IF OLD.status = 'pending' AND NEW.status = 'cancelled' THEN
    IF NEW.updated_by IS DISTINCT FROM OLD.requested_by THEN
      RAISE EXCEPTION 'cancelling a pending saas normalization request requires the requester as the acting user; record the requester as updated_by when cancelling'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.lease_token IS NOT NULL OR NEW.lease_expires_at IS NOT NULL THEN
      RAISE EXCEPTION 'cancelling an unclaimed saas normalization request takes no lease; cancel without lease fields'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.result IS NOT NULL OR NEW.failure IS NOT NULL OR NEW.remedy IS NOT NULL THEN
      RAISE EXCEPTION 'a cancelled saas normalization request carries no outcome; clear result, failure and remedy'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.updated_at := now();
    INSERT INTO public.audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
    VALUES (NEW.org_id, 'saas_metrics_normalization_requests', NEW.id, 'saas_normalization_cancelled',
      jsonb_build_object('event', 'saas_normalization_cancelled', 'requestId', NEW.id,
        'month', NEW.month, 'attempt', NEW.attempt_count,
        'statusBefore', OLD.status, 'statusAfter', NEW.status,
        'priorLeaseDigest', prior_digest, 'newLeaseDigest', new_digest,
        'actor', NEW.updated_by, 'reason', NEW.reason),
      NEW.updated_by, NEW.idempotency_key::text);
    RETURN NEW;
  END IF;

  -- Running to running: either a live heartbeat under the live token, or a
  -- stale reacquisition after expiry. Heartbeats manufacture no audit event.
  IF OLD.status = 'running' AND NEW.status = 'running' THEN
    IF NEW.lease_token IS DISTINCT FROM OLD.lease_token THEN
      IF OLD.lease_expires_at IS NULL OR OLD.lease_expires_at > now() THEN
        RAISE EXCEPTION 'saas normalization lease is still live; heartbeat with the live token, or wait for expiry and reacquire'
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.updated_by IS DISTINCT FROM OLD.approved_by THEN
        RAISE EXCEPTION 'reacquiring a saas normalization request requires the approver as the acting user; record the approver as updated_by when reacquiring'
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.lease_token IS NULL OR NEW.lease_expires_at IS NULL OR NEW.lease_expires_at <= now() THEN
        RAISE EXCEPTION 'reacquiring a saas normalization request needs a fresh lease token with a future expiry; generate a token and reacquire'
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.attempt_count <> OLD.attempt_count + 1 THEN
        RAISE EXCEPTION 'reacquiring a saas normalization request opens attempt %; set attempt_count accordingly', OLD.attempt_count + 1
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.result IS NOT NULL OR NEW.failure IS NOT NULL OR NEW.remedy IS NOT NULL THEN
        RAISE EXCEPTION 'a reacquired saas normalization request carries no outcome yet; finalize after work completes'
          USING ERRCODE = 'check_violation';
      END IF;
      NEW.last_heartbeat_at := now();
      NEW.updated_at := now();
      INSERT INTO public.audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
      VALUES (NEW.org_id, 'saas_metrics_normalization_requests', NEW.id, 'saas_normalization_abandoned',
        jsonb_build_object('event', 'saas_normalization_abandoned', 'requestId', NEW.id,
          'month', NEW.month, 'attempt', OLD.attempt_count,
          'statusBefore', OLD.status, 'statusAfter', NEW.status,
          'priorLeaseDigest', prior_digest, 'newLeaseDigest', new_digest,
          'progressBefore', OLD.progress, 'progressAfter', NEW.progress,
          'actor', NEW.updated_by, 'reason', NEW.reason),
        NEW.updated_by, NEW.idempotency_key::text),
        (NEW.org_id, 'saas_metrics_normalization_requests', NEW.id, 'saas_normalization_reacquired',
        jsonb_build_object('event', 'saas_normalization_reacquired', 'requestId', NEW.id,
          'month', NEW.month, 'attempt', NEW.attempt_count,
          'statusBefore', OLD.status, 'statusAfter', NEW.status,
          'priorLeaseDigest', prior_digest, 'newLeaseDigest', new_digest,
          'progressBefore', OLD.progress, 'progressAfter', NEW.progress,
          'actor', NEW.updated_by, 'reason', NEW.reason),
        NEW.updated_by, NEW.idempotency_key::text);
      RETURN NEW;
    END IF;
    IF OLD.lease_expires_at IS NULL OR OLD.lease_expires_at <= now() THEN
      RAISE EXCEPTION 'saas normalization lease has expired; reacquire with a fresh token before further heartbeats'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.updated_by IS DISTINCT FROM OLD.approved_by THEN
      RAISE EXCEPTION 'saas normalization heartbeat requires the approver as the acting user; record the approver as updated_by when heartbeating'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.attempt_count <> OLD.attempt_count THEN
      RAISE EXCEPTION 'heartbeats open no new attempts; keep attempt_count at % or reacquire after expiry', OLD.attempt_count
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.lease_expires_at < OLD.lease_expires_at THEN
      RAISE EXCEPTION 'heartbeats may extend the saas normalization lease expiry, never shorten it'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.result IS NOT NULL OR NEW.failure IS NOT NULL OR NEW.remedy IS NOT NULL THEN
      RAISE EXCEPTION 'running saas normalization requests carry progress only; finalize to record an outcome'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.last_heartbeat_at := now();
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  -- Finalization under the live lease token: exactly one terminal event.
  IF OLD.status = 'running' AND NEW.status IN ('succeeded', 'failed') THEN
    IF NOT live THEN
      RAISE EXCEPTION 'finalizing a saas normalization request requires the live lease token; heartbeat or reacquire first, then finalize'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.updated_by IS DISTINCT FROM OLD.approved_by THEN
      RAISE EXCEPTION 'finalizing a saas normalization request requires the approver as the acting user; record the approver as updated_by when finalizing'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.attempt_count <> OLD.attempt_count THEN
      RAISE EXCEPTION 'finalization closes the current attempt; keep attempt_count at %', OLD.attempt_count
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status = 'succeeded' THEN
      IF NEW.result IS NULL THEN
        RAISE EXCEPTION 'a succeeded saas normalization must store its result; include the result document'
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.failure IS NOT NULL OR NEW.remedy IS NOT NULL THEN
        RAISE EXCEPTION 'a succeeded saas normalization carries a result, not a failure; clear failure and remedy'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      IF NEW.failure IS NULL OR btrim(NEW.failure) = '' THEN
        RAISE EXCEPTION 'a failed saas normalization must name the failure; describe what went wrong'
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.remedy IS NULL OR btrim(NEW.remedy) = '' THEN
        RAISE EXCEPTION 'a failed saas normalization must name the remedy; record how the operator recovers'
          USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.result IS NOT NULL THEN
        RAISE EXCEPTION 'a failed saas normalization carries failure and remedy, not a result; clear the result'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    NEW.lease_token := NULL;
    NEW.lease_expires_at := NULL;
    NEW.last_heartbeat_at := now();
    NEW.updated_at := now();
    INSERT INTO public.audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
    VALUES (NEW.org_id, 'saas_metrics_normalization_requests', NEW.id,
      CASE WHEN NEW.status = 'succeeded' THEN 'saas_normalization_succeeded' ELSE 'saas_normalization_failed' END,
      jsonb_build_object('event', CASE WHEN NEW.status = 'succeeded' THEN 'saas_normalization_succeeded' ELSE 'saas_normalization_failed' END,
        'requestId', NEW.id, 'month', NEW.month, 'attempt', NEW.attempt_count,
        'statusBefore', OLD.status, 'statusAfter', NEW.status,
        'priorLeaseDigest', prior_digest, 'newLeaseDigest', new_digest,
        'progressBefore', OLD.progress, 'progressAfter', NEW.progress,
        'actor', NEW.updated_by, 'reason', NEW.reason),
      NEW.updated_by, NEW.idempotency_key::text);
    RETURN NEW;
  END IF;

  IF OLD.status = 'running' AND NEW.status = 'cancelled' THEN
    IF NOT live THEN
      RAISE EXCEPTION 'cancelling a running saas normalization request requires the live lease token; heartbeat or reacquire first'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.updated_by IS DISTINCT FROM OLD.approved_by THEN
      RAISE EXCEPTION 'cancelling a running saas normalization request requires the approver as the acting user; record the approver as updated_by when cancelling'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.result IS NOT NULL OR NEW.failure IS NOT NULL OR NEW.remedy IS NOT NULL THEN
      RAISE EXCEPTION 'a cancelled saas normalization request carries no outcome; clear result, failure and remedy'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.lease_token := NULL;
    NEW.lease_expires_at := NULL;
    NEW.updated_at := now();
    INSERT INTO public.audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
    VALUES (NEW.org_id, 'saas_metrics_normalization_requests', NEW.id, 'saas_normalization_cancelled',
      jsonb_build_object('event', 'saas_normalization_cancelled', 'requestId', NEW.id,
        'month', NEW.month, 'attempt', NEW.attempt_count,
        'statusBefore', OLD.status, 'statusAfter', NEW.status,
        'priorLeaseDigest', prior_digest, 'newLeaseDigest', new_digest,
        'actor', NEW.updated_by, 'reason', NEW.reason),
      NEW.updated_by, NEW.idempotency_key::text);
    RETURN NEW;
  END IF;

  -- Retry from failure re-enters the lifecycle with a fresh live lease.
  IF OLD.status = 'failed' AND NEW.status = 'running' THEN
    IF NEW.updated_by IS DISTINCT FROM OLD.approved_by THEN
      RAISE EXCEPTION 'retrying a failed saas normalization request requires the approver as the acting user; record the approver as updated_by when retrying'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.lease_token IS NULL OR NEW.lease_expires_at IS NULL OR NEW.lease_expires_at <= now() THEN
      RAISE EXCEPTION 'retrying a failed saas normalization request needs a fresh lease token with a future expiry; generate a token and retry'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.attempt_count <> OLD.attempt_count + 1 THEN
      RAISE EXCEPTION 'retrying a failed saas normalization request opens attempt %; set attempt_count accordingly', OLD.attempt_count + 1
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.result IS NOT NULL OR NEW.failure IS NOT NULL OR NEW.remedy IS NOT NULL THEN
      RAISE EXCEPTION 'a retried saas normalization request starts clear; clear result, failure and remedy'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.last_heartbeat_at := now();
    NEW.updated_at := now();
    INSERT INTO public.audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
    VALUES (NEW.org_id, 'saas_metrics_normalization_requests', NEW.id, 'saas_normalization_retried',
      jsonb_build_object('event', 'saas_normalization_retried', 'requestId', NEW.id,
        'month', NEW.month, 'attempt', NEW.attempt_count,
        'statusBefore', OLD.status, 'statusAfter', NEW.status,
        'priorLeaseDigest', prior_digest, 'newLeaseDigest', new_digest,
        'progressBefore', OLD.progress, 'progressAfter', NEW.progress,
        'actor', NEW.updated_by, 'reason', NEW.reason),
      NEW.updated_by, NEW.idempotency_key::text);
    RETURN NEW;
  END IF;

  IF OLD.status = 'failed' AND NEW.status = 'cancelled' THEN
    IF NEW.updated_by IS DISTINCT FROM OLD.approved_by THEN
      RAISE EXCEPTION 'cancelling a failed saas normalization request requires the approver as the acting user; record the approver as updated_by when cancelling'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.result IS NOT NULL OR NEW.failure IS NOT NULL OR NEW.remedy IS NOT NULL THEN
      RAISE EXCEPTION 'a cancelled saas normalization request carries no outcome; clear result, failure and remedy'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.updated_at := now();
    INSERT INTO public.audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
    VALUES (NEW.org_id, 'saas_metrics_normalization_requests', NEW.id, 'saas_normalization_cancelled',
      jsonb_build_object('event', 'saas_normalization_cancelled', 'requestId', NEW.id,
        'month', NEW.month, 'attempt', NEW.attempt_count,
        'statusBefore', OLD.status, 'statusAfter', NEW.status,
        'priorLeaseDigest', prior_digest, 'newLeaseDigest', new_digest,
        'actor', NEW.updated_by, 'reason', NEW.reason),
      NEW.updated_by, NEW.idempotency_key::text);
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'saas normalization requests move pending to running to succeeded, failed or cancelled, and failed may retry to running; % to % is not a legal transition', OLD.status, NEW.status
    USING ERRCODE = 'check_violation';
END
$fn$;

CREATE TRIGGER saas_metrics_normalization_requests_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.saas_metrics_normalization_requests
  FOR EACH ROW EXECUTE FUNCTION public.saas_metrics_normalization_request_guard();

-- The catalog's unique relation key makes this registration safely replayable.
INSERT INTO openbooks_query_catalog_relations (relation, added_in)
VALUES
  ('saas_metrics_fx_evidence', '0455_saas_metrics_normalization_evidence'),
  ('saas_metrics_normalization_requests', '0455_saas_metrics_normalization_evidence')
ON CONFLICT (relation) DO NOTHING; -- expected on replay: bootstrap reapplies reviewed migrations idempotently
SELECT openbooks_refresh_query_catalog();

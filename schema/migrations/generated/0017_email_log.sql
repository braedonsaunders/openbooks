-- Email delivery log — every message the worker dispatches (scheduled reports,
-- test sends). Org-scoped; the sealed provider secret lives in orgs.settings.
CREATE TABLE IF NOT EXISTS email_log (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL,
  job_id text,
  provider_message_id text,
  provider text,
  recipients jsonb NOT NULL DEFAULT '[]'::jsonb,
  recipient_primary text,
  from_addr text,
  reply_to_addr text,
  subject text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  category_key text,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  sent_at timestamptz,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);
CREATE INDEX IF NOT EXISTS email_log_org ON email_log (org_id, created_at);
CREATE INDEX IF NOT EXISTS email_log_status ON email_log (org_id, status, created_at);
CREATE INDEX IF NOT EXISTS email_log_job ON email_log (job_id);

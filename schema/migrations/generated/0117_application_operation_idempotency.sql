BEGIN;

CREATE TABLE application_idempotency_keys (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('api', 'mcp', 'assistant')),
  operation text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  response jsonb,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  CONSTRAINT application_idempotency_key_format CHECK (
    length(idempotency_key) BETWEEN 8 AND 200
    AND idempotency_key ~ '^[A-Za-z0-9._:-]+$'
  ),
  CONSTRAINT application_idempotency_operation_format CHECK (
    operation ~ '^[a-z][a-z0-9_.-]{2,99}$'
  ),
  CONSTRAINT application_idempotency_completion_shape CHECK (
    (completed_at IS NULL AND response IS NULL)
    OR (completed_at IS NOT NULL AND response IS NOT NULL)
  )
);

CREATE UNIQUE INDEX application_idempotency_identity
  ON application_idempotency_keys
    (org_id, actor_id, source, operation, idempotency_key);
CREATE INDEX application_idempotency_expiry
  ON application_idempotency_keys (expires_at);

ALTER TABLE application_idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE application_idempotency_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON application_idempotency_keys
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR org_id::text = current_setting('app.current_org', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR org_id::text = current_setting('app.current_org', true)
  );

CREATE OR REPLACE FUNCTION validate_application_idempotency_actor()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM users
     WHERE id = NEW.actor_id AND org_id = NEW.org_id
  ) THEN
    RAISE EXCEPTION 'application operation actor must belong to the organization';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER application_idempotency_actor_guard
BEFORE INSERT ON application_idempotency_keys
FOR EACH ROW EXECUTE FUNCTION validate_application_idempotency_actor();

CREATE OR REPLACE FUNCTION protect_application_idempotency_key()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.expires_at <= now()
       OR current_setting('app.bypass_rls', true) = 'on' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'unexpired application idempotency evidence cannot be deleted';
  END IF;

  IF OLD.completed_at IS NULL
     AND NEW.completed_at IS NOT NULL
     AND NEW.response IS NOT NULL
     AND NEW.org_id = OLD.org_id
     AND NEW.actor_id = OLD.actor_id
     AND NEW.source = OLD.source
     AND NEW.operation = OLD.operation
     AND NEW.idempotency_key = OLD.idempotency_key
     AND NEW.request_hash = OLD.request_hash
     AND NEW.created_at = OLD.created_at
     AND NEW.expires_at = OLD.expires_at THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'application idempotency evidence is immutable after creation';
END;
$$;

CREATE TRIGGER application_idempotency_guard
BEFORE UPDATE OR DELETE ON application_idempotency_keys
FOR EACH ROW EXECUTE FUNCTION protect_application_idempotency_key();

COMMIT;

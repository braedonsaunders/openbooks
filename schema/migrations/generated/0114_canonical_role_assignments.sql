BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM users u
     WHERE u.is_active
       AND NOT EXISTS (
         SELECT 1
           FROM role_assignments assignment
          WHERE assignment.org_id = u.org_id
            AND assignment.user_id = u.id
       )
  ) THEN
    RAISE EXCEPTION 'every active user must have an explicit role assignment before the IAM cutover';
  END IF;
END;
$$;

ALTER TABLE users DROP COLUMN role;

CREATE OR REPLACE FUNCTION assert_active_user_has_role(
  checked_user_id uuid,
  checked_org_id uuid
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM users u
     WHERE u.id = checked_user_id
       AND u.org_id = checked_org_id
       AND u.is_active
       AND NOT EXISTS (
         SELECT 1
           FROM role_assignments assignment
          WHERE assignment.user_id = u.id
            AND assignment.org_id = u.org_id
       )
  ) THEN
    RAISE EXCEPTION 'active user % must have at least one explicit role assignment', checked_user_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_user_active_role_assignment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM assert_active_user_has_role(NEW.id, NEW.org_id);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_deleted_role_assignment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM assert_active_user_has_role(OLD.user_id, OLD.org_id);
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER users_active_role_assignment_guard
AFTER INSERT OR UPDATE OF is_active, org_id ON users
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_user_active_role_assignment();

CREATE CONSTRAINT TRIGGER role_assignments_active_user_guard
AFTER DELETE ON role_assignments
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_deleted_role_assignment();

COMMIT;

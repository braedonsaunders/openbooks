-- OpenBooks forward migration 0096_active_user_role_serialization.
-- Preserve existing users and assignments; enforce the invariant on new writes.
CREATE OR REPLACE FUNCTION public.assert_active_user_has_role(
  checked_user_id uuid,
  checked_org_id uuid
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE active boolean;
BEGIN
  -- Serialize activation and assignment removal on the same identity row.
  SELECT u.is_active INTO active
    FROM public.users u
   WHERE u.id = checked_user_id AND u.org_id = checked_org_id
   FOR UPDATE;
  IF active IS DISTINCT FROM true THEN
    RETURN;
  END IF;

  -- A locking read also refuses a surviving assignment deleted since a
  -- repeatable-read snapshot, instead of treating stale history as access.
  PERFORM a.id
    FROM public.role_assignments a
   WHERE a.user_id = checked_user_id AND a.org_id = checked_org_id
   ORDER BY a.id
   LIMIT 1 FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active user % must have at least one explicit role assignment', checked_user_id
      USING ERRCODE = '23514', CONSTRAINT = 'active_user_role_required';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_deleted_role_assignment() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND
     ROW(OLD.user_id, OLD.org_id) IS NOT DISTINCT FROM ROW(NEW.user_id, NEW.org_id) THEN
    RETURN NULL;
  END IF;
  PERFORM public.assert_active_user_has_role(OLD.user_id, OLD.org_id);
  RETURN NULL;
END;
$$;

DROP TRIGGER role_assignments_active_user_guard ON public.role_assignments;
CREATE CONSTRAINT TRIGGER role_assignments_active_user_guard
  AFTER DELETE OR UPDATE ON public.role_assignments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION public.enforce_deleted_role_assignment();

SELECT public.openbooks_refresh_query_catalog();

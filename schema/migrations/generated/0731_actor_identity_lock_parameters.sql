-- Lock cross-organization actor identities through typed parameters without changing caller authority.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

CREATE FUNCTION public.lock_actor_home_identity(p_org uuid, p_actor uuid, p_home uuid)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_catalog AS $$
DECLARE
  original_scope text := current_setting('app.current_org', true);
  target_member boolean;
  locked public.users%rowtype;
BEGIN
  IF p_org IS NULL OR original_scope IS DISTINCT FROM p_org::text OR p_actor IS NULL OR p_home IS NULL THEN
    RAISE EXCEPTION 'Actor command tenant scope does not match its organization';
  END IF;
  PERFORM a.id FROM public.role_assignments a
    JOIN public.app_roles r ON r.org_id=a.org_id AND r.id=a.role_id
    WHERE a.org_id=p_org AND a.user_id=p_actor
    ORDER BY a.id FOR SHARE OF a,r;
  target_member := FOUND;
  BEGIN
    PERFORM set_config('app.current_org', p_home::text, true);
    SELECT u.* INTO locked FROM public.users u
      WHERE u.id=p_actor AND u.org_id=p_home FOR SHARE;
    IF NOT FOUND OR NOT locked.is_active OR (NOT locked.is_super_admin AND NOT target_member) THEN
      RAISE EXCEPTION 'Actor is not eligible to command this organization';
    END IF;
    PERFORM set_config('app.current_org', original_scope, true);
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.current_org', original_scope, true);
    RAISE;
  END;
END;
$$;
COMMENT ON FUNCTION public.lock_actor_home_identity(uuid,uuid,uuid) IS
  'Invoker-only actor and membership share locks retained by the caller transaction; tenant scope is restored before returning.';

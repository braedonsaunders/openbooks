-- OpenBooks forward migration 0655_self_service_baseline_grants.
--
-- Custom roles created before the employee self-service baseline predate
-- the default, so hourly workers holding only a custom role are refused
-- self-service ("missing permission: hrm.self.request"). Every built-in
-- role already carries the baseline (hrm.self.read, hrm.self.request,
-- hrm.leave.request). This backfill grants the baseline to custom roles
-- that hold no self-service grant at all and whose holders need it —
-- at least one active holder linked to a party with an employment
-- record. Roles holding any self-service grant (or a wildcard covering
-- it) keep exactly what they have; built-in roles are untouched.
-- app_roles carries no opt-out marker, so every qualifying role is
-- granted; per-holder deny overrides keep denying after the union, so no
-- deliberate per-person exclusion widens. Each widened role records its
-- own audit_log row (before/after permissions plus this reason).

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

WITH candidates AS (
  SELECT r.id, r.org_id, r.permissions AS before_permissions
    FROM app_roles r
   WHERE NOT r.is_built_in
     AND NOT (r.permissions ? 'hrm.self.read'
              OR r.permissions ? 'hrm.self.request'
              OR r.permissions ? 'hrm.leave.request'
              OR r.permissions ? '*'
              OR r.permissions ? 'hrm.*')
     AND EXISTS (
       SELECT 1
         FROM role_assignments ra
         JOIN users u
           ON u.org_id = ra.org_id AND u.id = ra.user_id
         JOIN worker_employments e
           ON e.org_id = u.org_id AND e.worker_party_id = u.party_id
        WHERE ra.role_id = r.id
          AND ra.org_id = r.org_id
          AND u.is_active
     )
),
changed AS (
  UPDATE app_roles r
     SET permissions = r.permissions || '["hrm.self.read", "hrm.self.request", "hrm.leave.request"]'::jsonb,
         updated_at = now()
    FROM candidates c
   WHERE r.id = c.id
  RETURNING r.org_id, r.id, c.before_permissions, r.permissions AS after_permissions
)
INSERT INTO audit_log (org_id, table_name, row_id, action, changes, actor_id)
SELECT org_id, 'app_roles', id, 'update',
       jsonb_build_object(
         'before', jsonb_build_object('permissions', before_permissions),
         'after', jsonb_build_object('permissions', after_permissions),
         'reason', 'Employee self-service baseline backfill: custom role with employee holders and no self-service grant gains hrm.self.read, hrm.self.request and hrm.leave.request'
       ), NULL
  FROM changed;

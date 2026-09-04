-- OpenBooks forward migration 0087_charge_rate_fraction_evidence
-- Widen display quantities without changing retained historical money. Exact
-- package fractions are additive evidence; NULL identifies legacy components.
-- PostgreSQL cannot widen a column while a view depends on it. Preserve the
-- governed projection, owner, options, grants and comments in this transaction.
-- DROP has no CASCADE: unexpected downstream views stop the migration safely.
DO $migration$
DECLARE
  saved_view record;
  item record;
  saved_acl jsonb;
  saved_columns jsonb;
  principal text;
BEGIN
  SELECT c.oid, pg_get_viewdef(c.oid, true) AS definition,
         pg_get_userbyid(c.relowner) AS owner_name, c.reloptions,
         obj_description(c.oid, 'pg_class') AS description
    INTO saved_view FROM pg_class c
   WHERE c.oid = to_regclass('openbooks_query.charge_rate_components')
     AND c.relkind = 'v';
  IF saved_view.oid IS NOT NULL THEN
    SELECT jsonb_agg(jsonb_build_object(
      'grantee', CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END,
      'privilege', a.privilege_type, 'grantable', a.is_grantable))
      INTO saved_acl FROM pg_class c,
        LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
     WHERE c.oid = saved_view.oid;
    SELECT jsonb_agg(jsonb_build_object(
      'name', attname, 'description', col_description(attrelid, attnum),
      'acl', (SELECT jsonb_agg(jsonb_build_object(
        'grantee', CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END,
        'privilege', a.privilege_type, 'grantable', a.is_grantable))
        FROM aclexplode(attacl) a)))
      INTO saved_columns FROM pg_attribute
     WHERE attrelid = saved_view.oid AND attnum > 0 AND NOT attisdropped;
    DROP VIEW openbooks_query.charge_rate_components;
  END IF;
  ALTER TABLE public.charge_rate_components ALTER COLUMN quantity TYPE numeric(28,8);
  IF saved_view.oid IS NOT NULL THEN
    EXECUTE format('CREATE VIEW openbooks_query.charge_rate_components %s AS %s',
      CASE WHEN saved_view.reloptions IS NULL THEN ''
           ELSE 'WITH (' || array_to_string(saved_view.reloptions, ', ') || ')' END,
      saved_view.definition);
    EXECUTE format('ALTER VIEW openbooks_query.charge_rate_components OWNER TO %I', saved_view.owner_name);
    -- Remove migration-role default grants before restoring the original ACL.
    FOR principal IN
      SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END
        FROM pg_class c, LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
       WHERE c.oid = 'openbooks_query.charge_rate_components'::regclass
    LOOP
      EXECUTE format('REVOKE ALL ON openbooks_query.charge_rate_components FROM %s', principal);
    END LOOP;
    FOR item IN SELECT * FROM jsonb_to_recordset(saved_acl)
      AS x(grantee text, privilege text, grantable boolean)
    LOOP
      EXECUTE format('GRANT %s ON openbooks_query.charge_rate_components TO %s%s',
        item.privilege, item.grantee, CASE WHEN item.grantable THEN ' WITH GRANT OPTION' ELSE '' END);
    END LOOP;
    EXECUTE format('COMMENT ON VIEW openbooks_query.charge_rate_components IS %L', saved_view.description);
    FOR item IN SELECT * FROM jsonb_to_recordset(saved_columns)
      AS x(name text, description text, acl jsonb)
    LOOP
      EXECUTE format('COMMENT ON COLUMN openbooks_query.charge_rate_components.%I IS %L', item.name, item.description);
      FOR principal IN SELECT format('GRANT %s (%I) ON openbooks_query.charge_rate_components TO %s%s',
        a.privilege, item.name, a.grantee, CASE WHEN a.grantable THEN ' WITH GRANT OPTION' ELSE '' END)
        FROM jsonb_to_recordset(item.acl) AS a(grantee text, privilege text, grantable boolean)
      LOOP
        EXECUTE principal;
      END LOOP;
    END LOOP;
  END IF;
END
$migration$;
ALTER TABLE charge_rate_components ADD COLUMN IF NOT EXISTS quantity_ratio jsonb;
ALTER TABLE charge_rate_components DROP CONSTRAINT IF EXISTS charge_rate_fraction_shape;
ALTER TABLE charge_rate_components ADD CONSTRAINT charge_rate_fraction_shape CHECK (
  quantity_ratio IS NULL OR coalesce((
    jsonb_typeof(quantity_ratio) = 'object'
    AND jsonb_typeof(quantity_ratio->'numerator') = 'string'
    AND jsonb_typeof(quantity_ratio->'denominator') = 'string'
    AND quantity_ratio->>'numerator' ~ '^[1-9][0-9]*$'
    AND quantity_ratio->>'denominator' ~ '^[1-9][0-9]*$'
    AND quantity_ratio ? 'numerator' AND quantity_ratio ? 'denominator'
  ), false)
);

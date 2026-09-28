-- OpenBooks upgrade preflight for 0458_mfg_scrap_frozen_snapshot.
-- Catalog-only probes against the pre-0458 catalog: the seven snapshot
-- column names must be absent from mfg_scrap_events, every object name 0458
-- creates must be unused on its own intended table and schema (a same-named
-- object on another table or schema does not block), the supporting column
-- types must exist, the lots/serials tables must expose org_id/id anchors
-- for the tenant-safe parent keys, and the financial_changes domain check
-- the migration extends must be discoverable by shape (never assumed by
-- name). Legacy all-null snapshot rows never block: they are normalized
-- later by a controlled restatement proposal, never by this upgrade.
SELECT '0458.snapshot_column_present' AS code,
       'refuse' AS severity,
       format('mfg_scrap_events already carries column %s', a.attname) AS subject,
       'the frozen-snapshot column is already present before 0458' AS detail,
       'Restore the pre-0458 catalog by dropping the stray column before retrying the upgrade.' AS remedy
  FROM pg_attribute a
  JOIN pg_class t ON t.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
 WHERE n.nspname = 'public'
   AND t.relname = 'mfg_scrap_events'
   AND a.attname IN ('treatment', 'frozen_value', 'frozen_unit_cost', 'lot_id', 'serial_id', 'plan_fingerprint', 'approval_required')
   AND NOT a.attisdropped
UNION ALL
SELECT '0458.snapshot_object_present' AS code,
       'refuse' AS severity,
       format('schema object name %s is already taken', wanted.name) AS subject,
       'a constraint, index, trigger, or function already uses a name 0458 must create' AS detail,
       'Restore the pre-0458 catalog by renaming or dropping the conflicting object before retrying the upgrade.' AS remedy
  FROM (VALUES
    ('constraint', 'lots', 'lots_org_id_id_uniq'),
    ('constraint', 'serials', 'serials_org_id_id_uniq'),
    ('constraint', 'mfg_scrap_events', 'mfg_scrap_events_org_lot_fk'),
    ('constraint', 'mfg_scrap_events', 'mfg_scrap_events_org_serial_fk'),
    ('constraint', 'mfg_scrap_events', 'mfg_scrap_snapshot_legacy_or_complete_chk'),
    ('constraint', 'mfg_scrap_events', 'mfg_scrap_snapshot_evidence_chk'),
    ('constraint', 'mfg_scrap_events', 'mfg_scrap_snapshot_pre_issue_chk'),
    ('constraint', 'mfg_scrap_events', 'mfg_scrap_snapshot_post_issue_chk'),
    ('constraint', 'mfg_scrap_events', 'mfg_scrap_snapshot_operation_chk'),
    ('index', NULL, 'mfg_scrap_events_org_lot_idx'),
    ('index', NULL, 'mfg_scrap_events_org_serial_idx'),
    ('index', NULL, 'financial_changes_manufacturing_live_proposal_uniq'),
    ('trigger', 'mfg_scrap_events', 'mfg_scrap_snapshot_immutable_trg'),
    ('function', NULL, 'mfg_scrap_snapshot_immutable_guard')
  ) AS wanted(kind, relname, name)
 WHERE (wanted.kind = 'constraint' AND EXISTS (
          SELECT 1
            FROM pg_constraint c
            JOIN pg_class t ON t.oid = c.conrelid
            JOIN pg_namespace n ON n.oid = t.relnamespace
           WHERE n.nspname = 'public'
             AND t.relname = wanted.relname
             AND c.conname = wanted.name))
    OR (wanted.kind = 'index' AND EXISTS (
          SELECT 1
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public'
             AND c.relname = wanted.name))
    OR (wanted.kind = 'trigger' AND EXISTS (
          SELECT 1
            FROM pg_trigger g
            JOIN pg_class t ON t.oid = g.tgrelid
            JOIN pg_namespace n ON n.oid = t.relnamespace
           WHERE n.nspname = 'public'
             AND t.relname = wanted.relname
             AND g.tgname = wanted.name))
    OR (wanted.kind = 'function' AND EXISTS (
          SELECT 1
            FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public'
             AND p.proname = wanted.name
             AND p.pronargs = 0))
UNION ALL
SELECT '0458.snapshot_type_missing' AS code,
       'refuse' AS severity,
       format('column type %s is missing', need.typname) AS subject,
       'a column type the frozen snapshot relies on is absent' AS detail,
       'Restore the standard type before retrying the upgrade.' AS remedy
  FROM (VALUES ('numeric'), ('text'), ('uuid'), ('bool')) AS need(typname)
 WHERE NOT EXISTS (SELECT 1 FROM pg_type t WHERE t.typname = need.typname)
UNION ALL
SELECT '0458.snapshot_parent_unready' AS code,
       'refuse' AS severity,
       format('table %s lacks the org_id/id anchor', parent.relname) AS subject,
       'the frozen lot/serial lineage needs a tenant-safe parent key' AS detail,
       'Restore the table with org_id and id columns before retrying the upgrade.' AS remedy
  FROM (VALUES ('lots'), ('serials')) AS parent(relname)
 WHERE NOT EXISTS (
   SELECT 1
     FROM pg_class t
     JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = parent.relname
      AND t.relkind IN ('r', 'p')
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = t.oid AND a.attname = 'org_id' AND NOT a.attisdropped)
      AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = t.oid AND a.attname = 'id' AND NOT a.attisdropped))
UNION ALL
SELECT '0458.snapshot_domain_check_unknown' AS code,
       'refuse' AS severity,
       'financial_changes domain check' AS subject,
       'the ledger guard 0458 must extend is not discoverable by shape' AS detail,
       'Restore the financial_changes domain check carrying the lease, revenue, asset, and consolidation domains before retrying the upgrade.' AS remedy
 WHERE NOT EXISTS (
   SELECT 1
     FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'financial_changes'
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) LIKE '%lease%revenue%asset%consolidation%');

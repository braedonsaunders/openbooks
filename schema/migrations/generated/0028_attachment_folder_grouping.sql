-- File Cabinet performance + information architecture.
--
-- Problem: per-record attachment folders were created flat under each org's
-- "Attachments" root — one per attached record. In busy tenants this is tens of
-- thousands of sibling folders, which the cabinet loaded and rendered on every
-- page and every flyout. This migration (a) adds the indexes the list/search
-- paths need and (b) tucks the per-record folders under a kind group folder
-- (Attachments / <Group> / <record>) so the home screen and sidebar stay small.
--
-- Runs inside the bootstrap transaction (see scripts/bootstrap.ts), so no
-- CREATE INDEX CONCURRENTLY. The row backfill is DML on RLS-protected tables and
-- therefore sets app.bypass_rls for the duration of this transaction.

-- --- indexes ---------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Leading-wildcard ILIKE search on file names (files.name ilike '%q%') — a btree
-- can't serve this; a trigram GIN index turns it from a full scan into an index scan.
CREATE INDEX IF NOT EXISTS files_name_trgm ON files USING gin (name gin_trgm_ops);

-- Folder-scoped listing ordered by name / created_at (the cabinet's default sorts),
-- so the list is an index-ordered scan rather than a scan + sort.
CREATE INDEX IF NOT EXISTS files_folder_name ON files (org_id, folder_id, name);
CREATE INDEX IF NOT EXISTS files_folder_created ON files (org_id, folder_id, created_at);

-- Child-folder listing ordered by name (the main-pane folder rows).
CREATE INDEX IF NOT EXISTS folders_parent_name ON folders (org_id, parent_folder_id, name);

-- --- backfill: nest flat per-record folders under kind group folders --------

SET LOCAL app.bypass_rls = 'on';

-- 1. Create one kind group folder per (org, document kind) for the record
--    folders currently sitting flat under the Attachments root.
INSERT INTO folders (org_id, parent_folder_id, name, is_system, record_table, created_at, updated_at)
SELECT DISTINCT rf.org_id, root.id, initcap(replace(d.kind, '_', ' ')), true, 'documents', now(), now()
  FROM folders rf
  JOIN documents d ON d.id = rf.record_id
  JOIN folders root
    ON root.org_id = rf.org_id AND root.system_kind = 'attachments' AND root.parent_folder_id IS NULL
 WHERE rf.record_id IS NOT NULL
   AND rf.record_table = 'documents'
   AND rf.parent_folder_id = root.id
   AND NOT EXISTS (
     SELECT 1 FROM folders g
      WHERE g.org_id = rf.org_id AND g.parent_folder_id = root.id
        AND g.record_id IS NULL AND g.name = initcap(replace(d.kind, '_', ' '))
   );

-- 2. Re-parent each flat document record folder under its kind group folder.
UPDATE folders rf
   SET parent_folder_id = g.id, updated_at = now()
  FROM documents d, folders g, folders root
 WHERE rf.record_id = d.id
   AND rf.record_table = 'documents'
   AND rf.record_id IS NOT NULL
   AND root.org_id = rf.org_id AND root.system_kind = 'attachments' AND root.parent_folder_id IS NULL
   AND rf.parent_folder_id = root.id
   AND g.org_id = rf.org_id AND g.parent_folder_id = root.id
   AND g.record_id IS NULL AND g.name = initcap(replace(d.kind, '_', ' '));

-- 3. Fallback for any remaining flat leaf folders (orphaned document rows, or
--    non-'documents' record tables): group by the titleized record table name.
INSERT INTO folders (org_id, parent_folder_id, name, is_system, record_table, created_at, updated_at)
SELECT DISTINCT rf.org_id, root.id, initcap(replace(rf.record_table, '_', ' ')), true, rf.record_table, now(), now()
  FROM folders rf
  JOIN folders root
    ON root.org_id = rf.org_id AND root.system_kind = 'attachments' AND root.parent_folder_id IS NULL
 WHERE rf.record_id IS NOT NULL
   AND rf.parent_folder_id = root.id
   AND NOT EXISTS (
     SELECT 1 FROM folders g
      WHERE g.org_id = rf.org_id AND g.parent_folder_id = root.id
        AND g.record_id IS NULL AND g.name = initcap(replace(rf.record_table, '_', ' '))
   );

UPDATE folders rf
   SET parent_folder_id = g.id, updated_at = now()
  FROM folders g, folders root
 WHERE rf.record_id IS NOT NULL
   AND root.org_id = rf.org_id AND root.system_kind = 'attachments' AND root.parent_folder_id IS NULL
   AND rf.parent_folder_id = root.id
   AND g.org_id = rf.org_id AND g.parent_folder_id = root.id
   AND g.record_id IS NULL AND g.name = initcap(replace(rf.record_table, '_', ' '));

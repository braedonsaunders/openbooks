-- Global search: trigram (pg_trgm) indexes for fast, typo-tolerant matching
-- across the primary searchable entities. The extension create is best-effort
-- (a role without privilege degrades search to plain ILIKE substring matching
-- rather than failing the whole bootstrap), and the trigram indexes are only
-- created when the extension is actually present.

do $$
begin
  create extension if not exists pg_trgm;
exception when insufficient_privilege then
  raise notice 'pg_trgm unavailable to this role; global search falls back to substring matching';
end$$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_trgm') then
    create index if not exists idx_parties_display_name_trgm on parties using gin (display_name gin_trgm_ops);
    create index if not exists idx_parties_legal_name_trgm  on parties using gin (legal_name gin_trgm_ops);
    create index if not exists idx_parties_email_trgm       on parties using gin (email gin_trgm_ops);

    create index if not exists idx_documents_number_trgm    on documents using gin (document_number gin_trgm_ops);
    create index if not exists idx_documents_reference_trgm on documents using gin (reference_number gin_trgm_ops);
    create index if not exists idx_documents_memo_trgm      on documents using gin (memo gin_trgm_ops);

    create index if not exists idx_accounts_name_trgm       on accounts using gin (name gin_trgm_ops);
    create index if not exists idx_accounts_number_trgm     on accounts using gin (number gin_trgm_ops);

    create index if not exists idx_items_name_trgm          on items using gin (name gin_trgm_ops);
    create index if not exists idx_items_code_trgm          on items using gin (code gin_trgm_ops);

    create index if not exists idx_projects_name_trgm       on projects using gin (name gin_trgm_ops);
    create index if not exists idx_projects_code_trgm       on projects using gin (code gin_trgm_ops);
  end if;
end$$;

-- Amount lookups ("1500" → transactions that have a line of that amount).
-- Amounts live on document_lines (documents.total is often derived/zero), so the
-- amount index goes there.
create index if not exists idx_document_lines_amount on document_lines (amount);

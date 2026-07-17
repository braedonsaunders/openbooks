-- Subsidiaries: NetSuite OneWorld-style legal entities INSIDE a tenant.
-- The org stays the sealed tenant (RLS boundary); subsidiaries become a
-- first-class field on transactions, entities, accounts and dimensions, with
-- role-scoped visibility and consolidated reporting. Cutover: every org gets
-- one root subsidiary seeded from its own name/currency/country, and all
-- existing ledger rows backfill to it — a single-subsidiary org is unchanged.
set local app.bypass_rls = 'on';
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 1. New tables
-- ---------------------------------------------------------------------------
CREATE TABLE "subsidiaries" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"legal_name" text,
	"base_currency" text NOT NULL,
	"country" text NOT NULL,
	"tax_ids" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_elimination" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"custom" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE UNIQUE INDEX "subsidiaries_org_name" ON "subsidiaries" USING btree ("org_id","name");
--> statement-breakpoint
CREATE UNIQUE INDEX "subsidiaries_org_root" ON "subsidiaries" USING btree ("org_id") WHERE "parent_id" IS NULL;
--> statement-breakpoint
CREATE INDEX "subsidiaries_org_parent" ON "subsidiaries" USING btree ("org_id","parent_id");
--> statement-breakpoint

CREATE TABLE "party_subsidiaries" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"subsidiary_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE UNIQUE INDEX "party_subsidiaries_party_sub" ON "party_subsidiaries" USING btree ("party_id","subsidiary_id");
--> statement-breakpoint
CREATE INDEX "party_subsidiaries_org" ON "party_subsidiaries" USING btree ("org_id");
--> statement-breakpoint

CREATE TABLE "consolidated_fx_rates" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"from_currency" text NOT NULL,
	"to_currency" text NOT NULL,
	"current_rate" numeric(19, 10) NOT NULL,
	"average_rate" numeric(19, 10) NOT NULL,
	"historical_rate" numeric(19, 10) NOT NULL,
	"source" text DEFAULT 'derived' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE UNIQUE INDEX "consolidated_fx_period_pair" ON "consolidated_fx_rates" USING btree ("org_id","period_id","from_currency","to_currency");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. intercompany_pairs: rebuilt from org refs to subsidiary refs.
--    The table was aspirational — no runtime code ever wrote or read it.
-- ---------------------------------------------------------------------------
DROP TABLE "intercompany_pairs";
--> statement-breakpoint
CREATE TABLE "intercompany_pairs" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"from_subsidiary_id" uuid NOT NULL,
	"to_subsidiary_id" uuid NOT NULL,
	"due_from_account_id" uuid NOT NULL,
	"due_to_account_id" uuid NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE UNIQUE INDEX "intercompany_subsidiary_pair" ON "intercompany_pairs" USING btree ("from_subsidiary_id","to_subsidiary_id");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. orgs: legal-entity columns superseded by subsidiaries
-- ---------------------------------------------------------------------------
ALTER TABLE "orgs" DROP COLUMN IF EXISTS "parent_id";
--> statement-breakpoint
ALTER TABLE "orgs" DROP COLUMN IF EXISTS "is_elimination";
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. subsidiary columns across the model
-- ---------------------------------------------------------------------------
ALTER TABLE "accounts" ADD COLUMN "subsidiary_id" uuid;
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "subsidiary_include_children" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "departments" ADD COLUMN "subsidiary_id" uuid;
--> statement-breakpoint
ALTER TABLE "departments" ADD COLUMN "subsidiary_include_children" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "subsidiary_id" uuid;
--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "subsidiary_include_children" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "classes" ADD COLUMN "subsidiary_id" uuid;
--> statement-breakpoint
ALTER TABLE "classes" ADD COLUMN "subsidiary_include_children" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "subsidiary_id" uuid;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "subsidiary_include_children" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "subsidiary_id" uuid;
--> statement-breakpoint
ALTER TABLE "app_roles" ADD COLUMN "subsidiary_restriction" jsonb DEFAULT '{"mode":"all"}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "number_sequences" ADD COLUMN "subsidiary_id" uuid;
--> statement-breakpoint
DROP INDEX IF EXISTS "sequences_org_kind";
--> statement-breakpoint
ALTER TABLE "number_sequences" ADD CONSTRAINT "sequences_org_kind_sub" UNIQUE NULLS NOT DISTINCT ("org_id","document_kind","subsidiary_id");
--> statement-breakpoint
-- IF NOT EXISTS: a dev database picked these four up ahead of the migration.
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "subsidiary_id" uuid;
--> statement-breakpoint
ALTER TABLE "document_lines" ADD COLUMN IF NOT EXISTS "subsidiary_id" uuid;
--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN IF NOT EXISTS "subsidiary_id" uuid;
--> statement-breakpoint
ALTER TABLE "journal_lines" ADD COLUMN IF NOT EXISTS "subsidiary_id" uuid;
--> statement-breakpoint
CREATE INDEX "jl_org_sub_account" ON "journal_lines" USING btree ("org_id","subsidiary_id","account_id");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. Cutover backfill: one root subsidiary per org (production AND sandbox —
--    each is its own tenant), then point every ledger row and document at it.
--    Ledger guards are disabled for the backfill: stamping subsidiary_id on
--    posted history is the migration itself, not an amendment.
-- ---------------------------------------------------------------------------
INSERT INTO subsidiaries (org_id, parent_id, name, legal_name, base_currency, country, tax_ids)
SELECT o.id, NULL, o.name, o.legal_name, o.base_currency, o.country, coalesce(o.tax_ids, '{}'::jsonb)
FROM orgs o;
--> statement-breakpoint
ALTER TABLE journal_entries DISABLE TRIGGER je_guard;
--> statement-breakpoint
ALTER TABLE journal_lines DISABLE TRIGGER jl_guard;
--> statement-breakpoint
ALTER TABLE journal_lines DISABLE TRIGGER jl_balanced;
--> statement-breakpoint
ALTER TABLE journal_lines DISABLE TRIGGER jl_check_account;
--> statement-breakpoint
UPDATE journal_entries e SET subsidiary_id = s.id
FROM subsidiaries s WHERE s.org_id = e.org_id AND s.parent_id IS NULL;
--> statement-breakpoint
UPDATE journal_lines l SET subsidiary_id = s.id
FROM subsidiaries s WHERE s.org_id = l.org_id AND s.parent_id IS NULL;
--> statement-breakpoint
UPDATE documents d SET subsidiary_id = s.id
FROM subsidiaries s WHERE s.org_id = d.org_id AND s.parent_id IS NULL;
--> statement-breakpoint
ALTER TABLE journal_entries ALTER COLUMN subsidiary_id SET NOT NULL;
--> statement-breakpoint
ALTER TABLE journal_lines ALTER COLUMN subsidiary_id SET NOT NULL;
--> statement-breakpoint
ALTER TABLE journal_entries ENABLE TRIGGER je_guard;
--> statement-breakpoint
ALTER TABLE journal_lines ENABLE TRIGGER jl_guard;
--> statement-breakpoint
ALTER TABLE journal_lines ENABLE TRIGGER jl_balanced;
--> statement-breakpoint
ALTER TABLE journal_lines ENABLE TRIGGER jl_check_account;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 6. Kernel invariant: every legal entity's books balance on their own.
--    SUM(amount) = 0 per (entry, subsidiary) — the due-to/due-from legs of an
--    intercompany entry are what make this hold. Strictly stronger than the
--    whole-entry balance check (which it subsumes but keeps for defense).
-- ---------------------------------------------------------------------------
create or replace function jl_check_balanced_by_subsidiary() returns trigger
language plpgsql as $$
declare
  v_entry uuid;
  v_bad record;
begin
  v_entry := coalesce(new.entry_id, old.entry_id);
  select subsidiary_id, sum(amount) as total into v_bad
    from journal_lines where entry_id = v_entry
   group by subsidiary_id having sum(amount) <> 0 limit 1;
  if found then
    raise exception 'journal entry % does not balance for subsidiary % (sum = %)',
      v_entry, v_bad.subsidiary_id, v_bad.total using errcode = '23514';
  end if;
  return null;
end $$;
--> statement-breakpoint
create constraint trigger jl_balanced_by_subsidiary
  after insert or update or delete on journal_lines
  deferrable initially deferred
  for each row execute function jl_check_balanced_by_subsidiary();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 7. Referential integrity (new tables/columns; the tracked
--    referential-integrity.sql never re-runs on existing databases)
-- ---------------------------------------------------------------------------
alter table subsidiaries
  add foreign key (org_id) references orgs(id) on delete cascade,
  add foreign key (parent_id) references subsidiaries(id);
--> statement-breakpoint
alter table party_subsidiaries
  add foreign key (org_id) references orgs(id) on delete cascade,
  add foreign key (party_id) references parties(id) on delete cascade,
  add foreign key (subsidiary_id) references subsidiaries(id);
--> statement-breakpoint
alter table consolidated_fx_rates
  add foreign key (org_id) references orgs(id) on delete cascade,
  add foreign key (period_id) references accounting_periods(id);
--> statement-breakpoint
alter table intercompany_pairs
  add foreign key (org_id) references orgs(id) on delete cascade,
  add foreign key (from_subsidiary_id) references subsidiaries(id),
  add foreign key (to_subsidiary_id) references subsidiaries(id),
  add foreign key (due_from_account_id) references accounts(id),
  add foreign key (due_to_account_id) references accounts(id);
--> statement-breakpoint
alter table accounts add foreign key (subsidiary_id) references subsidiaries(id);
--> statement-breakpoint
alter table departments add foreign key (subsidiary_id) references subsidiaries(id);
--> statement-breakpoint
alter table locations add foreign key (subsidiary_id) references subsidiaries(id);
--> statement-breakpoint
alter table classes add foreign key (subsidiary_id) references subsidiaries(id);
--> statement-breakpoint
alter table projects add foreign key (subsidiary_id) references subsidiaries(id);
--> statement-breakpoint
alter table parties add foreign key (subsidiary_id) references subsidiaries(id);
--> statement-breakpoint
alter table number_sequences add foreign key (subsidiary_id) references subsidiaries(id);
--> statement-breakpoint
alter table documents add foreign key (subsidiary_id) references subsidiaries(id);
--> statement-breakpoint
alter table document_lines add foreign key (subsidiary_id) references subsidiaries(id);
--> statement-breakpoint
alter table journal_entries add foreign key (subsidiary_id) references subsidiaries(id);
--> statement-breakpoint
alter table journal_lines add foreign key (subsidiary_id) references subsidiaries(id);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 8. RLS + read grants for the new tables (environments.sql's org_isolation
--    loop covers them on a re-run; inline here so a plain bootstrap is enough.
--    intercompany_pairs lost its policy with the DROP above.)
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['subsidiaries', 'party_subsidiaries', 'consolidated_fx_rates', 'intercompany_pairs'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$
      create policy org_isolation on %I
        using (current_setting('app.bypass_rls', true) = 'on'
               or org_id::text = current_setting('app.current_org', true))
        with check (current_setting('app.bypass_rls', true) = 'on'
               or org_id::text = current_setting('app.current_org', true))
    $p$, t);
  end loop;
  if exists (select 1 from pg_roles where rolname = 'openbooks_read') then
    grant select on subsidiaries, party_subsidiaries, consolidated_fx_rates, intercompany_pairs to openbooks_read;
  end if;
end $$;

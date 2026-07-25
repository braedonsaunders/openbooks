-- A commercial adjustment presented as its own invoice line needs a real item
-- so the charge lands on a revenue account and picks up the right tax code.
alter table "labor_rate_adjustments" add column if not exists "item_id" uuid;
create index if not exists "labor_rate_adjustments_item" on "labor_rate_adjustments" ("org_id", "item_id");

-- A charge's SOURCE — billable time versus a cost document — is the predicate a
-- surcharge usually needs, and it holds no matter how a tenant classifies its
-- items (labor is commonly catalogued as a service item, not kind 'labor').
alter table "labor_rate_adjustment_targets" drop constraint if exists "labor_rate_adjustment_targets_type";
alter table "labor_rate_adjustment_targets" add constraint "labor_rate_adjustment_targets_type" check (target_type in (
  'labor', 'material', 'item', 'item_kind', 'item_category', 'transaction_type', 'department',
  'subsidiary', 'location', 'class', 'trade', 'job_title', 'project', 'customer', 'other'
));

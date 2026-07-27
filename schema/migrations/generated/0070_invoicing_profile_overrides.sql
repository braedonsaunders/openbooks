-- Invoicing is agreed with a CUSTOMER and is sometimes specific to one PROJECT.
-- Without somewhere to narrow it, tenants clone a project type per customer just
-- to change how an invoice reads. These layer over the project type's profile.
alter table "parties" add column if not exists "invoicing_profile" jsonb;
alter table "projects" add column if not exists "invoicing_profile" jsonb;

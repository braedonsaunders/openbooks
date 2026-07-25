-- Subcontractor compliance: certificates of insurance, lien waivers, and
-- year-end information returns (1099-NEC / 1099-MISC / T4A).
--
-- Policy-first: compliance_classes say what kind of counterparty a vendor is,
-- compliance_requirements are the individual enforced policies, and
-- compliance_records hold the evidence. Enforcement of a payment release is
-- evaluated as-of the decision and then frozen into compliance_release_checks,
-- so tightening a policy later never reinterprets a release granted earlier.
--
-- Certificate FILES are not stored here: they live in the File Cabinet and link
-- through file_attachments (target_table = 'compliance_records').

-- ---------------------------------------------------------------------------
-- Policy configuration
-- ---------------------------------------------------------------------------

create table if not exists compliance_classes (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null,
  code text not null,
  name text not null,
  description text,
  lien_waiver_enforcement text not null default 'none',
  default_lien_waiver_type text,
  default_information_return text not null default 'none',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint compliance_classes_lien_enforcement
    check (lien_waiver_enforcement in ('none','warn','block')),
  constraint compliance_classes_waiver_type
    check (default_lien_waiver_type is null or default_lien_waiver_type in (
      'conditional_progress','unconditional_progress','conditional_final','unconditional_final')),
  constraint compliance_classes_information_return
    check (default_information_return in ('none','1099-NEC','1099-MISC','T4A')),
  -- A class that blocks payment on a missing waiver must say which form to ask for.
  constraint compliance_classes_waiver_type_required
    check (lien_waiver_enforcement = 'none' or default_lien_waiver_type is not null)
);
create unique index if not exists compliance_classes_org_code
  on compliance_classes(org_id, code);

create table if not exists compliance_requirements (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null,
  code text not null,
  name text not null,
  category text not null default 'insurance',
  class_id uuid,
  requires_expiry boolean not null default true,
  min_coverage_amount numeric(19,4),
  min_aggregate_amount numeric(19,4),
  coverage_currency text,
  requires_additional_insured boolean not null default false,
  requires_waiver_of_subrogation boolean not null default false,
  requires_primary_noncontributory boolean not null default false,
  enforcement text not null default 'warn',
  grace_days integer not null default 0,
  expiry_warning_days integer not null default 30,
  requires_verification boolean not null default true,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint compliance_requirements_category
    check (category in ('insurance','tax_form','licence','bond','safety','other')),
  constraint compliance_requirements_enforcement
    check (enforcement in ('advisory','warn','block_payment','block_bill')),
  constraint compliance_requirements_grace check (grace_days between 0 and 365),
  constraint compliance_requirements_warning check (expiry_warning_days between 0 and 365),
  constraint compliance_requirements_min_coverage
    check (min_coverage_amount is null or min_coverage_amount > 0),
  constraint compliance_requirements_min_aggregate
    check (min_aggregate_amount is null or min_aggregate_amount > 0),
  -- A coverage minimum is a money amount: it needs a currency to be comparable.
  constraint compliance_requirements_coverage_currency
    check ((min_coverage_amount is null and min_aggregate_amount is null)
           or coverage_currency is not null)
);
create unique index if not exists compliance_requirements_org_code
  on compliance_requirements(org_id, code);
create index if not exists compliance_requirements_org_class
  on compliance_requirements(org_id, class_id);

-- ---------------------------------------------------------------------------
-- Evidence
-- ---------------------------------------------------------------------------

create table if not exists compliance_records (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null,
  party_id uuid not null,
  requirement_id uuid not null,
  project_id uuid,
  status text not null default 'pending_review',
  issuer_name text,
  policy_number text,
  effective_from date not null,
  expires_on date,
  coverage_amount numeric(19,4),
  aggregate_amount numeric(19,4),
  coverage_currency text,
  additional_insured boolean not null default false,
  waiver_of_subrogation boolean not null default false,
  primary_noncontributory boolean not null default false,
  verified_at timestamptz,
  verified_by uuid,
  rejected_reason text,
  superseded_by_id uuid,
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint compliance_records_status
    check (status in ('pending_review','active','rejected','superseded')),
  constraint compliance_records_window
    check (expires_on is null or expires_on >= effective_from),
  constraint compliance_records_coverage
    check (coverage_amount is null or coverage_amount >= 0),
  constraint compliance_records_aggregate
    check (aggregate_amount is null or aggregate_amount >= 0),
  -- A rejection has to say why; an active certificate cannot carry one.
  constraint compliance_records_rejected_reason
    check ((status = 'rejected') = (rejected_reason is not null)),
  -- Verification is a person + a moment, or neither.
  constraint compliance_records_verification
    check ((verified_at is null) = (verified_by is null))
);
create index if not exists compliance_records_party
  on compliance_records(org_id, party_id, requirement_id);
create index if not exists compliance_records_expiry
  on compliance_records(org_id, expires_on);
create index if not exists compliance_records_project
  on compliance_records(org_id, project_id);
-- The hot path: current evidence for one vendor's requirement.
create index if not exists compliance_records_active
  on compliance_records(org_id, party_id, requirement_id, expires_on desc)
  where status = 'active';

create table if not exists compliance_waivers (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null,
  party_id uuid not null,
  requirement_id uuid not null,
  project_id uuid,
  reason text not null,
  effective_from date not null,
  expires_on date not null,
  approved_at timestamptz not null default now(),
  approved_by uuid,
  revoked_at timestamptz,
  revoked_by uuid,
  revoke_reason text,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint compliance_waivers_window check (expires_on >= effective_from),
  constraint compliance_waivers_reason check (length(btrim(reason)) > 0),
  -- Revocation is an event with an actor and a reason, or it did not happen.
  constraint compliance_waivers_revocation
    check ((revoked_at is null) = (revoke_reason is null))
);
create index if not exists compliance_waivers_party
  on compliance_waivers(org_id, party_id, requirement_id);
create index if not exists compliance_waivers_window
  on compliance_waivers(org_id, expires_on);

create table if not exists compliance_release_checks (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null,
  party_id uuid not null,
  document_id uuid,
  payment_run_id uuid,
  payment_instruction_id uuid,
  stage text not null,
  decision text not null,
  snapshot jsonb not null default '{}'::jsonb,
  override_reason text,
  overridden_by uuid,
  checked_at timestamptz not null default now(),
  checked_by uuid,
  constraint compliance_release_checks_stage
    check (stage in ('run_created','readiness','run_posted','manual')),
  constraint compliance_release_checks_decision
    check (decision in ('cleared','warned','blocked','overridden')),
  -- An override names the person who accepted the risk and the reason.
  constraint compliance_release_checks_override
    check ((decision = 'overridden') = (override_reason is not null and overridden_by is not null))
);
create index if not exists compliance_release_checks_party
  on compliance_release_checks(org_id, party_id, checked_at desc);
create index if not exists compliance_release_checks_run
  on compliance_release_checks(org_id, payment_run_id);
create index if not exists compliance_release_checks_document
  on compliance_release_checks(org_id, document_id);

-- ---------------------------------------------------------------------------
-- Lien waivers
-- ---------------------------------------------------------------------------

create table if not exists lien_waivers (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null,
  waiver_number text not null,
  direction text not null,
  party_id uuid not null,
  project_id uuid not null,
  waiver_type text not null,
  status text not null default 'draft',
  through_date date not null,
  amount numeric(19,4) not null default 0,
  currency text not null,
  jurisdiction text,
  bill_document_id uuid,
  payment_document_id uuid,
  pay_application_id uuid,
  requested_at timestamptz,
  requested_by uuid,
  signed_by_name text,
  signed_by_title text,
  signed_at timestamptz,
  signature jsonb,
  notarized boolean not null default false,
  rejected_reason text,
  void_reason text,
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint lien_waivers_direction check (direction in ('received','issued')),
  constraint lien_waivers_type check (waiver_type in (
    'conditional_progress','unconditional_progress','conditional_final','unconditional_final')),
  constraint lien_waivers_status check (status in (
    'draft','requested','received','signed','rejected','void')),
  constraint lien_waivers_amount check (amount >= 0),
  -- A signed waiver is the thing payment relies on: it must name a signatory
  -- and a moment. Nothing else may carry a signature timestamp.
  constraint lien_waivers_signature
    check (status <> 'signed' or (signed_at is not null and length(btrim(coalesce(signed_by_name,''))) > 0)),
  constraint lien_waivers_rejected_reason
    check ((status = 'rejected') = (rejected_reason is not null)),
  constraint lien_waivers_void_reason
    check ((status = 'void') = (void_reason is not null))
);
create unique index if not exists lien_waivers_org_number
  on lien_waivers(org_id, waiver_number);
create index if not exists lien_waivers_party
  on lien_waivers(org_id, party_id, through_date desc);
create index if not exists lien_waivers_project
  on lien_waivers(org_id, project_id, status);
create index if not exists lien_waivers_bill
  on lien_waivers(org_id, bill_document_id);
-- The payment control's lookup: signed coverage for one vendor.
create index if not exists lien_waivers_signed_coverage
  on lien_waivers(org_id, party_id, project_id, through_date desc)
  where status = 'signed' and direction = 'received';

-- ---------------------------------------------------------------------------
-- Information returns
-- ---------------------------------------------------------------------------

create table if not exists information_return_box_rules (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null,
  form_type text not null,
  box text not null,
  account_id uuid not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint information_return_box_rules_form
    check (form_type in ('1099-NEC','1099-MISC','T4A'))
);
-- One account routes to at most one box per form: no ambiguous mapping.
create unique index if not exists information_return_box_rules_unique
  on information_return_box_rules(org_id, form_type, account_id);
create index if not exists information_return_box_rules_form_box
  on information_return_box_rules(org_id, form_type, box);

create table if not exists information_return_filings (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null,
  tax_year integer not null,
  form_type text not null,
  subsidiary_id uuid,
  status text not null default 'draft',
  threshold numeric(19,4) not null default 600,
  currency text not null,
  payer_snapshot jsonb not null default '{}'::jsonb,
  computed_at timestamptz,
  computed_by uuid,
  finalized_at timestamptz,
  finalized_by uuid,
  filed_at timestamptz,
  filed_by uuid,
  filing_channel text,
  filing_reference text,
  void_reason text,
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint information_return_filings_form
    check (form_type in ('1099-NEC','1099-MISC','T4A')),
  constraint information_return_filings_status
    check (status in ('draft','computed','finalized','filed','void')),
  constraint information_return_filings_year check (tax_year between 1990 and 2200),
  constraint information_return_filings_threshold check (threshold >= 0),
  constraint information_return_filings_channel
    check (filing_channel is null or filing_channel in ('iris','fire','paper','provider','other')),
  -- Finalize freezes the payer identification that gets transmitted.
  constraint information_return_filings_finalized
    check (status not in ('finalized','filed') or (finalized_at is not null and payer_snapshot <> '{}'::jsonb)),
  constraint information_return_filings_filed
    check ((status = 'filed') = (filed_at is not null)),
  constraint information_return_filings_void_reason
    check ((status = 'void') = (void_reason is not null))
);
-- One filing per year/form/entity. The partial-index pair covers the NULL
-- subsidiary (org root), which a plain unique index would not de-duplicate.
create unique index if not exists information_return_filings_unique_sub
  on information_return_filings(org_id, tax_year, form_type, subsidiary_id)
  where subsidiary_id is not null;
create unique index if not exists information_return_filings_unique_root
  on information_return_filings(org_id, tax_year, form_type)
  where subsidiary_id is null;
create index if not exists information_return_filings_org
  on information_return_filings(org_id, tax_year);

create table if not exists information_return_recipients (
  id uuid primary key default uuid_generate_v7(),
  org_id uuid not null,
  filing_id uuid not null,
  party_id uuid not null,
  recipient_snapshot jsonb not null default '{}'::jsonb,
  tin_last4 text,
  tin_type text,
  computed_amounts jsonb not null default '{}'::jsonb,
  adjustments jsonb not null default '{}'::jsonb,
  adjustment_reason text,
  tax_withheld numeric(19,4) not null default 0,
  state_withholding jsonb not null default '{}'::jsonb,
  status text not null default 'included',
  exclusion_reason text,
  corrected_from_id uuid,
  printed_at timestamptz,
  furnished_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint information_return_recipients_status
    check (status in ('included','excluded','corrected','void')),
  constraint information_return_recipients_tin_type
    check (tin_type is null or tin_type in ('ssn','ein','itin','atin','sin','bn','unknown')),
  constraint information_return_recipients_tin_last4
    check (tin_last4 is null or tin_last4 ~ '^[0-9]{4}$'),
  constraint information_return_recipients_withheld check (tax_withheld >= 0),
  -- Excluding a recipient from a statutory filing requires a stated reason.
  constraint information_return_recipients_exclusion
    check ((status = 'excluded') = (exclusion_reason is not null)),
  -- A manual change to a filed figure must say why.
  constraint information_return_recipients_adjustment
    check (adjustments = '{}'::jsonb or adjustment_reason is not null)
);
create unique index if not exists information_return_recipients_unique
  on information_return_recipients(filing_id, party_id);
create index if not exists information_return_recipients_filing
  on information_return_recipients(org_id, filing_id, status);
create index if not exists information_return_recipients_party
  on information_return_recipients(org_id, party_id);

-- ---------------------------------------------------------------------------
-- Vendor role: classification and taxpayer identification
-- ---------------------------------------------------------------------------

alter table vendor_roles
  add column if not exists compliance_class_id uuid,
  add column if not exists information_return_form text,
  add column if not exists information_return_box text,
  add column if not exists tax_classification text,
  add column if not exists tin_encrypted text,
  add column if not exists tin_last4 text,
  add column if not exists tin_type text,
  add column if not exists backup_withholding boolean not null default false;

alter table vendor_roles
  drop constraint if exists vendor_roles_information_return_form,
  drop constraint if exists vendor_roles_tax_classification,
  drop constraint if exists vendor_roles_tin_type,
  drop constraint if exists vendor_roles_tin_last4;
alter table vendor_roles
  add constraint vendor_roles_information_return_form
    check (information_return_form is null
           or information_return_form in ('none','1099-NEC','1099-MISC','T4A')),
  add constraint vendor_roles_tax_classification
    check (tax_classification is null or tax_classification in (
      'individual','sole_proprietor','partnership','c_corp','s_corp','llc',
      'trust_estate','government','nonprofit','other')),
  add constraint vendor_roles_tin_type
    check (tin_type is null or tin_type in ('ssn','ein','itin','atin','sin','bn','unknown')),
  add constraint vendor_roles_tin_last4
    check (tin_last4 is null or tin_last4 ~ '^[0-9]{4}$');

create index if not exists vendor_roles_compliance_class
  on vendor_roles(org_id, compliance_class_id);

-- ---------------------------------------------------------------------------
-- Referential integrity
--
-- Every constraint is dropped-if-exists first so the whole file stays
-- re-runnable alongside its `create table if not exists` statements.
-- ---------------------------------------------------------------------------

alter table compliance_classes
  drop constraint if exists compliance_classes_org_fk;
alter table compliance_requirements
  drop constraint if exists compliance_requirements_org_fk,
  drop constraint if exists compliance_requirements_class_fk;
alter table compliance_records
  drop constraint if exists compliance_records_org_fk,
  drop constraint if exists compliance_records_party_fk,
  drop constraint if exists compliance_records_requirement_fk,
  drop constraint if exists compliance_records_project_fk,
  drop constraint if exists compliance_records_superseded_fk,
  drop constraint if exists compliance_records_verified_by_fk;
alter table compliance_waivers
  drop constraint if exists compliance_waivers_org_fk,
  drop constraint if exists compliance_waivers_party_fk,
  drop constraint if exists compliance_waivers_requirement_fk,
  drop constraint if exists compliance_waivers_project_fk,
  drop constraint if exists compliance_waivers_approved_by_fk,
  drop constraint if exists compliance_waivers_revoked_by_fk;
alter table compliance_release_checks
  drop constraint if exists compliance_release_checks_org_fk,
  drop constraint if exists compliance_release_checks_party_fk,
  drop constraint if exists compliance_release_checks_document_fk,
  drop constraint if exists compliance_release_checks_run_fk,
  drop constraint if exists compliance_release_checks_instruction_fk,
  drop constraint if exists compliance_release_checks_checked_by_fk,
  drop constraint if exists compliance_release_checks_overridden_by_fk;
alter table lien_waivers
  drop constraint if exists lien_waivers_org_fk,
  drop constraint if exists lien_waivers_party_fk,
  drop constraint if exists lien_waivers_project_fk,
  drop constraint if exists lien_waivers_bill_fk,
  drop constraint if exists lien_waivers_payment_fk,
  drop constraint if exists lien_waivers_pay_application_fk;
alter table information_return_box_rules
  drop constraint if exists information_return_box_rules_org_fk,
  drop constraint if exists information_return_box_rules_account_fk;
alter table information_return_filings
  drop constraint if exists information_return_filings_org_fk,
  drop constraint if exists information_return_filings_subsidiary_fk;
alter table information_return_recipients
  drop constraint if exists information_return_recipients_org_fk,
  drop constraint if exists information_return_recipients_filing_fk,
  drop constraint if exists information_return_recipients_party_fk,
  drop constraint if exists information_return_recipients_corrected_fk;

alter table compliance_classes
  add constraint compliance_classes_org_fk foreign key (org_id) references orgs(id);

alter table compliance_requirements
  add constraint compliance_requirements_org_fk foreign key (org_id) references orgs(id),
  -- Deleting a class would silently re-scope its policies to every vendor.
  add constraint compliance_requirements_class_fk foreign key (class_id)
    references compliance_classes(id) on delete restrict;

alter table compliance_records
  add constraint compliance_records_org_fk foreign key (org_id) references orgs(id),
  add constraint compliance_records_party_fk foreign key (party_id) references parties(id),
  add constraint compliance_records_requirement_fk foreign key (requirement_id)
    references compliance_requirements(id) on delete restrict,
  add constraint compliance_records_project_fk foreign key (project_id)
    references projects(id) on delete set null,
  add constraint compliance_records_superseded_fk foreign key (superseded_by_id)
    references compliance_records(id) on delete set null,
  add constraint compliance_records_verified_by_fk foreign key (verified_by)
    references users(id) on delete set null;

alter table compliance_waivers
  add constraint compliance_waivers_org_fk foreign key (org_id) references orgs(id),
  add constraint compliance_waivers_party_fk foreign key (party_id) references parties(id),
  add constraint compliance_waivers_requirement_fk foreign key (requirement_id)
    references compliance_requirements(id) on delete restrict,
  add constraint compliance_waivers_project_fk foreign key (project_id)
    references projects(id) on delete set null,
  add constraint compliance_waivers_approved_by_fk foreign key (approved_by)
    references users(id) on delete set null,
  add constraint compliance_waivers_revoked_by_fk foreign key (revoked_by)
    references users(id) on delete set null;

alter table compliance_release_checks
  add constraint compliance_release_checks_org_fk foreign key (org_id) references orgs(id),
  add constraint compliance_release_checks_party_fk foreign key (party_id) references parties(id),
  add constraint compliance_release_checks_document_fk foreign key (document_id)
    references documents(id) on delete set null,
  add constraint compliance_release_checks_run_fk foreign key (payment_run_id)
    references payment_runs(id) on delete set null,
  add constraint compliance_release_checks_instruction_fk foreign key (payment_instruction_id)
    references payment_instructions(id) on delete set null,
  add constraint compliance_release_checks_checked_by_fk foreign key (checked_by)
    references users(id) on delete set null,
  add constraint compliance_release_checks_overridden_by_fk foreign key (overridden_by)
    references users(id) on delete set null;

alter table lien_waivers
  add constraint lien_waivers_org_fk foreign key (org_id) references orgs(id),
  add constraint lien_waivers_party_fk foreign key (party_id) references parties(id),
  add constraint lien_waivers_project_fk foreign key (project_id) references projects(id),
  add constraint lien_waivers_bill_fk foreign key (bill_document_id)
    references documents(id) on delete set null,
  add constraint lien_waivers_payment_fk foreign key (payment_document_id)
    references documents(id) on delete set null,
  add constraint lien_waivers_pay_application_fk foreign key (pay_application_id)
    references pay_applications(id) on delete set null;

alter table information_return_box_rules
  add constraint information_return_box_rules_org_fk foreign key (org_id) references orgs(id),
  add constraint information_return_box_rules_account_fk foreign key (account_id)
    references accounts(id) on delete restrict;

alter table information_return_filings
  add constraint information_return_filings_org_fk foreign key (org_id) references orgs(id),
  add constraint information_return_filings_subsidiary_fk foreign key (subsidiary_id)
    references subsidiaries(id) on delete restrict;

alter table information_return_recipients
  add constraint information_return_recipients_org_fk foreign key (org_id) references orgs(id),
  -- Recipients are the filing's content; removing the filing removes them.
  add constraint information_return_recipients_filing_fk foreign key (filing_id)
    references information_return_filings(id) on delete cascade,
  add constraint information_return_recipients_party_fk foreign key (party_id)
    references parties(id),
  add constraint information_return_recipients_corrected_fk foreign key (corrected_from_id)
    references information_return_recipients(id) on delete set null;

alter table vendor_roles
  drop constraint if exists vendor_roles_compliance_class_fk;
alter table vendor_roles
  add constraint vendor_roles_compliance_class_fk foreign key (compliance_class_id)
    references compliance_classes(id) on delete restrict;

-- ---------------------------------------------------------------------------
-- Row-level security (org isolation, identical to every other tenant table)
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'compliance_classes','compliance_requirements','compliance_records','compliance_waivers',
    'compliance_release_checks','lien_waivers','information_return_box_rules',
    'information_return_filings','information_return_recipients'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('drop policy if exists org_isolation on %I', t);
    execute format($f$
      create policy org_isolation on %I
        using (current_setting('app.bypass_rls', true) = 'on'
               or org_id::text = current_setting('app.current_org', true))
        with check (current_setting('app.bypass_rls', true) = 'on'
               or org_id::text = current_setting('app.current_org', true))
    $f$, t);
    execute format('grant select on %I to openbooks_read', t);
  end loop;
end $$;

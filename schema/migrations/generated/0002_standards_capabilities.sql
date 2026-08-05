-- Standards-conformance capabilities.
--
-- 1. accounts.monetary — IAS 21 monetary-item override so period-end FX
--    retranslation can cover foreign-currency loans and other monetary
--    balances carried outside the default bank/receivable/payable types
--    (and exclude a default-typed account that is not monetary).
-- 2. lease_agreements + lease_agreement_schedule_lines — lessee lease accounting under
--    ASC 842 / IFRS 16: liability at the present value of unpaid payments,
--    right-of-use asset at cost, interest/principal/amortization schedule,
--    US GAAP operating single-cost model, short-term/low-value elections.
-- 3. inventory_writedowns — lower-of-cost-and-NRV evidence rows (IAS 2.28-33 /
--    ASC 330-10-35): value-only remeasurement with the reversal cap under IFRS
--    and the new-cost-basis prohibition under US GAAP.
-- 4. revenue_contracts.pricing — ASC 606 step-3 evidence: variable
--    consideration estimate + constraint and significant-financing split.
--
-- Row-level security: environments.sql derives tenant policies for every base
-- table carrying org_id and is re-applied by bootstrap when catalog coverage
-- changes, so the new tables are covered automatically.

ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS monetary boolean;

COMMENT ON COLUMN public.accounts.monetary IS
  'IAS 21 monetary-item override for FX retranslation: null = infer from type (bank/receivable/payable), true = retranslate (balance-sheet types only), false = exclude.';

CREATE TABLE IF NOT EXISTS public.lease_agreements (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    subsidiary_id uuid NOT NULL,
    lease_number text NOT NULL,
    description text,
    status text DEFAULT 'draft'::text NOT NULL,
    commencement_on date NOT NULL,
    term_periods integer NOT NULL,
    payment_frequency text DEFAULT 'monthly'::text NOT NULL,
    payment_timing text DEFAULT 'arrears'::text NOT NULL,
    payment_amount numeric(19,4) NOT NULL,
    annual_discount_rate_percent numeric(19,10) NOT NULL,
    classification text DEFAULT 'finance'::text NOT NULL,
    classification_inputs jsonb DEFAULT '{}'::jsonb NOT NULL,
    exemption text,
    initial_liability numeric(19,4),
    initial_rou_asset numeric(19,4),
    rou_asset_account_id uuid NOT NULL,
    lease_liability_account_id uuid NOT NULL,
    interest_expense_account_id uuid NOT NULL,
    amortization_expense_account_id uuid NOT NULL,
    lease_expense_account_id uuid NOT NULL,
    payment_account_id uuid NOT NULL,
    department_id uuid,
    project_id uuid,
    location_id uuid,
    commencement_entry_id uuid,
    custom jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT lease_agreements_pkey PRIMARY KEY (id),
    CONSTRAINT lease_agreements_term_positive CHECK ((term_periods > 0)),
    CONSTRAINT lease_agreements_payment_positive CHECK ((payment_amount > (0)::numeric)),
    CONSTRAINT lease_agreements_rate_nonnegative CHECK ((annual_discount_rate_percent >= (0)::numeric)),
    CONSTRAINT lease_agreements_status_chk CHECK ((status = ANY (ARRAY['draft'::text, 'active'::text, 'terminated'::text, 'complete'::text]))),
    CONSTRAINT lease_agreements_frequency_chk CHECK ((payment_frequency = ANY (ARRAY['monthly'::text, 'quarterly'::text, 'annual'::text]))),
    CONSTRAINT lease_agreements_timing_chk CHECK ((payment_timing = ANY (ARRAY['arrears'::text, 'advance'::text]))),
    CONSTRAINT lease_agreements_classification_chk CHECK ((classification = ANY (ARRAY['finance'::text, 'operating'::text]))),
    CONSTRAINT lease_agreements_exemption_chk CHECK (((exemption IS NULL) OR (exemption = ANY (ARRAY['short_term'::text, 'low_value'::text]))))
);

CREATE UNIQUE INDEX IF NOT EXISTS lease_agreements_org_number ON public.lease_agreements USING btree (org_id, lease_number);
CREATE INDEX IF NOT EXISTS lease_agreements_org_status ON public.lease_agreements USING btree (org_id, status);

CREATE TABLE IF NOT EXISTS public.lease_agreement_schedule_lines (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    lease_id uuid NOT NULL,
    sequence integer NOT NULL,
    due_on date NOT NULL,
    period_start date NOT NULL,
    period_end date NOT NULL,
    opening_liability numeric(19,4) NOT NULL,
    payment numeric(19,4) NOT NULL,
    interest numeric(19,4) NOT NULL,
    principal numeric(19,4) NOT NULL,
    closing_liability numeric(19,4) NOT NULL,
    amortization numeric(19,4),
    single_cost numeric(19,4),
    rou_adjustment numeric(19,4),
    payment_entry_id uuid,
    amortization_entry_id uuid,
    posted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT lease_agreement_schedule_lines_pkey PRIMARY KEY (id)
);

CREATE UNIQUE INDEX IF NOT EXISTS lease_agreement_schedule_lease_seq ON public.lease_agreement_schedule_lines USING btree (lease_id, sequence);
CREATE INDEX IF NOT EXISTS lease_agreement_schedule_org_due ON public.lease_agreement_schedule_lines USING btree (org_id, due_on);

ALTER TABLE public.lease_agreement_schedule_lines
  ADD CONSTRAINT lease_agreement_schedule_lines_lease_fk
  FOREIGN KEY (lease_id) REFERENCES public.lease_agreements(id) ON DELETE CASCADE;

CREATE TABLE IF NOT EXISTS public.inventory_writedowns (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    org_id uuid NOT NULL,
    item_id uuid NOT NULL,
    stock_location_id uuid NOT NULL,
    subsidiary_id uuid NOT NULL,
    kind text DEFAULT 'writedown'::text NOT NULL,
    date date NOT NULL,
    quantity numeric(19,4) NOT NULL,
    previous_value numeric(19,4) NOT NULL,
    new_value numeric(19,4) NOT NULL,
    amount numeric(19,4) NOT NULL,
    reversed_amount numeric(19,4) DEFAULT 0 NOT NULL,
    reverses_writedown_id uuid,
    framework text NOT NULL,
    journal_entry_id uuid NOT NULL,
    memo text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT inventory_writedowns_pkey PRIMARY KEY (id),
    CONSTRAINT inventory_writedowns_amount_positive CHECK ((amount > (0)::numeric)),
    CONSTRAINT inventory_writedowns_reversed_bounds CHECK (((reversed_amount >= (0)::numeric) AND (reversed_amount <= amount))),
    CONSTRAINT inventory_writedowns_kind_chk CHECK ((kind = ANY (ARRAY['writedown'::text, 'reversal'::text]))),
    CONSTRAINT inventory_writedowns_framework_chk CHECK ((framework = ANY (ARRAY['us_gaap'::text, 'ifrs'::text])))
);

CREATE INDEX IF NOT EXISTS inventory_writedowns_item ON public.inventory_writedowns USING btree (org_id, item_id, stock_location_id);

ALTER TABLE public.revenue_contracts ADD COLUMN IF NOT EXISTS pricing jsonb DEFAULT '{}'::jsonb NOT NULL;

COMMENT ON COLUMN public.revenue_contracts.pricing IS
  'ASC 606 step-3 evidence: variable-consideration estimate + constraint (606-10-32-11) and significant-financing-component split (606-10-32-15). The resolved price lands in total_transaction_price.';

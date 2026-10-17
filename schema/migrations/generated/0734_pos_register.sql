-- Point-of-sale registers, drawer sessions and register transactions.
--
-- A register is configuration: the legal entity and dimension location it
-- sells under, the warehouse it relieves, the walk-in customer and price
-- level it defaults to, and the clearing accounts each accepted tender
-- settles into (a tender kind is accepted exactly when its account is set).
-- Pay-in and pay-out reasons name the account a drawer cash movement posts
-- against; quick keys are the register's favourite items.
--
-- A drawer session is one shift on one register: the counted opening float,
-- every sale, refund and cash movement rung in it, and the blind closing
-- count with its expected cash and over/short. At most one session per
-- register is open, enforced by a partial unique index. A closed session is
-- immutable, and no transaction or movement can join a session that is not
-- open. Sales and refunds are native cash_sale and cash_refund documents;
-- the register transaction row only attributes a posted document to its
-- session and keeps the cash tendered, change given and pricing evidence.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

CREATE TABLE public.pos_registers (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 code text NOT NULL,
 name text NOT NULL,
 subsidiary_id uuid NOT NULL,
 location_id uuid,
 stock_location_id uuid,
 default_customer_id uuid,
 price_level_id uuid,
 cash_account_id uuid NOT NULL,
 card_account_id uuid,
 other_account_id uuid,
 accepts_stored_value boolean NOT NULL DEFAULT false,
 receipt_header text,
 receipt_footer text,
 denominations text[] NOT NULL DEFAULT '{}'::text[],
 is_active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by uuid,
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by uuid,
 CONSTRAINT pos_registers_org_id_id_unique UNIQUE (org_id, id),
 CONSTRAINT pos_registers_code_unique UNIQUE (org_id, code),
 CONSTRAINT pos_registers_code_shape CHECK (char_length(btrim(code)) BETWEEN 1 AND 40 AND code = btrim(code)),
 CONSTRAINT pos_registers_name_shape CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
 CONSTRAINT pos_registers_receipt_text CHECK (
  (receipt_header IS NULL OR char_length(receipt_header) <= 1000)
  AND (receipt_footer IS NULL OR char_length(receipt_footer) <= 1000)
 ),
 CONSTRAINT pos_registers_denominations_shape CHECK (
  cardinality(denominations) <= 40
  AND array_to_string(denominations, ',') ~ '^([0-9]{1,9}(\.[0-9]{1,4})?(,[0-9]{1,9}(\.[0-9]{1,4})?)*)?$'
 ),
 CONSTRAINT pos_registers_subsidiary_fkey FOREIGN KEY (org_id, subsidiary_id) REFERENCES public.subsidiaries(org_id, id),
 CONSTRAINT pos_registers_location_fkey FOREIGN KEY (org_id, location_id) REFERENCES public.locations(org_id, id),
 CONSTRAINT pos_registers_stock_location_fkey FOREIGN KEY (org_id, stock_location_id) REFERENCES public.stock_locations(org_id, id),
 CONSTRAINT pos_registers_default_customer_fkey FOREIGN KEY (org_id, default_customer_id) REFERENCES public.parties(org_id, id),
 CONSTRAINT pos_registers_price_level_fkey FOREIGN KEY (org_id, price_level_id) REFERENCES public.price_levels(org_id, id),
 CONSTRAINT pos_registers_cash_account_fkey FOREIGN KEY (org_id, cash_account_id) REFERENCES public.accounts(org_id, id),
 CONSTRAINT pos_registers_card_account_fkey FOREIGN KEY (org_id, card_account_id) REFERENCES public.accounts(org_id, id),
 CONSTRAINT pos_registers_other_account_fkey FOREIGN KEY (org_id, other_account_id) REFERENCES public.accounts(org_id, id)
);
CREATE INDEX pos_registers_default_customer ON public.pos_registers (org_id, default_customer_id) WHERE default_customer_id IS NOT NULL;

CREATE TABLE public.pos_cash_reasons (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 code text NOT NULL,
 name text NOT NULL,
 direction text NOT NULL CHECK (direction IN ('pay_in', 'pay_out')),
 account_id uuid NOT NULL,
 is_active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by uuid,
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by uuid,
 CONSTRAINT pos_cash_reasons_org_id_id_unique UNIQUE (org_id, id),
 CONSTRAINT pos_cash_reasons_code_unique UNIQUE (org_id, code),
 CONSTRAINT pos_cash_reasons_code_shape CHECK (char_length(btrim(code)) BETWEEN 1 AND 40 AND code = btrim(code)),
 CONSTRAINT pos_cash_reasons_name_shape CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
 CONSTRAINT pos_cash_reasons_account_fkey FOREIGN KEY (org_id, account_id) REFERENCES public.accounts(org_id, id)
);

CREATE TABLE public.pos_quick_keys (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 register_id uuid,
 item_id uuid NOT NULL,
 position integer NOT NULL DEFAULT 0 CHECK (position BETWEEN 0 AND 999),
 label text,
 is_active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by uuid,
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by uuid,
 CONSTRAINT pos_quick_keys_org_id_id_unique UNIQUE (org_id, id),
 CONSTRAINT pos_quick_keys_label_shape CHECK (label IS NULL OR char_length(btrim(label)) BETWEEN 1 AND 60),
 CONSTRAINT pos_quick_keys_register_fkey FOREIGN KEY (org_id, register_id) REFERENCES public.pos_registers(org_id, id),
 CONSTRAINT pos_quick_keys_item_fkey FOREIGN KEY (org_id, item_id) REFERENCES public.items(org_id, id)
);
CREATE INDEX pos_quick_keys_register ON public.pos_quick_keys (org_id, register_id, position);

CREATE TABLE public.pos_sessions (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 register_id uuid NOT NULL,
 subsidiary_id uuid NOT NULL,
 session_number integer NOT NULL CHECK (session_number > 0),
 status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
 business_date date NOT NULL,
 currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
 opening_float_minor bigint NOT NULL CHECK (opening_float_minor >= 0),
 opening_count jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(opening_count) = 'array'),
 opened_at timestamptz NOT NULL DEFAULT now(),
 opened_by uuid NOT NULL,
 closed_at timestamptz,
 closed_by uuid,
 expected_cash_minor bigint,
 counted_cash_minor bigint CHECK (counted_cash_minor IS NULL OR counted_cash_minor >= 0),
 over_short_minor bigint,
 closing_count jsonb CHECK (closing_count IS NULL OR jsonb_typeof(closing_count) = 'array'),
 over_short_entry_id uuid,
 close_note text CHECK (close_note IS NULL OR char_length(close_note) <= 1000),
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by uuid,
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by uuid,
 CONSTRAINT pos_sessions_org_id_id_unique UNIQUE (org_id, id),
 CONSTRAINT pos_sessions_number_unique UNIQUE (org_id, register_id, session_number),
 CONSTRAINT pos_sessions_lifecycle CHECK (
  (status = 'open' AND closed_at IS NULL AND closed_by IS NULL AND expected_cash_minor IS NULL
   AND counted_cash_minor IS NULL AND over_short_minor IS NULL AND closing_count IS NULL
   AND over_short_entry_id IS NULL)
  OR
  (status = 'closed' AND closed_at IS NOT NULL AND closed_by IS NOT NULL AND expected_cash_minor IS NOT NULL
   AND counted_cash_minor IS NOT NULL AND over_short_minor IS NOT NULL AND closing_count IS NOT NULL
   AND over_short_minor = counted_cash_minor - expected_cash_minor
   AND ((over_short_minor = 0) = (over_short_entry_id IS NULL)))
 ),
 CONSTRAINT pos_sessions_register_fkey FOREIGN KEY (org_id, register_id) REFERENCES public.pos_registers(org_id, id),
 CONSTRAINT pos_sessions_subsidiary_fkey FOREIGN KEY (org_id, subsidiary_id) REFERENCES public.subsidiaries(org_id, id),
 CONSTRAINT pos_sessions_opened_by_fkey FOREIGN KEY (org_id, opened_by) REFERENCES public.users(org_id, id),
 CONSTRAINT pos_sessions_closed_by_fkey FOREIGN KEY (org_id, closed_by) REFERENCES public.users(org_id, id),
 CONSTRAINT pos_sessions_over_short_entry_fkey FOREIGN KEY (org_id, over_short_entry_id) REFERENCES public.journal_entries(org_id, id)
);
CREATE UNIQUE INDEX pos_sessions_one_open_per_register ON public.pos_sessions (org_id, register_id) WHERE status = 'open';
CREATE INDEX pos_sessions_register_date ON public.pos_sessions (org_id, register_id, business_date DESC);

CREATE TABLE public.pos_cash_movements (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 session_id uuid NOT NULL,
 kind text NOT NULL CHECK (kind IN ('pay_in', 'pay_out')),
 reason_id uuid NOT NULL,
 amount_minor bigint NOT NULL CHECK (amount_minor > 0),
 note text CHECK (note IS NULL OR char_length(note) <= 500),
 journal_entry_id uuid NOT NULL,
 idempotency_key uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by uuid NOT NULL,
 CONSTRAINT pos_cash_movements_org_id_id_unique UNIQUE (org_id, id),
 CONSTRAINT pos_cash_movements_idempotency_unique UNIQUE (org_id, idempotency_key),
 CONSTRAINT pos_cash_movements_session_fkey FOREIGN KEY (org_id, session_id) REFERENCES public.pos_sessions(org_id, id),
 CONSTRAINT pos_cash_movements_reason_fkey FOREIGN KEY (org_id, reason_id) REFERENCES public.pos_cash_reasons(org_id, id),
 CONSTRAINT pos_cash_movements_entry_fkey FOREIGN KEY (org_id, journal_entry_id) REFERENCES public.journal_entries(org_id, id),
 CONSTRAINT pos_cash_movements_created_by_fkey FOREIGN KEY (org_id, created_by) REFERENCES public.users(org_id, id)
);
CREATE INDEX pos_cash_movements_session ON public.pos_cash_movements (org_id, session_id);

CREATE TABLE public.pos_transactions (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 session_id uuid NOT NULL,
 register_id uuid NOT NULL,
 kind text NOT NULL CHECK (kind IN ('sale', 'refund')),
 document_id uuid NOT NULL,
 refund_of_document_id uuid,
 total_minor bigint NOT NULL CHECK (total_minor >= 0),
 cash_applied_minor bigint NOT NULL DEFAULT 0 CHECK (cash_applied_minor >= 0),
 cash_tendered_minor bigint NOT NULL DEFAULT 0 CHECK (cash_tendered_minor >= 0),
 change_minor bigint NOT NULL DEFAULT 0 CHECK (change_minor >= 0),
 pricing jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(pricing) = 'object'),
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by uuid NOT NULL,
 CONSTRAINT pos_transactions_org_id_id_unique UNIQUE (org_id, id),
 CONSTRAINT pos_transactions_document_unique UNIQUE (org_id, document_id),
 CONSTRAINT pos_transactions_cash_change CHECK (
  change_minor = cash_tendered_minor - cash_applied_minor
  AND (kind = 'sale' OR (cash_tendered_minor = 0 AND change_minor = 0))
 ),
 CONSTRAINT pos_transactions_refund_link CHECK ((kind = 'refund') = (refund_of_document_id IS NOT NULL)),
 CONSTRAINT pos_transactions_session_fkey FOREIGN KEY (org_id, session_id) REFERENCES public.pos_sessions(org_id, id),
 CONSTRAINT pos_transactions_register_fkey FOREIGN KEY (org_id, register_id) REFERENCES public.pos_registers(org_id, id),
 CONSTRAINT pos_transactions_document_fkey FOREIGN KEY (org_id, document_id) REFERENCES public.documents(org_id, id),
 CONSTRAINT pos_transactions_refund_of_fkey FOREIGN KEY (org_id, refund_of_document_id) REFERENCES public.documents(org_id, id),
 CONSTRAINT pos_transactions_created_by_fkey FOREIGN KEY (org_id, created_by) REFERENCES public.users(org_id, id)
);
CREATE INDEX pos_transactions_session ON public.pos_transactions (org_id, session_id, created_at);
CREATE INDEX pos_transactions_refund_of ON public.pos_transactions (org_id, refund_of_document_id) WHERE refund_of_document_id IS NOT NULL;

CREATE TABLE public.pos_held_carts (
 id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7(),
 org_id uuid NOT NULL REFERENCES public.orgs(id),
 register_id uuid NOT NULL,
 label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 120),
 cart jsonb NOT NULL CHECK (jsonb_typeof(cart) = 'object'),
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by uuid,
 CONSTRAINT pos_held_carts_org_id_id_unique UNIQUE (org_id, id),
 CONSTRAINT pos_held_carts_register_fkey FOREIGN KEY (org_id, register_id) REFERENCES public.pos_registers(org_id, id),
 CONSTRAINT pos_held_carts_created_by_fkey FOREIGN KEY (org_id, created_by) REFERENCES public.users(org_id, id)
);
CREATE INDEX pos_held_carts_register ON public.pos_held_carts (org_id, register_id, created_at);

-- A session changes once: from open to closed, with the closing count. The
-- opening identity never changes and a closed session never changes again.
CREATE FUNCTION public.pos_session_lifecycle_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $function$
BEGIN
 IF OLD.status = 'closed' THEN
  RAISE EXCEPTION 'A closed register session is final. Record a correcting journal entry for any later cash adjustment.' USING ERRCODE = '23514';
 END IF;
 IF NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.register_id IS DISTINCT FROM OLD.register_id
    OR NEW.subsidiary_id IS DISTINCT FROM OLD.subsidiary_id OR NEW.session_number IS DISTINCT FROM OLD.session_number
    OR NEW.business_date IS DISTINCT FROM OLD.business_date OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.opening_float_minor IS DISTINCT FROM OLD.opening_float_minor
    OR NEW.opening_count IS DISTINCT FROM OLD.opening_count
    OR NEW.opened_at IS DISTINCT FROM OLD.opened_at OR NEW.opened_by IS DISTINCT FROM OLD.opened_by THEN
  RAISE EXCEPTION 'A register session keeps its opening count; close it and open a new session instead.' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END
$function$;
CREATE TRIGGER pos_sessions_lifecycle BEFORE UPDATE ON public.pos_sessions
 FOR EACH ROW EXECUTE FUNCTION public.pos_session_lifecycle_guard();

-- Register transactions and drawer movements are append-only evidence and
-- join only an open session. A sandbox copy reproduces the source rows
-- exactly, including those of closed sessions.
CREATE FUNCTION public.pos_session_entry_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_catalog AS $function$
DECLARE
 session_status text;
BEGIN
 IF TG_OP = 'UPDATE' THEN
  RAISE EXCEPTION 'Register transactions and drawer movements are retained evidence and cannot be changed.' USING ERRCODE = '23514';
 END IF;
 IF public.openbooks_clone_authority() THEN
  RETURN NEW;
 END IF;
 SELECT status INTO session_status FROM public.pos_sessions
  WHERE org_id = NEW.org_id AND id = NEW.session_id
  FOR SHARE;
 IF session_status IS DISTINCT FROM 'open' THEN
  RAISE EXCEPTION 'The register session is not open. Open a new session on the register first.' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END
$function$;
CREATE TRIGGER pos_transactions_session_entry BEFORE INSERT OR UPDATE ON public.pos_transactions
 FOR EACH ROW EXECUTE FUNCTION public.pos_session_entry_guard();
CREATE TRIGGER pos_cash_movements_session_entry BEFORE INSERT OR UPDATE ON public.pos_cash_movements
 FOR EACH ROW EXECUTE FUNCTION public.pos_session_entry_guard();

DO $tables$
DECLARE target record;
BEGIN
 FOR target IN SELECT * FROM (VALUES
('pos_registers'),
('pos_cash_reasons'),
('pos_quick_keys'),
('pos_sessions'),
('pos_cash_movements'),
('pos_transactions'),
('pos_held_carts')
 ) AS expected(table_name) LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', target.table_name);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', target.table_name);
  EXECUTE format('CREATE POLICY org_isolation ON public.%I USING ((SELECT public.app_bypass_rls_active()) OR org_id::text=(SELECT current_setting(''app.current_org'',true))) WITH CHECK ((SELECT public.app_bypass_rls_active()) OR org_id::text=(SELECT current_setting(''app.current_org'',true)))', target.table_name);
  EXECUTE format('COMMENT ON POLICY org_isolation ON public.%I IS ''openbooks:org_isolation:v1''', target.table_name);
  EXECUTE format('CREATE TRIGGER tenant_retirement_fence BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION tenant_retirement.openbooks_tenant_retirement_fence()', target.table_name);
 END LOOP;
END $tables$;

INSERT INTO public.openbooks_query_catalog_relations (relation, added_in) VALUES
 ('pos_registers', '0734_pos_register'),
 ('pos_cash_reasons', '0734_pos_register'),
 ('pos_quick_keys', '0734_pos_register'),
 ('pos_sessions', '0734_pos_register'),
 ('pos_cash_movements', '0734_pos_register'),
 ('pos_transactions', '0734_pos_register'),
 ('pos_held_carts', '0734_pos_register')
ON CONFLICT (relation) DO NOTHING; -- expected on replay
SELECT public.openbooks_refresh_query_catalog();

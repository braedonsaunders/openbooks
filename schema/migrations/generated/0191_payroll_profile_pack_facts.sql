-- OpenBooks forward migration 0191_payroll_profile_pack_facts.
--
-- WHY THESE COLUMNS EXIST. Four installable payroll packs (PL, ES, JP, BR)
-- read required employee facts their compute paths refuse on when absent —
-- the PL birth year, the ES situación/grupo/año trio, the JP hyōjun grade
-- and kaigo status, the BR dependent count — and no surface produces any of
-- them: no profile column, no certificate field, no API input, no UI. Every
-- PL/ES/JP/BR pay run refuses every employee, and readiness can only name
-- the pack-level gap. These eight columns are the typed profile channel that
-- serves the seven blocking facts plus the BR pensão amount (optional —
-- absent means none ordered — but unreachable without a column, so the
-- deduction could never be entered): one nullable column per fact, named for
-- the engine key that reads it, following the CA/US profile-column shape
-- exactly. The two remaining producer-less facts (BR regime, ES contrato
-- temporal) accept absence, block nothing, and stay unbuilt.
--
-- WHY NULLABLE WITH NO DEFAULT. A fact nobody has answered is "unknown",
-- never zero and never a guess: the compute paths fail closed on absence by
-- design, and a default would convert every outstanding refusal into a
-- silently priced guess. Null is the honest stored state, and the per-pack
-- declarations (not the storage) decide what null means.
--
-- WHY CHECKS ONLY WHERE THE DECLARATION HAS BOUNDS. The ES año (1906–2026)
-- and grupo (1–11) bands, the ES situación closed set, the JP kaigo
-- true/false pair and the BR non-negative dependent count each restate a
-- bound the pack's compute path already enforces, so the storage refuses
-- early what calculation would refuse anyway. PL rok urodzenia and JP
-- hyōjun carry no declared bounds — the engine checks the year band
-- downstream (calculatePlZus2026: 1900–2026) and the grade shape at read
-- time (/^\d+$/) — and a CHECK the declaration does not state would
-- describe an imaginary product, so those two columns carry none.
--
-- WHY TEXT FOR KAIGO AND SITUACIÓN. Both engines compare against answer
-- STRINGS (kaigo !== "false", situación against its three SITUPER values),
-- so a boolean column would refuse forever: false is not "false". The IN
-- checks hold the closed sets instead.
--
-- WHY NO BACKFILL. There is nothing truthful to write: any filled value
-- would be a guess about a real employee, and the whole point of the
-- channel is that absence refuses by name. Historical rows keep NULL and
-- keep refusing exactly as before, until an operator answers them.
--
-- SAFETY ARGUMENT: NO EXISTING ROW CAN BE HARMED. Every added column is
-- nullable with no default, so existing rows gain NULL — the same absent
-- state a fresh profile carries — and no stored value moves. No existing
-- writer names these columns (the profile upsert lists its columns
-- explicitly; the filing fixtures list theirs; there are no
-- Drizzle-query-builder inserts on this table for an implicit default to
-- reach), and no existing reader selects them by position (`prof.*` reads
-- gain unread keys; every named-column read is untouched). The CHECKs
-- constrain only non-null values, and NULL passes every one of them, so
-- even a row carrying all NULLs satisfies the new constraints by
-- construction. The change is inert for existing callers and fails closed
-- only for a future write supplying an out-of-band value — which is the
-- entire purpose.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.employee_payroll_profiles
  ADD COLUMN pl_rok_urodzenia integer,
  ADD COLUMN es_ano_nacimiento integer,
  ADD COLUMN es_grupo_cotizacion integer,
  ADD COLUMN es_situacion_laboral text,
  ADD COLUMN jp_hyojun_hoshu integer,
  ADD COLUMN jp_kaigo_dainigou text,
  ADD COLUMN br_dependentes integer,
  ADD COLUMN br_pensao_mensal numeric(19,4);

ALTER TABLE public.employee_payroll_profiles
  ADD CONSTRAINT employee_payroll_profiles_es_ano
    CHECK (es_ano_nacimiento IS NULL OR (es_ano_nacimiento >= 1906 AND es_ano_nacimiento <= 2026)),
  ADD CONSTRAINT employee_payroll_profiles_es_grupo
    CHECK (es_grupo_cotizacion IS NULL OR (es_grupo_cotizacion >= 1 AND es_grupo_cotizacion <= 11)),
  ADD CONSTRAINT employee_payroll_profiles_es_situacion
    CHECK (es_situacion_laboral IS NULL OR es_situacion_laboral IN ('activo', 'pensionista', 'desempleado')),
  ADD CONSTRAINT employee_payroll_profiles_jp_kaigo
    CHECK (jp_kaigo_dainigou IS NULL OR jp_kaigo_dainigou IN ('true', 'false')),
  ADD CONSTRAINT employee_payroll_profiles_br_dependentes
    CHECK (br_dependentes IS NULL OR br_dependentes >= 0);

COMMENT ON COLUMN public.employee_payroll_profiles.pl_rok_urodzenia IS
  'Employee birth year for the PL FP age bar (0191): PESEL-derived with a declared fallback for employees without a PESEL; null = unknown, never guessed.';
COMMENT ON COLUMN public.employee_payroll_profiles.es_ano_nacimiento IS
  'Employee birth year feeding the ES age-banded rule, AÑOPER (0191); null = unknown, never guessed.';
COMMENT ON COLUMN public.employee_payroll_profiles.es_grupo_cotizacion IS
  'ES Seguridad Social contribution group 1–11, Orden PJC/297/2026 art. 33 (0191); null = undeclared, never group 1 by fallthrough.';
COMMENT ON COLUMN public.employee_payroll_profiles.es_situacion_laboral IS
  'ES employment situation SITUPER: activo, pensionista or desempleado (0191); null = undeclared, never defaulted.';
COMMENT ON COLUMN public.employee_payroll_profiles.jp_hyojun_hoshu IS
  'Employee 標準報酬月額 grade value in whole yen, copied off the JPS notice (0191); null = undeclared, never priced off raw pay.';
COMMENT ON COLUMN public.employee_payroll_profiles.jp_kaigo_dainigou IS
  'Whether the employee is a 介護保険第2号被保険者, as "true"/"false" text (0191); null = undeclared, never defaulted into the cheaper premium.';
COMMENT ON COLUMN public.employee_payroll_profiles.br_dependentes IS
  'Dependent count for the R$ 189,59 IRRF deduction, from the eSocial cadastro (0191); null = unknown, never defaulted.';
COMMENT ON COLUMN public.employee_payroll_profiles.br_pensao_mensal IS
  'Court-ordered monthly alimony reducing the IRRF base (0191); null = none ordered, never zero-filled.';

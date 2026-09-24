-- OpenBooks forward migration 0356_clone_preserves_price_level_activation_history.
--
-- Controlled sandbox/sample-company replay must preserve the source's exact
-- price-level activation periods, including opened_at. The price-level
-- INSERT trigger normally creates a fresh open period; that duplicates the
-- period when runClone subsequently copies the immutable history rows. Stand
-- down only under the existing clone authority so the source periods are
-- copied verbatim. Ordinary creates and every activation transition retain
-- their normal trigger behavior.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

CREATE OR REPLACE FUNCTION public.price_level_activation_maintenance() RETURNS trigger
LANGUAGE plpgsql AS $func$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Clone replay copies the source activation periods immediately after the
    -- price levels; creating a new period here would duplicate that evidence.
    IF public.openbooks_clone_authority() THEN
      RETURN NEW;
    END IF;
    -- A level born inactive was never offered: no period until activated.
    -- Otherwise the standing offer opens at -infinity (see 0327).
    IF NEW.is_active THEN
      INSERT INTO public.price_level_activation_history (org_id, price_level_id, active_from, opened_at)
      VALUES (NEW.org_id, NEW.id, '-infinity'::date, now());
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.is_active AND NOT NEW.is_active THEN
    UPDATE public.price_level_activation_history
       SET active_to = current_date, closed_at = now(), updated_at = now()
     WHERE org_id = NEW.org_id AND price_level_id = NEW.id AND active_to IS NULL;
  ELSIF NOT OLD.is_active AND NEW.is_active THEN
    INSERT INTO public.price_level_activation_history (org_id, price_level_id, active_from, opened_at)
    SELECT NEW.org_id, NEW.id, current_date, now()
     WHERE NOT EXISTS (
       SELECT 1 FROM public.price_level_activation_history h
        WHERE h.org_id = NEW.org_id AND h.price_level_id = NEW.id AND h.active_to IS NULL
     );
  END IF;
  RETURN NEW;
END;
$func$;

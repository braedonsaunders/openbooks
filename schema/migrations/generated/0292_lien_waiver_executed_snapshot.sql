-- OpenBooks forward migration 0292_lien_waiver_executed_snapshot.
--
-- The printable executed waiver regenerated its PDF from the live
-- parties/projects/documents rows on every print, so renaming a vendor or
-- rewording a project silently rewrote an already-executed legal release.
-- lien_waivers gains the frozen print image the sign transition stamps
-- (every name, figure, date and signature line exactly as executed); the
-- printable route serves that image for executed waivers and only renders
-- live rows for unsigned drafts and for waivers executed before this
-- control existed. Re-runnable: every statement is guarded by IF NOT EXISTS.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

ALTER TABLE ONLY public.lien_waivers
  ADD COLUMN IF NOT EXISTS executed_snapshot jsonb;

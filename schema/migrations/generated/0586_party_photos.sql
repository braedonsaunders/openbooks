-- OpenBooks forward migration 0586_party_photos.
-- An optional photo or logo for any party, held as a File Cabinet image so
-- its bytes, versions and audit follow the cabinet's storage rules.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

ALTER TABLE public.parties ADD COLUMN IF NOT EXISTS photo_file_id uuid;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'parties_photo_file_fk' AND conrelid = 'public.parties'::regclass) THEN
    ALTER TABLE ONLY public.parties
      ADD CONSTRAINT parties_photo_file_fk FOREIGN KEY (photo_file_id) REFERENCES public.files(id) ON DELETE SET NULL DEFERRABLE;
  END IF;
END $$;

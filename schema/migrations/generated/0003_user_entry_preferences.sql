-- Store each user's personal data-entry preferences (keyboard and entry-form behaviour) as one validated object.
SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;
SET search_path = public, pg_catalog;

ALTER TABLE public.users
  ADD COLUMN entry_preferences jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.users
  ADD CONSTRAINT users_entry_preferences_object CHECK (jsonb_typeof(entry_preferences) = 'object');

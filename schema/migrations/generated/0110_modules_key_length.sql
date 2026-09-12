-- OpenBooks forward migration 0110_modules_key_length.
--
-- Relaxes modules_key_length from 2..64 to 1..64 so the storage boundary
-- accepts exactly what the module manifest vocabulary already allows: SLUG
-- (^[a-z][a-z0-9-]*$, 1..64). Tightening the manifests to the old 2-char
-- floor instead would retroactively invalidate live 1-char keys, so the DB
-- side relaxes. The canonical key rule lives in the manifests, not here;
-- storage only floors length.
--
-- Stacking note: the 1e slice carries its own 0110 (same ordinal) with the
-- absorb backfill over the kind/app_id columns 0109 adds — columns this
-- branch does not have, so that backfill cannot run here. This file is the
-- constraint half both variants share verbatim (DROP + re-ADD, never two
-- competing checks); at sweep merge the 1e variant supersedes this one and
-- every database converges to 1..64.

-- The old floor (2..64, from 0107) goes first so the relaxed shape below is
-- the only modules_key_length in the catalog — never two competing checks.
ALTER TABLE public.modules
    DROP CONSTRAINT modules_key_length;

ALTER TABLE public.modules
    ADD CONSTRAINT modules_key_length CHECK (((length(key) >= 1) AND (length(key) <= 64)));

COMMENT ON CONSTRAINT modules_key_length ON public.modules IS
  'openbooks:module-key-vocabulary:v1 - 1..64 chars; the manifest SLUG owns the key shape, storage only floors length.';

-- OpenBooks forward migration 0251_payment_link_token_at_rest.
--
-- The pay-link bearer token was the only one of six token types stored in
-- plaintext (sessions, API keys, reset tokens, TOTP factors and webhook
-- secrets are all hashed or sealed at rest). A database read alone was
-- enough to pay any org's live invoices through /pay/{token}. The token is
-- display-bearing — the panel rebuilds the URL from listPaymentLinks — so
-- the remedy is not hash-only: this migration adds a sha256 token_hash for
-- the public lookup and a token_sealed column for display, and backfills
-- the hash in pure SQL. The SEAL half cannot run here (the data key never
-- enters SQL); bootstrap.ts seals each existing row's token and then NULLs
-- the plaintext column in the same bootstrap invocation, so no window
-- exists where a link is undisplayable or unresolvable.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

ALTER TABLE public.payment_links ADD COLUMN IF NOT EXISTS token_hash text;
ALTER TABLE public.payment_links ADD COLUMN IF NOT EXISTS token_sealed text;

-- Every row gets its lookup hash now: the engine resolves by hash only from
-- the next deploy on, and rows written before it also exist in every
-- upgraded install.
UPDATE public.payment_links
   SET token_hash = encode(sha256(token::bytea), 'hex')
 WHERE token_hash IS NULL AND token IS NOT NULL;

-- The hash IS the lookup key: duplicates would mean one token resolving to
-- two links. The unique index also backstops the idempotency key discipline
-- the engine applies before insert.
CREATE UNIQUE INDEX IF NOT EXISTS payment_links_token_hash
  ON public.payment_links (token_hash);

-- The plaintext column's NOT NULL predates at-rest sealing; once hash and
-- seal exist it forbids exactly the storage this migration exists to end.
-- The seal step in bootstrap.ts runs after this file in the same invocation,
-- and the engine never writes the column again.
ALTER TABLE public.payment_links ALTER COLUMN token DROP NOT NULL;
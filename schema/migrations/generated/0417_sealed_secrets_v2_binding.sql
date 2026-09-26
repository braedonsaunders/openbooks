-- OpenBooks forward migration 0417_sealed_secrets_v2_binding.
--
-- Sealed secrets move to `enc:v2:<keyId>:<nonce>:<ct>:<tag>` with the owning
-- tenant and purpose bound as AES-GCM additional data, so a blob copied into
-- another row fails authentication instead of decrypting. Reads stay
-- backward compatible: `enc:v1:` blobs (no key id, no binding) still open,
-- and scripts/rotate-data-key.ts re-seals every column under the active key
-- after this migration lands — the migration itself never touches key
-- material, which must not enter a migration body.
--
-- This migration changes no schema: it gates the upgrade on sealed hygiene.
-- Every non-null value in a sealed text column must already be a sealed blob
-- (`enc:v1:` or `enc:v2:`). Anything else is plaintext or corruption that no
-- released code could have written (every seal since at-rest encryption
-- landed wrote the `enc:` envelope), and upgrading past it would leave a
-- credential the new fail-closed reads refuse. Each precheck names the
-- offending rows; re-enter those credentials (or restore them from backup)
-- and re-apply. Legacy payment_links.token plaintext is out of scope here —
-- the bootstrap seal step owns that column.

SET statement_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET client_min_messages = warning;

SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false);

DO $precheck$
DECLARE
  offending text;
BEGIN
  SELECT string_agg(DISTINCT left(secrets, 24), ', ') INTO offending
    FROM public.connections
   WHERE secrets IS NOT NULL AND secrets NOT LIKE 'enc:v\_%' ESCAPE '\';
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'connections.secrets holds % non-sealed value(s); re-enter those connection credentials before applying 0417', offending;
  END IF;

  SELECT string_agg(DISTINCT left(credentials, 24), ', ') INTO offending
    FROM public.bank_feed_connections
   WHERE credentials IS NOT NULL AND credentials NOT LIKE 'enc:v\_%' ESCAPE '\';
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'bank_feed_connections.credentials holds % non-sealed value(s); re-enter those feed credentials before applying 0417', offending;
  END IF;

  SELECT string_agg(DISTINCT left(secrets, 24), ', ') INTO offending
    FROM public.fx_provider_configs
   WHERE secrets IS NOT NULL AND secrets NOT LIKE 'enc:v\_%' ESCAPE '\';
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'fx_provider_configs.secrets holds % non-sealed value(s); re-enter that provider key before applying 0417', offending;
  END IF;

  SELECT string_agg(DISTINCT left(originator_secrets_encrypted, 24), ', ') INTO offending
    FROM public.payment_bank_profiles
   WHERE originator_secrets_encrypted IS NOT NULL
     AND originator_secrets_encrypted NOT LIKE 'enc:v\_%' ESCAPE '\'
    ;
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'payment_bank_profiles.originator_secrets_encrypted holds % non-sealed value(s); re-enter those originator secrets before applying 0417', offending;
  END IF;

  SELECT string_agg(DISTINCT left(secrets, 24), ', ') INTO offending
    FROM public.psp_provider_configs
   WHERE secrets IS NOT NULL AND secrets NOT LIKE 'enc:v\_%' ESCAPE '\';
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'psp_provider_configs.secrets holds % non-sealed value(s); re-enter those provider credentials before applying 0417', offending;
  END IF;

  SELECT string_agg(DISTINCT left(token_sealed, 24), ', ') INTO offending
    FROM public.payment_links
   WHERE token_sealed IS NOT NULL AND token_sealed NOT LIKE 'enc:v\_%' ESCAPE '\';
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'payment_links.token_sealed holds % non-sealed value(s); void and reissue those links before applying 0417', offending;
  END IF;

  SELECT string_agg(DISTINCT left(sin_encrypted, 24), ', ') INTO offending
    FROM public.employee_payroll_profiles
   WHERE sin_encrypted IS NOT NULL AND sin_encrypted NOT LIKE 'enc:v\_%' ESCAPE '\';
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'employee_payroll_profiles.sin_encrypted holds % non-sealed value(s); re-enter those identifiers on the payroll profiles before applying 0417', offending;
  END IF;

  SELECT string_agg(DISTINCT left(secret_encrypted, 24), ', ') INTO offending
    FROM public.auth_mfa_factors
   WHERE secret_encrypted NOT LIKE 'enc:v\_%' ESCAPE '\';
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'auth_mfa_factors.secret_encrypted holds % non-sealed value(s); have those users restart MFA enrollment before applying 0417', offending;
  END IF;

  SELECT string_agg(DISTINCT left(account_number_encrypted, 24), ', ') INTO offending
    FROM public.party_bank_accounts
   WHERE account_number_encrypted IS NOT NULL
     AND account_number_encrypted NOT LIKE 'enc:v\_%' ESCAPE '\'
    ;
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'party_bank_accounts.account_number_encrypted holds % non-sealed value(s); re-enter those account numbers before applying 0417', offending;
  END IF;

  SELECT string_agg(DISTINCT left(password_encrypted, 24), ', ') INTO offending
    FROM public.sftp_servers
   WHERE password_encrypted IS NOT NULL AND password_encrypted NOT LIKE 'enc:v\_%' ESCAPE '\';
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'sftp_servers.password_encrypted holds % non-sealed value(s); rotate those SFTP passwords before applying 0417', offending;
  END IF;

  SELECT string_agg(DISTINCT left(secrets, 24), ', ') INTO offending
    FROM public.tax_rate_provider_configs
   WHERE secrets IS NOT NULL AND secrets NOT LIKE 'enc:v\_%' ESCAPE '\';
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'tax_rate_provider_configs.secrets holds % non-sealed value(s); re-enter those provider secrets before applying 0417', offending;
  END IF;

  SELECT string_agg(DISTINCT left(tin_encrypted, 24), ', ') INTO offending
    FROM public.vendor_roles
   WHERE tin_encrypted IS NOT NULL AND tin_encrypted NOT LIKE 'enc:v\_%' ESCAPE '\';
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'vendor_roles.tin_encrypted holds % non-sealed value(s); re-enter those TINs before applying 0417', offending;
  END IF;
END;
$precheck$;

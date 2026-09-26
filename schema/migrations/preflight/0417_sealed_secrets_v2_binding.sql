-- OpenBooks upgrade preflight for 0417_sealed_secrets_v2_binding.
--
-- Read-only mirror of the migration's own sealed-hygiene prechecks: every
-- non-null sealed text column must already hold a sealed blob (`enc:v1:` or
-- `enc:v2:`). Shape is all SQL can prove — whether a blob OPENS under the
-- configured data key is proven by scripts/rotate-data-key.ts in dry-run
-- mode, which every operator runs before applying. Zero rows means the
-- install is ready for 0417.
SELECT * FROM (
SELECT '0417.unsealed_connections' AS code,
        'refuse' AS severity,
        format('connections %s (org %s) holds a non-sealed secrets value', c.id, c.org_id) AS subject,
        format('connections.secrets row %s starts with %s', c.id, left(c.secrets, 24)) AS detail,
        'Re-enter those connection credentials, then re-apply. Migration 0417 will not rewrite secrets.' AS remedy
   FROM public.connections c
  WHERE c.secrets IS NOT NULL AND c.secrets NOT LIKE 'enc:v\_%' ESCAPE '\'
  ORDER BY c.id
  LIMIT 20) unsealed_connections
UNION ALL
SELECT * FROM (
SELECT '0417.unsealed_bank_feeds' AS code,
        'refuse' AS severity,
        format('bank_feed_connections %s (org %s) holds a non-sealed credentials value', c.id, c.org_id) AS subject,
        format('bank_feed_connections.credentials row %s starts with %s', c.id, left(c.credentials, 24)) AS detail,
        'Re-enter those feed credentials, then re-apply. Migration 0417 will not rewrite secrets.' AS remedy
   FROM public.bank_feed_connections c
  WHERE c.credentials IS NOT NULL AND c.credentials NOT LIKE 'enc:v\_%' ESCAPE '\'
  ORDER BY c.id
  LIMIT 20) unsealed_bank_feeds
UNION ALL
SELECT * FROM (
SELECT '0417.unsealed_fx_providers' AS code,
        'refuse' AS severity,
        format('fx_provider_configs %s (org %s) holds a non-sealed secrets value', c.id, c.org_id) AS subject,
        format('fx_provider_configs.secrets row %s starts with %s', c.id, left(c.secrets, 24)) AS detail,
        'Re-enter that provider key, then re-apply. Migration 0417 will not rewrite secrets.' AS remedy
   FROM public.fx_provider_configs c
  WHERE c.secrets IS NOT NULL AND c.secrets NOT LIKE 'enc:v\_%' ESCAPE '\'
  ORDER BY c.id
  LIMIT 20) unsealed_fx_providers
UNION ALL
SELECT * FROM (
SELECT '0417.unsealed_originator_secrets' AS code,
        'refuse' AS severity,
        format('payment_bank_profiles %s (org %s) holds a non-sealed originator secret', c.id, c.org_id) AS subject,
        format('payment_bank_profiles.originator_secrets_encrypted row %s starts with %s', c.id, left(c.originator_secrets_encrypted, 24)) AS detail,
        'Re-enter those originator secrets, then re-apply. Migration 0417 will not rewrite secrets.' AS remedy
   FROM public.payment_bank_profiles c
  WHERE c.originator_secrets_encrypted IS NOT NULL AND c.originator_secrets_encrypted NOT LIKE 'enc:v\_%' ESCAPE '\'
  ORDER BY c.id
  LIMIT 20) unsealed_originator_secrets
UNION ALL
SELECT * FROM (
SELECT '0417.unsealed_psp_providers' AS code,
        'refuse' AS severity,
        format('psp_provider_configs %s (org %s) holds a non-sealed secrets value', c.id, c.org_id) AS subject,
        format('psp_provider_configs.secrets row %s starts with %s', c.id, left(c.secrets, 24)) AS detail,
        'Re-enter those provider credentials, then re-apply. Migration 0417 will not rewrite secrets.' AS remedy
   FROM public.psp_provider_configs c
  WHERE c.secrets IS NOT NULL AND c.secrets NOT LIKE 'enc:v\_%' ESCAPE '\'
  ORDER BY c.id
  LIMIT 20) unsealed_psp_providers
UNION ALL
SELECT * FROM (
SELECT '0417.unsealed_payment_links' AS code,
        'refuse' AS severity,
        format('payment_links %s (org %s) holds a non-sealed token seal', c.id, c.org_id) AS subject,
        format('payment_links.token_sealed row %s starts with %s', c.id, left(c.token_sealed, 24)) AS detail,
        'Void and reissue those links, then re-apply. Migration 0417 will not rewrite secrets.' AS remedy
   FROM public.payment_links c
  WHERE c.token_sealed IS NOT NULL AND c.token_sealed NOT LIKE 'enc:v\_%' ESCAPE '\'
  ORDER BY c.id
  LIMIT 20) unsealed_payment_links
UNION ALL
SELECT * FROM (
SELECT '0417.unsealed_payroll_identifiers' AS code,
        'refuse' AS severity,
        format('employee_payroll_profiles %s (org %s) holds a non-sealed identifier', c.id, c.org_id) AS subject,
        format('employee_payroll_profiles.sin_encrypted row %s starts with %s', c.id, left(c.sin_encrypted, 24)) AS detail,
        'Re-enter those identifiers on the payroll profiles, then re-apply. Migration 0417 will not rewrite secrets.' AS remedy
   FROM public.employee_payroll_profiles c
  WHERE c.sin_encrypted IS NOT NULL AND c.sin_encrypted NOT LIKE 'enc:v\_%' ESCAPE '\'
  ORDER BY c.id
  LIMIT 20) unsealed_payroll_identifiers
UNION ALL
SELECT * FROM (
SELECT '0417.unsealed_mfa_factors' AS code,
        'refuse' AS severity,
        format('auth_mfa_factors for user %s holds a non-sealed secret', c.user_id) AS subject,
        format('auth_mfa_factors.secret_encrypted user %s starts with %s', c.user_id, left(c.secret_encrypted, 24)) AS detail,
        'Have those users restart MFA enrollment, then re-apply. Migration 0417 will not rewrite secrets.' AS remedy
   FROM public.auth_mfa_factors c
  WHERE c.secret_encrypted NOT LIKE 'enc:v\_%' ESCAPE '\'
  ORDER BY c.user_id
  LIMIT 20) unsealed_mfa_factors
UNION ALL
SELECT * FROM (
SELECT '0417.unsealed_counterparty_accounts' AS code,
        'refuse' AS severity,
        format('party_bank_accounts %s (org %s) holds a non-sealed account number', c.id, c.org_id) AS subject,
        format('party_bank_accounts.account_number_encrypted row %s starts with %s', c.id, left(c.account_number_encrypted, 24)) AS detail,
        'Re-enter those account numbers, then re-apply. Migration 0417 will not rewrite secrets.' AS remedy
   FROM public.party_bank_accounts c
  WHERE c.account_number_encrypted IS NOT NULL AND c.account_number_encrypted NOT LIKE 'enc:v\_%' ESCAPE '\'
  ORDER BY c.id
  LIMIT 20) unsealed_counterparty_accounts
UNION ALL
SELECT * FROM (
SELECT '0417.unsealed_sftp_passwords' AS code,
        'refuse' AS severity,
        format('sftp_servers %s (org %s) holds a non-sealed password', c.id, c.org_id) AS subject,
        format('sftp_servers.password_encrypted row %s starts with %s', c.id, left(c.password_encrypted, 24)) AS detail,
        'Rotate those SFTP passwords, then re-apply. Migration 0417 will not rewrite secrets.' AS remedy
   FROM public.sftp_servers c
  WHERE c.password_encrypted IS NOT NULL AND c.password_encrypted NOT LIKE 'enc:v\_%' ESCAPE '\'
  ORDER BY c.id
  LIMIT 20) unsealed_sftp_passwords
UNION ALL
SELECT * FROM (
SELECT '0417.unsealed_tax_providers' AS code,
        'refuse' AS severity,
        format('tax_rate_provider_configs %s (org %s) holds a non-sealed secrets value', c.id, c.org_id) AS subject,
        format('tax_rate_provider_configs.secrets row %s starts with %s', c.id, left(c.secrets, 24)) AS detail,
        'Re-enter those provider secrets, then re-apply. Migration 0417 will not rewrite secrets.' AS remedy
   FROM public.tax_rate_provider_configs c
  WHERE c.secrets IS NOT NULL AND c.secrets NOT LIKE 'enc:v\_%' ESCAPE '\'
  ORDER BY c.id
  LIMIT 20) unsealed_tax_providers
UNION ALL
SELECT * FROM (
SELECT '0417.unsealed_vendor_tins' AS code,
        'refuse' AS severity,
        format('vendor_roles party %s (org %s) holds a non-sealed TIN', c.party_id, c.org_id) AS subject,
        format('vendor_roles.tin_encrypted party %s starts with %s', c.party_id, left(c.tin_encrypted, 24)) AS detail,
        'Re-enter those TINs, then re-apply. Migration 0417 will not rewrite secrets.' AS remedy
   FROM public.vendor_roles c
  WHERE c.tin_encrypted IS NOT NULL AND c.tin_encrypted NOT LIKE 'enc:v\_%' ESCAPE '\'
  ORDER BY c.party_id
  LIMIT 20) unsealed_vendor_tins;

-- Make the native CAD RBC STD152 format available to existing organizations.
-- Reserved-code conflicts refuse; existing formats, profiles and artifacts are retained.
DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.payment_formats
    WHERE code = 'RBC-STD152'
      AND (rail IS DISTINCT FROM 'rbc_std152_credit'
        OR direction IS DISTINCT FROM 'credit'
        OR country IS DISTINCT FROM 'CA'
        OR currency IS DISTINCT FROM 'CAD'
        OR file_extension IS DISTINCT FROM 'txt'
        OR content_type IS DISTINCT FROM 'text/plain; charset=us-ascii'
        OR formatter_script IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'RBC-STD152 is reserved for the native Canadian-bank credit format. Preserve the conflicting format and its history, review its configured code in Payment formats, and retry the upgrade.' USING ERRCODE = '23514';
  END IF;
END
$migration$;

INSERT INTO public.payment_formats
  (org_id, code, name, rail, direction, country, currency, file_extension, content_type)
SELECT id, 'RBC-STD152', 'RBC STD152 Canadian-bank credit', 'rbc_std152_credit',
  'credit', 'CA', 'CAD', 'txt', 'text/plain; charset=us-ascii'
FROM public.orgs
-- An already installed, validated native format is an explicitly benign conflict.
ON CONFLICT (org_id, code) DO NOTHING;

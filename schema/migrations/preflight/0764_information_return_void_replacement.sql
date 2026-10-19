SELECT '0764.information_return_active_identity'::text AS code,
       'refuse'::text AS severity,
       concat(f.org_id, ':', f.tax_year, ':', f.form_type, ':',
              coalesce(f.subsidiary_id::text, 'root')) AS subject,
       concat('The active information-return identity has ', count(*),
              ' rows before the replacement index is installed.') AS detail,
       'Resolve duplicate active filings through the filing lifecycle before upgrading.' AS remedy
  FROM public.information_return_filings f
 WHERE f.status <> 'void'
 GROUP BY f.org_id, f.tax_year, f.form_type, f.subsidiary_id
HAVING count(*) > 1;

SELECT '0538.run_returned_to_draft' AS code, 'notice' AS severity, r.run_number::text AS subject,
 'This payment run is awaiting approval under the retired profile switch and will return to draft.' AS detail,
 'After the upgrade, set up a payment-run approval flow if approval is still wanted, then submit the run again.' AS remedy
FROM public.payment_runs r
WHERE r.status = 'pending_approval'
UNION ALL
SELECT '0538.file_approval_retired' AS code, 'notice' AS severity, f.filename::text AS subject,
 'This payment file is awaiting the retired file approval and will be rejected.' AS detail,
 'After the upgrade, reprocess the file from its payment run to generate a deliverable replacement.' AS remedy
FROM public.payment_files f
WHERE f.status = 'pending_approval'
UNION ALL
SELECT '0538.run_approval_moves_to_flows' AS code, 'notice' AS severity, p.name::text AS subject,
 'This payment profile required payment-run approval; approval is now configured in Flows, and runs without a payment-run flow are approved on submit.' AS detail,
 'After the upgrade, create an outbound or inbound payment-run flow in Flows to keep requiring approval.' AS remedy
FROM public.payment_bank_profiles p
WHERE p.require_run_approval AND p.is_active
  AND EXISTS (SELECT 1 FROM public.payment_runs r WHERE r.payment_bank_profile_id = p.id AND r.org_id = p.org_id);

-- 0133_payroll_sin.sql — sealed SIN/SSN on payroll profiles (T4/W-2 filing).
-- Same envelope-encryption pattern as vendor TINs; last 3 shown for identify-
-- without-reveal in the UI.

ALTER TABLE public.employee_payroll_profiles
    ADD COLUMN sin_encrypted text,
    ADD COLUMN sin_last3 text;

DROP VIEW IF EXISTS openbooks_query.employee_payroll_profiles;
CREATE VIEW openbooks_query.employee_payroll_profiles WITH (security_barrier='true') AS
  SELECT id, org_id, employee_party_id, pay_schedule_id, country, province, pay_basis,
         federal_claim_code, federal_claim_amount, provincial_claim_code, provincial_claim_amount,
         additional_tax_per_period, prescribed_zone_deduction, authorized_annual_deductions,
         authorized_federal_credits, authorized_provincial_credits, cpp_exempt, ei_exempt,
         tax_exempt, filing_status, multiple_jobs, dependent_credits, other_income_annual,
         deductions_annual, w4_pre_2020, w4_allowances, fica_exempt, futa_exempt,
         vacation_percent, vacation_method, union_agreement_id, union_classification_id,
         is_active, created_at, created_by, updated_at, updated_by, sin_last3
    FROM public.employee_payroll_profiles;
GRANT SELECT ON TABLE openbooks_query.employee_payroll_profiles TO openbooks_read;

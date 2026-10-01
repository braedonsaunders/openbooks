SELECT 'benefit awards contain partial payroll linkage' AS issue FROM public.hrm_benefit_awards WHERE (pay_run_document_id IS NULL) <> (pay_run_adjustment_id IS NULL) LIMIT 1;

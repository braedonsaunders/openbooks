-- Refuse a partially installed Canadian averaging history before adding its source inputs.
SELECT 'Canadian averaging history columns already exist without their migration' AS issue
WHERE EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='payroll_opening_balances' AND (column_name LIKE 'ca_avg_%' OR column_name='non_periodic_pension_deductions_ytd'));

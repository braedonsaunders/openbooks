-- Per-subsidiary control-account overrides (source platform subsidiary preferences).
-- A jsonb map of the same keys as orgs.settings.controlAccounts
-- (ar/ap/bank/taxCollected/taxPaid/employeePayable/fxUnrealizedGainLoss); an
-- absent/blank key falls back to the org-level default at posting time, so an
-- empty object means "use the company defaults" and existing books are unchanged.
alter table subsidiaries add column if not exists control_accounts jsonb not null default '{}'::jsonb;

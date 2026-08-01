alter table security_deposit_transactions
  add column if not exists import_key text;

create unique index if not exists security_deposits_import_key_once
  on security_deposit_transactions (org_id, import_key)
  where import_key is not null;

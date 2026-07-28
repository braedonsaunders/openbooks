BEGIN;

-- Billing state is a commercial lifecycle fact, not merely the presence of a
-- local invoice-line foreign key. External systems can prove that time was
-- billed while withholding line-level linkage. Preserve that fact natively so
-- imported historical time is not treated as newly invoiceable.
ALTER TABLE time_entries
  ADD COLUMN IF NOT EXISTS billing_status text NOT NULL DEFAULT 'unbilled';

UPDATE time_entries
   SET billing_status = 'billed'
 WHERE invoiced_by_line_id IS NOT NULL
   AND billing_status <> 'billed';

ALTER TABLE time_entries
  DROP CONSTRAINT IF EXISTS time_entries_billing_status_valid,
  ADD CONSTRAINT time_entries_billing_status_valid
    CHECK (billing_status IN ('unbilled', 'billed')),
  DROP CONSTRAINT IF EXISTS time_entries_invoice_link_is_billed,
  ADD CONSTRAINT time_entries_invoice_link_is_billed
    CHECK (invoiced_by_line_id IS NULL OR billing_status = 'billed');

CREATE INDEX IF NOT EXISTS time_entries_billing_status
  ON time_entries (org_id, billing_status);

COMMIT;

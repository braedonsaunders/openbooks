BEGIN;

-- Quantities and commercial rates are not money. Source systems legitimately
-- retain more than four decimal places here even though the extended amount is
-- posted at numeric(19,4). Preserve that precision without changing any
-- existing value or reinterpreting posted ledger history.
ALTER TABLE document_lines
  ALTER COLUMN quantity TYPE numeric(28,8)
    USING quantity::numeric(28,8),
  ALTER COLUMN unit_price TYPE numeric(28,8)
    USING unit_price::numeric(28,8);

COMMIT;

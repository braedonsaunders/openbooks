-- Signed tax evidence is required for discounts, refunds, and source-system
-- adjustments. Recovery still cross-foots exactly to the signed tax amount.
alter table document_line_tax_components
  drop constraint if exists document_line_tax_components_nonnegative;

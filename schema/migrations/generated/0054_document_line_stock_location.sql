-- Inventory document integration: an inventory item line names the stock
-- location where a vendor bill receives it or a customer invoice/shipment
-- issues it. Null → the single active stock location, else non-inventory.
alter table document_lines add column if not exists stock_location_id uuid;

-- Received-not-billed (GRNI) clearing account on the item costing profile.
alter table item_inventory_profiles add column if not exists received_not_billed_account_id uuid;

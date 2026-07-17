-- Manual landed-cost entries have no source document line.
alter table landed_cost_allocations alter column source_document_line_id drop not null;

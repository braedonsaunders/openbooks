-- Bill-out tiers for labor/T&M time: a time type carries a default bill
-- multiplier (OT ×1.5, DT ×2 — auto-calc), and a rate-book line may pin an
-- EXPLICIT per-time-type bill rate that overrides the multiplier (the
-- per-item, per-customer reg/OT/DT rate card).

alter table time_types
  add column if not exists bill_multiplier numeric(19, 4) not null default 1;

alter table item_rate_lines
  add column if not exists time_type_bill_rates jsonb not null default '{}'::jsonb;

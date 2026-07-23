-- Controlled change-order allocation. A deductive change order must reduce an
-- existing SOV line; an unallocated change order may only add a new SOV line.

alter table change_orders
  add column if not exists target_sov_line_id uuid;

alter table change_orders
  add constraint change_orders_nonzero_amount
    check (amount <> 0) not valid,
  add constraint change_orders_deduction_target
    check (amount > 0 or target_sov_line_id is not null) not valid,
  add constraint change_orders_target_sov_fk
    foreign key (target_sov_line_id) references sov_lines(id) on delete restrict
    not valid;

create or replace function change_order_target_guard()
returns trigger language plpgsql as $$
begin
  if new.target_sov_line_id is not null and not exists (
    select 1
      from sov_lines sl
     where sl.id = new.target_sov_line_id
       and sl.org_id = new.org_id
       and sl.project_id = new.project_id
  ) then
    raise exception 'change-order target must belong to the same organization and project';
  end if;
  return new;
end $$;

drop trigger if exists change_order_target_guard_trigger on change_orders;
create constraint trigger change_order_target_guard_trigger
after insert or update of org_id, project_id, target_sov_line_id on change_orders
deferrable initially immediate
for each row execute function change_order_target_guard();

alter table change_orders validate constraint change_orders_nonzero_amount;
alter table change_orders validate constraint change_orders_deduction_target;
alter table change_orders validate constraint change_orders_target_sov_fk;

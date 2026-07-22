-- Track the current billing period's start so mid-period changes (upgrades /
-- downgrades) can be prorated exactly against the remaining days.

alter table subscriptions
  add column if not exists current_period_start date;

-- Backfill: the current period began at the last bill, i.e. one interval before
-- next_bill_on. For never-billed subscriptions it is the start date.
update subscriptions s
   set current_period_start = case when s.run_count > 0 then s.next_bill_on else s.start_on end
  from subscription_plans p
 where p.id = s.plan_id and s.current_period_start is null;

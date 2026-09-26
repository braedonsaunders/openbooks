/** Schedule generation, lease lifecycle, escalations. Split from property/management.ts (pure moves only). */
import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../platform/db.ts";
import { businessToday } from "../platform/business-date.ts";
import { inventoryFeatureEnabled } from "../inventory/profile-policy.ts";
import { orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import { cmp, mulRatio } from "../money/money.ts";
import { addDays, addMonths, assertEnabled, audit, dayCount, exactMoney, INVENTORY_ITEM_KINDS, lockLeasePropertyInScope, PropertyManagementError, startOfMonth, validDate, type BaseRentChargeRow, type LeaseChargeScheduleRow, type LeaseEscalationDbRow, type LeaseScheduleContextRow } from "./management-foundation.ts";
import { escalatedRent, leaseChargeSchedule } from "./management-foundation.ts";

/**
 * Furthest a caller may pre-generate schedule lines, in months from the start
 * of the current business month. The scheduler rolls a 13-month window every
 * day, so lines beyond it exist only for explicit look-ahead; the cap keeps a
 * single request from materialising an unbounded schedule in one transaction.
 */
export const MAX_LEASE_SCHEDULE_HORIZON_MONTHS = 120;
async function generateLeaseSchedule(runner: Pick<typeof db, "execute">, orgId: string, actorId: string | null, leaseId: string, throughOn?: string): Promise<number> {
  // Serialize overlapping regenerations for one lease. The daily scheduler
  // rolls a 13-month window while an operator may cut a look-ahead horizon in
  // the same minute; without this the loser reads a stale charge stream and
  // its `created` count cannot be trusted. An advisory lock (never a lease
  // row lock: escalation-apply already holds charge locks when it regenerates,
  // and a row lock here would invert that order against billing) makes the
  // loser wait, re-read committed charges, and count only genuinely new lines.
  // Xact-scoped: held to the caller's commit, in every caller.
  await runner.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"property-schedule:" + orgId + ":" + leaseId}, 0))`);
  const leaseResult = (await runner.execute<LeaseScheduleContextRow>(sql`select starts_on as "startsOn",ends_on as "endsOn",billing_day as "billingDay",status from property_leases where org_id=${orgId} and id=${leaseId}`));
  const lease = leaseResult.rows[0]; if (!lease || !["active", "notice"].includes(lease.status)) throw new PropertyManagementError("Active lease not found");
  const currentMonth = startOfMonth(await businessToday(orgId));
  const requested = validDate(throughOn, "Schedule horizon");
  const cap = addDays(addMonths(currentMonth, MAX_LEASE_SCHEDULE_HORIZON_MONTHS), -1);
  if (requested != null && requested > cap) {
    throw new PropertyManagementError(`Schedule horizon cannot exceed ${MAX_LEASE_SCHEDULE_HORIZON_MONTHS} months ahead (through ${cap})`);
  }
  const horizon = requested ?? addDays(addMonths(currentMonth, 13), -1);
  const charges = (await runner.execute<LeaseChargeScheduleRow>(sql`select id,amount,frequency,effective_from as "effectiveFrom",effective_to as "effectiveTo" from lease_charges where org_id=${orgId} and lease_id=${leaseId} order by effective_from`));
  let created = 0;
  for (const charge of charges.rows) {
    for (const period of leaseChargeSchedule({ ...charge, leaseStartsOn: lease.startsOn, leaseEndsOn: lease.endsOn, throughOn: horizon, billingDay: lease.billingDay })) {
      // The conflict is expected and benign, never a dropped write: the
      // stream above is deterministic in the committed charges, so an
      // (org, charge, period_start) that already exists was materialised by
      // an earlier run or by the serialized overlapping run holding the
      // advisory lock — with identical terms — or is a superseded line the
      // escalation path deliberately retained as cancelled. Skipping it keeps
      // exactly-once billing inputs without resurrecting superseded terms,
      // and `created` below honestly counts newly materialised lines.
      const result = (await runner.execute(sql`
        insert into lease_schedule_lines(org_id,lease_id,charge_id,period_starts_on,period_ends_on,due_on,amount,created_by,updated_by)
        values(${orgId},${leaseId},${charge.id},${period.periodStartsOn},${period.periodEndsOn},${period.dueOn},${period.amount},${actorId},${actorId})
        on conflict(org_id,charge_id,period_starts_on) do nothing returning id
      `));
      created += result.rows.length;
    }
  }
  if (created === 0) return 0;
  // Durable provenance per generated batch: a null actor is the engine-wide
  // system identity; the marker names the initiating surface and the source
  // lease so scheduled rows are auditable without borrowing any user identity.
  await audit(runner, orgId, "property_leases", leaseId, "schedule_generated", actorId,
    actorId === null
      ? { created, source: "scheduler", actorKind: "system", actorReason: "property billing schedule" }
      : { created, source: "user" },
    actorId === null ? `property-billing:schedule:${leaseId}` : null);
  return created;
}
export async function scheduleLeaseCharges(orgId: string, actorId: string | null, allowedSubsidiaryIds: ReadonlySet<string> | null, leaseId: string, throughOn?: string): Promise<{ created: number }> {
  await assertEnabled(db, orgId);
  const created = await db.transaction(async (tx) => {
    await lockLeasePropertyInScope(tx, orgId, leaseId, allowedSubsidiaryIds);
    return generateLeaseSchedule(tx, orgId, actorId, leaseId, throughOn);
  });
  return { created };
}
export async function activatePropertyLease(orgId: string, actorId: string, allowedSubsidiaryIds: ReadonlySet<string> | null, leaseId: string): Promise<{ scheduled: number }> {
  return db.transaction(async (tx) => {
    await assertEnabled(tx, orgId);
    await lockLeasePropertyInScope(tx, orgId, leaseId, allowedSubsidiaryIds);
    const lease = (await tx.execute(sql`select * from property_leases where org_id=${orgId} and id=${leaseId} for update`));
    const row = lease.rows[0]; if (!row || row.status !== "draft") throw new PropertyManagementError("Draft lease not found");
    if (row.unit_id) {
      const conflict = (await tx.execute(sql`select 1 from property_leases where org_id=${orgId} and unit_id=${row.unit_id} and id<>${leaseId} and status in ('active','notice')`));
      if (conflict.rows.length) throw new PropertyManagementError("Unit already has an active lease");
      await tx.execute(sql`update property_units set status='occupied',updated_at=now(),updated_by=${actorId} where org_id=${orgId} and id=${row.unit_id}`);
    }
    await tx.execute(sql`update property_leases set status='active',activated_at=now(),activated_by=${actorId},updated_at=now(),updated_by=${actorId} where id=${leaseId} and org_id=${orgId}`);
    const scheduled = await generateLeaseSchedule(tx, orgId, actorId, leaseId);
    await audit(tx, orgId, "property_leases", leaseId, "activate", actorId, { after: { status: "active" } });
    return { scheduled };
  });
}
export async function terminatePropertyLease(orgId: string, actorId: string, allowedSubsidiaryIds: ReadonlySet<string> | null, leaseId: string, terminatedOn: string, reason: string): Promise<void> {
  if (!reason.trim()) throw new PropertyManagementError("Termination reason is required");
  const effectiveOn = validDate(terminatedOn, "Termination date");
  if (!effectiveOn) throw new PropertyManagementError("Termination date is required");
  await db.transaction(async (tx) => {
    await assertEnabled(tx, orgId);
    await lockLeasePropertyInScope(tx, orgId, leaseId, allowedSubsidiaryIds);
    const lease = (await tx.execute<{ starts_on: string; unit_id: string | null }>(sql`select starts_on,unit_id from property_leases where org_id=${orgId} and id=${leaseId} and status in ('active','notice') for update`));
    const row = lease.rows[0];
    if (!row) throw new PropertyManagementError("Active lease not found");
    if (effectiveOn < row.starts_on) throw new PropertyManagementError("Termination date cannot precede the lease start");
    const partials = (await tx.execute<{ id: string; period_starts_on: string; period_ends_on: string; amount: string }>(sql`select id,period_starts_on,period_ends_on,amount from lease_schedule_lines
      where org_id=${orgId} and lease_id=${leaseId} and status='scheduled' and period_starts_on<=${effectiveOn} and period_ends_on>${effectiveOn} for update`));
    for (const period of partials.rows) {
      const prorated = mulRatio(period.amount, BigInt(dayCount(period.period_starts_on, effectiveOn)), BigInt(dayCount(period.period_starts_on, period.period_ends_on)));
      await tx.execute(sql`update lease_schedule_lines set period_ends_on=${effectiveOn},amount=${prorated},updated_at=now(),updated_by=${actorId} where org_id=${orgId} and id=${period.id} and status='scheduled'`);
    }
    await tx.execute(sql`update lease_schedule_lines set status='cancelled',updated_at=now(),updated_by=${actorId} where org_id=${orgId} and lease_id=${leaseId} and status='scheduled' and period_starts_on>${effectiveOn}`);
    await tx.execute(sql`update property_leases set status='terminated',ends_on=least(coalesce(ends_on,${effectiveOn}),${effectiveOn}),move_out_on=${effectiveOn},terminated_at=now(),terminated_by=${actorId},termination_reason=${reason.trim()},updated_at=now(),updated_by=${actorId} where org_id=${orgId} and id=${leaseId}`);
    if (row.unit_id) await tx.execute(sql`update property_units set status='vacant',updated_at=now(),updated_by=${actorId} where org_id=${orgId} and id=${row.unit_id}`);
    await audit(tx, orgId, "property_leases", leaseId, "terminate", actorId, { terminatedOn: effectiveOn, reason: reason.trim() });
  });
}
export async function addLeaseEscalation(input: { orgId: string; actorId: string; allowedSubsidiaryIds: ReadonlySet<string> | null; leaseId: string; effectiveOn: string; method: "percent" | "fixed" | "new_amount"; value: string; requestId?: string | null }): Promise<{ id: string }> {
  const effectiveOn = validDate(input.effectiveOn, "Escalation date");
  if (!effectiveOn) throw new PropertyManagementError("Escalation date is required");
  const value = exactMoney(input.value, "Escalation value");
  if (cmp(value, "0") <= 0) throw new PropertyManagementError("Escalation value must be positive");
  if (!["percent", "fixed", "new_amount"].includes(input.method)) throw new PropertyManagementError("Invalid escalation method");
  return db.transaction(async (tx) => {
    await assertEnabled(tx, input.orgId);
    await lockLeasePropertyInScope(tx, input.orgId, input.leaseId, input.allowedSubsidiaryIds);
    const duplicateDate = (await tx.execute(sql`select 1 from lease_escalations
      where org_id=${input.orgId} and lease_id=${input.leaseId} and effective_on=${effectiveOn} limit 1`));
    if (duplicateDate.rows.length) throw new PropertyManagementError("An escalation already exists for this date");
    const result = (await tx.execute<{ id: string; method: string; effectiveFrom: string }>(sql`insert into lease_escalations(org_id,lease_id,effective_on,method,value,created_by,updated_by)
      select ${input.orgId},id,${effectiveOn},${input.method},${value},${input.actorId},${input.actorId}
        from property_leases where org_id=${input.orgId} and id=${input.leaseId} and status in ('draft','active','notice')
      returning id,method,effective_on::text as "effectiveFrom"`));
    const escalation = result.rows[0];
    if (!escalation) throw new PropertyManagementError("Lease not found");
    // A scheduled escalation changes future rent when applied: like every
    // financial-term write here, the row and its audit evidence commit as
    // one unit.
    await audit(tx, input.orgId, "lease_escalations", escalation.id, "insert", input.actorId,
      { after: { leaseId: input.leaseId, effectiveOn: escalation.effectiveFrom, method: escalation.method, value } },
      input.requestId ?? null);
    return { id: escalation.id };
  });
}
export async function applyLeaseEscalation(orgId: string, actorId: string, allowedSubsidiaryIds: ReadonlySet<string> | null, escalationId: string): Promise<{ chargeId: string; newAmount: string }> {
  const applied = await db.transaction(async (tx) => {
    await assertEnabled(tx, orgId);
    const escalation = (await tx.execute<LeaseEscalationDbRow>(sql`select * from lease_escalations where org_id=${orgId} and id=${escalationId} for update`));
    const e = escalation.rows[0]; if (!e || e.status !== "scheduled") throw new PropertyManagementError("Scheduled escalation not found");
    await lockLeasePropertyInScope(tx, orgId, String(e.lease_id), allowedSubsidiaryIds);
    // Escalations compound: each one is computed from the rent in force on its
    // effective date, so they must be applied in effective-date order. An
    // earlier scheduled one must go first, and a later one already applied
    // (by whatever path) means this one can no longer be computed correctly.
    const ordering = (await tx.execute<{ effective_on: string; status: string }>(sql`
      select effective_on::text as effective_on,status from lease_escalations
       where org_id=${orgId} and lease_id=${e.lease_id} and id<>${escalationId}
         and ((status='scheduled' and effective_on<${e.effective_on}) or (status='applied' and effective_on>${e.effective_on}))
       order by effective_on limit 1`)).rows[0];
    if (ordering?.status === "scheduled") {
      throw new PropertyManagementError(`Apply the earlier scheduled escalation effective ${ordering.effective_on} first; escalations compound in effective-date order`);
    }
    if (ordering?.status === "applied") {
      throw new PropertyManagementError(`A later escalation effective ${ordering.effective_on} is already applied; escalations compound in effective-date order`);
    }
    const chargeResult = (await tx.execute<BaseRentChargeRow>(sql`select * from lease_charges where org_id=${orgId} and lease_id=${e.lease_id} and charge_type='base_rent' and effective_from<=${e.effective_on} and (effective_to is null or effective_to>=${e.effective_on}) order by effective_from desc, id desc limit 1 for update`));
    const charge = chargeResult.rows[0]; if (!charge) throw new PropertyManagementError("Effective base-rent charge not found");
    if (e.effective_on <= charge.effective_from) throw new PropertyManagementError("Escalation must begin after the current rent charge starts");
    // Stored charges and the scheduled escalation stay. Copying an inventory /
    // assembly / kit item onto a new charge is Inventory configuration.
    if (charge.item_id && !(await inventoryFeatureEnabled(tx, orgId))) {
      const item = (await tx.execute<{ kind: string }>(sql`
        select kind from items where id = ${charge.item_id} and org_id = ${orgId}`));
      if (item.rows[0] && INVENTORY_ITEM_KINDS.has(item.rows[0].kind)) {
        throw new PropertyManagementError("Inventory is disabled", 404);
      }
    }
    // Stored charges and the scheduled escalation stay. Turning Equipment
    // off must refuse an apply that would persist equipment_charge.
    if (charge.item_id) {
      // Canonical switchboard read (::boolean casts threw on non-boolean imports).
      const equipmentOn = await orgFeatureEnabled(orgId, "equipment", tx as SqlExecutor);
      if (!equipmentOn) {
        const item = (await tx.execute<{ kind: string }>(sql`
          select kind from items where id = ${charge.item_id} and org_id = ${orgId}`));
        if (item.rows[0] && item.rows[0].kind === "equipment_charge") {
          throw new PropertyManagementError("Equipment is disabled", 404);
        }
      }
    }
    const alreadyBilled = (await tx.execute(sql`select 1 from lease_schedule_lines where org_id=${orgId} and charge_id=${charge.id}
      and status in ('invoiced','credited') and period_ends_on>=${e.effective_on} limit 1`));
    if (alreadyBilled.rows.length) throw new PropertyManagementError("Affected rent is already billed; credit or void it before applying this escalation");
    const next = escalatedRent(charge.amount, e.method, e.value);
    const scheduled = (await tx.execute<{ id: string; period_starts_on: string; period_ends_on: string; amount: string }>(sql`select id,period_starts_on,period_ends_on,amount from lease_schedule_lines
      where org_id=${orgId} and charge_id=${charge.id} and status='scheduled' and period_ends_on>=${e.effective_on} for update`));
    for (const period of scheduled.rows) {
      if (period.period_starts_on >= e.effective_on) {
        await tx.execute(sql`update lease_schedule_lines set status='cancelled',updated_at=now(),updated_by=${actorId} where org_id=${orgId} and id=${period.id}`);
      } else {
        const oldEnd = addDays(e.effective_on, -1);
        const amount = mulRatio(period.amount, BigInt(dayCount(period.period_starts_on, oldEnd)), BigInt(dayCount(period.period_starts_on, period.period_ends_on)));
        await tx.execute(sql`update lease_schedule_lines set period_ends_on=${oldEnd},amount=${amount},updated_at=now(),updated_by=${actorId} where org_id=${orgId} and id=${period.id}`);
      }
    }
    await tx.execute(sql`update lease_charges set effective_to=(${e.effective_on}::date-interval '1 day')::date,updated_at=now(),updated_by=${actorId} where id=${charge.id} and org_id=${orgId}`);
    const inserted = (await tx.execute<{ id: string }>(sql`insert into lease_charges(org_id,lease_id,charge_type,description,amount,frequency,effective_from,effective_to,income_account_id,item_id,tax_code_id,created_by,updated_by)
      values(${orgId},${e.lease_id},'base_rent',${charge.description},${next},${charge.frequency},${e.effective_on},${charge.effective_to},${charge.income_account_id},${charge.item_id},${charge.tax_code_id},${actorId},${actorId}) returning id`));
    await tx.execute(sql`update lease_escalations set status='applied',previous_amount=${charge.amount},new_amount=${next},applied_at=now(),applied_by=${actorId},updated_at=now(),updated_by=${actorId} where id=${escalationId} and org_id=${orgId}`);
    await audit(tx, orgId, "lease_escalations", escalationId, "apply", actorId, { previousAmount: charge.amount, newAmount: next, effectiveOn: e.effective_on });
    await generateLeaseSchedule(tx, orgId, actorId, e.lease_id);
    return { chargeId: inserted.rows[0]!.id, newAmount: next };
  });
  return applied;
}

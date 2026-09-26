/** Lease and charge writes. Split from property/management.ts (pure moves only). */
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { cmp, normalizeMoney } from "../money/money.ts";
import { assertEnabled, audit, exactMoney, lockLeasePropertyInScope, lockPropertiesInScope, lockPropertyInScope, PropertyManagementError, UUID_RE, validDate } from "./management-foundation.ts";

export async function createPropertyLease(input: {
  orgId: string; actorId: string; allowedSubsidiaryIds: ReadonlySet<string> | null; propertyId: string; unitId?: string | null; tenantId: string; leaseNumber: string;
  startsOn: string; endsOn?: string | null; baseRent: string; billingDay?: number; paymentTermsDays?: number;
  securityDepositRequired?: string; camMethod?: "none" | "fixed" | "pro_rata"; camSharePercent?: string | null;
  lateFeeType?: "none" | "fixed" | "percent"; lateFeeValue?: string; graceDays?: number; autoInvoice?: boolean; autoPost?: boolean;
  requestId?: string | null;
}): Promise<{ id: string }> {
  const leaseNumber = input.leaseNumber.trim(); const startsOn = validDate(input.startsOn, "Lease start")!;
  const endsOn = validDate(input.endsOn, "Lease end"); const baseRent = exactMoney(input.baseRent, "Base rent");
  const camShare = input.camSharePercent == null || input.camSharePercent === "" ? null : exactMoney(input.camSharePercent, "CAM share");
  const deposit = exactMoney(input.securityDepositRequired ?? "0", "Security deposit");
  const lateFeeValue = (input.lateFeeType ?? "none") === "none" ? "0.0000" : exactMoney(input.lateFeeValue ?? "0", "Late-fee value");
  const billingDay = input.billingDay ?? 1;
  const paymentTermsDays = input.paymentTermsDays ?? 0;
  const graceDays = input.graceDays ?? 0;
  const camMethod = input.camMethod ?? "none";
  const lateFeeType = input.lateFeeType ?? "none";
  const autoInvoice = input.autoInvoice ?? true;
  const autoPost = input.autoPost ?? false;
  if (!leaseNumber || !startsOn || cmp(baseRent, "0") <= 0) throw new PropertyManagementError("Lease number, start date, and positive base rent are required");
  if (endsOn && endsOn < startsOn) throw new PropertyManagementError("Lease end cannot precede start");
  if (!Number.isInteger(billingDay) || billingDay < 1 || billingDay > 31) throw new PropertyManagementError("Billing day must be between 1 and 31");
  if (!Number.isInteger(paymentTermsDays) || paymentTermsDays < 0 || !Number.isInteger(graceDays) || graceDays < 0) {
    throw new PropertyManagementError("Payment terms and grace days must be non-negative whole numbers");
  }
  if (cmp(deposit, "0") < 0) throw new PropertyManagementError("Security deposit cannot be negative");
  if (!["none", "fixed", "pro_rata"].includes(camMethod)) throw new PropertyManagementError("Invalid CAM method");
  if (camShare != null && (cmp(camShare, "0") < 0 || cmp(camShare, "100") > 0)) throw new PropertyManagementError("CAM share must be between 0 and 100");
  if (!["none", "fixed", "percent"].includes(lateFeeType)) throw new PropertyManagementError("Invalid late-fee type");
  if (lateFeeType !== "none" && cmp(lateFeeValue, "0") <= 0) throw new PropertyManagementError("Late-fee value must be positive");
  if (lateFeeType === "percent" && cmp(lateFeeValue, "100") > 0) throw new PropertyManagementError("Late-fee percent cannot exceed 100");
  return db.transaction(async (tx) => {
    await assertEnabled(tx, input.orgId);
    await lockPropertyInScope(tx, input.orgId, input.propertyId, input.allowedSubsidiaryIds);
    const scope = (await tx.execute<{ id: string; rent_income_account_id: string | null; tenant_ok: boolean; unit_ok: boolean }>(sql`
      select p.id,p.rent_income_account_id,
        exists(select 1 from customer_roles cr where cr.org_id=p.org_id and cr.party_id=${input.tenantId} and cr.is_active) as tenant_ok,
        (${input.unitId ?? null}::uuid is null or exists(select 1 from property_units u where u.org_id=p.org_id and u.id=${input.unitId ?? null} and u.property_id=p.id and u.status<>'offline')) as unit_ok
      from managed_properties p where p.org_id=${input.orgId} and p.id=${input.propertyId} and p.status='active'
    `));
    const property = scope.rows[0];
    if (!property) throw new PropertyManagementError("Active property not found");
    if (!property.tenant_ok) throw new PropertyManagementError("Tenant must be an active customer");
    if (!property.unit_ok) throw new PropertyManagementError("Unit does not belong to this property");
    if (!property.rent_income_account_id) throw new PropertyManagementError("Configure the property rent income account first");
    const duplicateNumber = (await tx.execute(sql`select 1 from property_leases where org_id=${input.orgId} and lease_number=${leaseNumber} limit 1`));
    if (duplicateNumber.rows.length) throw new PropertyManagementError("Lease number already exists");
    const inserted = (await tx.execute<{ id: string }>(sql`
      insert into property_leases(org_id,property_id,unit_id,tenant_id,lease_number,starts_on,ends_on,billing_day,payment_terms_days,
        security_deposit_required,cam_method,cam_share_percent,late_fee_type,late_fee_value,grace_days,auto_invoice,auto_post,created_by,updated_by)
      values(${input.orgId},${input.propertyId},${input.unitId ?? null},${input.tenantId},${leaseNumber},${startsOn},${endsOn},${billingDay},
        ${paymentTermsDays},${deposit},${camMethod},${camShare},
        ${lateFeeType},${lateFeeValue},${graceDays},${autoInvoice},${autoPost},${input.actorId},${input.actorId}) returning id
    `));
    const id = inserted.rows[0]!.id;
    await tx.execute(sql`insert into lease_charges(org_id,lease_id,charge_type,description,amount,frequency,effective_from,effective_to,income_account_id,created_by,updated_by)
      values(${input.orgId},${id},'base_rent','Base rent',${baseRent},'monthly',${startsOn},${endsOn},${property.rent_income_account_id},${input.actorId},${input.actorId})`);
    // Every financial term commits with its complete after-state in the same
    // transaction: the terms below drive future invoices and postings, so a
    // forced audit failure rolls the whole lease back rather than leaving an
    // unaudited money-moving row behind.
    await audit(tx, input.orgId, "property_leases", id, "insert", input.actorId, { after: {
      leaseNumber, propertyId: input.propertyId, unitId: input.unitId ?? null, tenantId: input.tenantId,
      startsOn, endsOn, baseRent, billingDay, paymentTermsDays, securityDepositRequired: deposit,
      camMethod, camSharePercent: camShare, lateFeeType, lateFeeValue, graceDays, autoInvoice, autoPost,
    } }, input.requestId ?? null);
    return { id };
  });
}
export async function updatePropertyLease(input: {
  orgId: string; actorId: string; allowedSubsidiaryIds: ReadonlySet<string> | null; leaseId: string; propertyId: string; unitId?: string | null; tenantId: string; leaseNumber: string;
  startsOn: string; endsOn?: string | null; baseRent: string; billingDay: number; paymentTermsDays: number;
  securityDepositRequired: string; camMethod: "none" | "fixed" | "pro_rata"; camSharePercent?: string | null;
  lateFeeType: "none" | "fixed" | "percent"; lateFeeValue: string; graceDays: number; autoInvoice: boolean; autoPost: boolean;
  requestId?: string | null;
}): Promise<{ id: string }> {
  const leaseNumber = input.leaseNumber.trim();
  const startsOn = validDate(input.startsOn, "Lease start")!;
  const endsOn = validDate(input.endsOn, "Lease end");
  const baseRent = exactMoney(input.baseRent, "Base rent");
  const deposit = exactMoney(input.securityDepositRequired, "Security deposit");
  const camShare = input.camSharePercent == null || input.camSharePercent === "" ? null : exactMoney(input.camSharePercent, "CAM share");
  const lateFeeValue = input.lateFeeType === "none" ? "0.0000" : exactMoney(input.lateFeeValue, "Late-fee value");
  if (!leaseNumber || cmp(baseRent, "0") <= 0) throw new PropertyManagementError("Lease number and positive base rent are required");
  if (endsOn && endsOn < startsOn) throw new PropertyManagementError("Lease end cannot precede start");
  if (!Number.isInteger(input.billingDay) || input.billingDay < 1 || input.billingDay > 31) throw new PropertyManagementError("Billing day must be between 1 and 31");
  if (!Number.isInteger(input.paymentTermsDays) || input.paymentTermsDays < 0 || !Number.isInteger(input.graceDays) || input.graceDays < 0) {
    throw new PropertyManagementError("Payment terms and grace days must be non-negative whole numbers");
  }
  if (cmp(deposit, "0") < 0) throw new PropertyManagementError("Security deposit cannot be negative");
  if (!(["none", "fixed", "pro_rata"] as string[]).includes(input.camMethod)) throw new PropertyManagementError("Invalid CAM method");
  if (camShare != null && (cmp(camShare, "0") < 0 || cmp(camShare, "100") > 0)) throw new PropertyManagementError("CAM share must be between 0 and 100");
  if (!(["none", "fixed", "percent"] as string[]).includes(input.lateFeeType)) throw new PropertyManagementError("Invalid late-fee type");
  if (input.lateFeeType !== "none" && cmp(lateFeeValue, "0") <= 0) throw new PropertyManagementError("Late-fee value must be positive");
  if (input.lateFeeType === "percent" && cmp(lateFeeValue, "100") > 0) throw new PropertyManagementError("Late-fee percent cannot exceed 100");
  return db.transaction(async (tx) => {
    await assertEnabled(tx, input.orgId);
    const currentResult = (await tx.execute<{
      id: string; status: string; propertyId: string; unitId: string | null; tenantId: string; startsOn: string; endsOn: string | null;
      billingDay: number; baseRent: string; leaseNumber: string; paymentTermsDays: number; securityDepositRequired: string;
      camMethod: string; camSharePercent: string | null; lateFeeType: string; lateFeeValue: string; graceDays: number;
      autoInvoice: boolean; autoPost: boolean;
    }>(sql`
      select l.id,l.status,l.property_id as "propertyId",l.unit_id as "unitId",l.tenant_id as "tenantId",l.starts_on::text as "startsOn",
        l.ends_on::text as "endsOn",l.billing_day as "billingDay",l.lease_number as "leaseNumber",l.payment_terms_days as "paymentTermsDays",
        l.security_deposit_required::text as "securityDepositRequired",l.cam_method as "camMethod",l.cam_share_percent::text as "camSharePercent",
        l.late_fee_type as "lateFeeType",l.late_fee_value::text as "lateFeeValue",l.grace_days as "graceDays",
        l.auto_invoice as "autoInvoice",l.auto_post as "autoPost",
        (select amount from lease_charges where org_id=l.org_id and lease_id=l.id and charge_type='base_rent' order by effective_from desc limit 1) as "baseRent"
      from property_leases l where l.org_id=${input.orgId} and l.id=${input.leaseId} for update
    `));
    const current = currentResult.rows[0];
    if (!current || !["draft", "active", "notice"].includes(current.status)) throw new PropertyManagementError("Editable lease not found");
    // Both the lease's current property and the move target are locked and
    // rechecked: a draft lease may move properties, and the target check in
    // the route runs outside this transaction. The pair locks in ascending
    // id order (see lockPropertiesInScope) so opposite concurrent moves
    // cannot take the same two rows in opposite orders.
    await lockPropertiesInScope(tx, input.orgId, [String(current.propertyId), input.propertyId], input.allowedSubsidiaryIds);
    const duplicateNumber = (await tx.execute(sql`select 1 from property_leases
      where org_id=${input.orgId} and lease_number=${leaseNumber} and id<>${input.leaseId} limit 1`));
    if (duplicateNumber.rows.length) throw new PropertyManagementError("Lease number already exists");
    const draft = current.status === "draft";
    if (!draft && (current.propertyId !== input.propertyId || current.unitId !== (input.unitId ?? null) || current.tenantId !== input.tenantId || current.startsOn !== startsOn)) {
      throw new PropertyManagementError("Property, unit, tenant, and start date cannot change after activation");
    }
    if (!draft && (current.billingDay !== input.billingDay || cmp(current.baseRent, baseRent) !== 0)) {
      throw new PropertyManagementError("Use rent escalation to change active rent; billing day is fixed after activation");
    }
    if (!draft && ((current.endsOn == null && endsOn != null) || (current.endsOn != null && endsOn != null && endsOn < current.endsOn))) {
      throw new PropertyManagementError("An active lease term may only be extended");
    }
    const scope = (await tx.execute<{ id: string; rent_income_account_id: string | null; tenant_ok: boolean; unit_ok: boolean; unit_available: boolean }>(sql`
      select p.id,p.rent_income_account_id,
        exists(select 1 from customer_roles cr where cr.org_id=p.org_id and cr.party_id=${input.tenantId} and cr.is_active) as tenant_ok,
        (${input.unitId ?? null}::uuid is null or exists(select 1 from property_units u where u.org_id=p.org_id and u.id=${input.unitId ?? null} and u.property_id=p.id and u.status<>'offline')) as unit_ok,
        (${input.unitId ?? null}::uuid is null or not exists(select 1 from property_leases x where x.org_id=p.org_id and x.unit_id=${input.unitId ?? null} and x.id<>${input.leaseId} and x.status in ('active','notice'))) as unit_available
      from managed_properties p where p.org_id=${input.orgId} and p.id=${input.propertyId} and p.status='active'
    `));
    const property = scope.rows[0];
    if (!property) throw new PropertyManagementError("Active property not found");
    if (!property.tenant_ok) throw new PropertyManagementError("Tenant must be an active customer");
    if (!property.unit_ok || !property.unit_available) throw new PropertyManagementError("Unit is unavailable for this lease");
    if (!property.rent_income_account_id) throw new PropertyManagementError("Configure the property rent income account first");
    await tx.execute(sql`
      update property_leases set property_id=${input.propertyId},unit_id=${input.unitId ?? null},tenant_id=${input.tenantId},lease_number=${leaseNumber},
        starts_on=${startsOn},ends_on=${endsOn},billing_day=${input.billingDay},payment_terms_days=${input.paymentTermsDays},
        security_deposit_required=${deposit},cam_method=${input.camMethod},cam_share_percent=${input.camMethod === "none" ? null : camShare},
        late_fee_type=${input.lateFeeType},late_fee_value=${lateFeeValue},grace_days=${input.graceDays},auto_invoice=${input.autoInvoice},auto_post=${input.autoPost},
        updated_at=now(),updated_by=${input.actorId} where org_id=${input.orgId} and id=${input.leaseId}
    `);
    if (draft) {
      await tx.execute(sql`
        update lease_charges set amount=${baseRent},effective_from=${startsOn},effective_to=${endsOn},income_account_id=${property.rent_income_account_id},
          updated_at=now(),updated_by=${input.actorId} where org_id=${input.orgId} and lease_id=${input.leaseId} and charge_type='base_rent'
      `);
    } else if (current.endsOn != null && (endsOn == null || endsOn > current.endsOn)) {
      // Term extension. The base-rent window that ends exactly on the old
      // lease end is the term-derived one (creation, or the successor an
      // escalation inserted); it follows the new end so the extended months
      // schedule, bill, and escalate. Windows an escalation already closed
      // earlier stay closed. Storage constraint 0060 still refuses any overlap.
      const extended = (await tx.execute<{ id: string; effectiveFrom: string; amount: string }>(sql`
        update lease_charges set effective_to=${endsOn},updated_at=now(),updated_by=${input.actorId}
         where org_id=${input.orgId} and lease_id=${input.leaseId} and charge_type='base_rent' and effective_to=${current.endsOn}
         returning id,effective_from::text as "effectiveFrom",amount::text as amount
      `));
      for (const window of extended.rows) {
        await audit(tx, input.orgId, "lease_charges", window.id, "update", input.actorId, {
          reason: "lease term extended", leaseId: input.leaseId, chargeType: "base_rent",
          before: { effectiveFrom: window.effectiveFrom, effectiveTo: current.endsOn, amount: normalizeMoney(window.amount) },
          after: { effectiveFrom: window.effectiveFrom, effectiveTo: endsOn, amount: normalizeMoney(window.amount) },
        }, input.requestId ?? null);
      }
    }
    await audit(tx, input.orgId, "property_leases", input.leaseId, "update", input.actorId, (() => {
      // The before/after pair covers every money-moving term: term dates,
      // tenant, base rent, payment terms, deposit, CAM policy, late-fee
      // policy, grace days, and the auto-invoice/auto-post switches. These
      // values drive future invoices and postings, so a partial audit cannot
      // reconstruct what changed.
      const before = {
        leaseNumber: current.leaseNumber, propertyId: current.propertyId, unitId: current.unitId,
        tenantId: current.tenantId, startsOn: current.startsOn, endsOn: current.endsOn,
        billingDay: current.billingDay, paymentTermsDays: current.paymentTermsDays,
        securityDepositRequired: normalizeMoney(current.securityDepositRequired), camMethod: current.camMethod,
        camSharePercent: current.camSharePercent == null ? null : normalizeMoney(current.camSharePercent),
        lateFeeType: current.lateFeeType, lateFeeValue: normalizeMoney(current.lateFeeValue),
        graceDays: current.graceDays, autoInvoice: current.autoInvoice, autoPost: current.autoPost,
        baseRent: current.baseRent == null ? null : normalizeMoney(current.baseRent),
      };
      const after = {
        leaseNumber, propertyId: input.propertyId, unitId: input.unitId ?? null, tenantId: input.tenantId,
        startsOn, endsOn, billingDay: input.billingDay, paymentTermsDays: input.paymentTermsDays,
        securityDepositRequired: deposit, camMethod: input.camMethod,
        camSharePercent: camShare, lateFeeType: input.lateFeeType, lateFeeValue,
        graceDays: input.graceDays, autoInvoice: input.autoInvoice, autoPost: input.autoPost,
        baseRent,
      };
      return {
        before,
        after,
        changedFields: Object.keys(after).filter((key) => JSON.stringify(after[key as keyof typeof after]) !== JSON.stringify(before[key as keyof typeof before])),
      };
    })(), input.requestId ?? null);
    return { id: input.leaseId };
  });
}
export async function cancelPropertyLease(orgId: string, actorId: string, allowedSubsidiaryIds: ReadonlySet<string> | null, leaseId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await assertEnabled(tx, orgId);
    await lockLeasePropertyInScope(tx, orgId, leaseId, allowedSubsidiaryIds);
    const result = (await tx.execute<{ leaseNumber: string }>(sql`
      update property_leases set status='cancelled',updated_at=now(),updated_by=${actorId}
      where org_id=${orgId} and id=${leaseId} and status='draft' returning lease_number as "leaseNumber"
    `));
    if (!result.rows[0]) throw new PropertyManagementError("Draft lease not found");
    await audit(tx, orgId, "property_leases", leaseId, "cancel", actorId, { after: { status: "cancelled" }, leaseNumber: result.rows[0].leaseNumber });
  });
}
/** Optional uuid refs arrive as "" from unfilled form fields; blanks are absent. */
export function emptyRefToNull(value: string | null | undefined): string | null {
  return value == null || value.trim() === "" ? null : value;
}
export async function addLeaseCharge(input: { orgId: string; actorId: string; allowedSubsidiaryIds: ReadonlySet<string> | null; leaseId: string; chargeType: string; description: string; amount: string; frequency: string; effectiveFrom: string; effectiveTo?: string | null; incomeAccountId?: string | null; itemId?: string | null; taxCodeId?: string | null; requestId?: string | null }): Promise<{ id: string }> {
  // Base rent versions exclusively through the lease term and its controlled
  // escalations; a caller-supplied second base_rent beside the canonical row
  // would double-bill every covered period (storage constraint 0060 refuses
  // it too, so even direct writes cannot create the overlap).
  if (input.chargeType === "base_rent") {
    throw new PropertyManagementError("Base rent changes belong on the lease and its controlled escalations");
  }
  if (!["cam", "parking", "storage", "utility", "late_fee", "other"].includes(input.chargeType)) {
    throw new PropertyManagementError("Invalid charge type");
  }
  if (!["monthly", "quarterly", "annually", "one_time"].includes(input.frequency)) {
    throw new PropertyManagementError("Invalid charge frequency");
  }
  const amount = exactMoney(input.amount, "Charge amount");
  if (!input.description.trim() || cmp(amount, "0") <= 0) throw new PropertyManagementError("Charge description and positive amount are required");
  const effectiveFrom = validDate(input.effectiveFrom, "Charge start");
  if (!effectiveFrom) throw new PropertyManagementError("Charge start is required");
  const effectiveTo = validDate(input.effectiveTo, "Charge end");
  if (effectiveTo && effectiveTo < effectiveFrom) throw new PropertyManagementError("Charge end cannot precede start");
  return db.transaction(async (tx) => {
    await assertEnabled(tx, input.orgId);
    await lockLeasePropertyInScope(tx, input.orgId, input.leaseId, input.allowedSubsidiaryIds);
    if (input.incomeAccountId != null) {
      if (!UUID_RE.test(input.incomeAccountId)) throw new PropertyManagementError("Charge income account is invalid");
      const income = (await tx.execute<{ ok: boolean }>(sql`select exists(select 1 from accounts
        where org_id=${input.orgId} and id=${input.incomeAccountId} and type in ('income','income_other') and is_active and not is_summary) as ok`));
      if (!income.rows[0]?.ok) throw new PropertyManagementError("Charge income account must be an active income account");
    }
    if (input.itemId != null) {
      if (!UUID_RE.test(input.itemId)) throw new PropertyManagementError("Charge item is invalid");
      const item = (await tx.execute<{ ok: boolean }>(sql`select exists(select 1 from items
        where org_id=${input.orgId} and id=${input.itemId} and is_active) as ok`));
      if (!item.rows[0]?.ok) throw new PropertyManagementError("Charge item must be an active item");
    }
    // The charge form has no tax field and posts an empty string when unset;
    // treat it as absent like a missing value rather than a malformed uuid.
    const taxCodeId = emptyRefToNull(input.taxCodeId);
    if (taxCodeId != null) {
      if (!UUID_RE.test(taxCodeId)) throw new PropertyManagementError("Charge tax code is invalid");
      const tax = (await tx.execute<{ ok: boolean }>(sql`select exists(select 1 from tax_codes
        where org_id=${input.orgId} and id=${taxCodeId} and is_active) as ok`));
      if (!tax.rows[0]?.ok) throw new PropertyManagementError("Charge tax code must be an active tax code");
    }
    const result = (await tx.execute<{
      id: string; chargeType: string; description: string; amount: string; frequency: string;
      effectiveFrom: string; effectiveTo: string | null; incomeAccountId: string | null;
    }>(sql`
      insert into lease_charges(org_id,lease_id,charge_type,description,amount,frequency,effective_from,effective_to,income_account_id,item_id,tax_code_id,created_by,updated_by)
      select ${input.orgId},l.id,${input.chargeType},${input.description.trim()},${amount},${input.frequency},${effectiveFrom},${effectiveTo},
        coalesce(${input.incomeAccountId ?? null},case when ${input.chargeType}='cam' then p.cam_income_account_id else p.rent_income_account_id end)::uuid,
        ${input.itemId ?? null},${taxCodeId},${input.actorId},${input.actorId}
        from property_leases l join managed_properties p on p.id=l.property_id and p.org_id=l.org_id
       where l.org_id=${input.orgId} and l.id=${input.leaseId} and l.status in ('draft','active')
       returning id,charge_type as "chargeType",description,amount::text,frequency,effective_from::text as "effectiveFrom",
         effective_to::text as "effectiveTo",income_account_id::text as "incomeAccountId"
    `));
    const charge = result.rows[0];
    if (!charge) throw new PropertyManagementError("Editable lease not found");
    // The schedule this row generates invoices the tenant: it commits only if
    // its audit evidence commits in the same transaction.
    await audit(tx, input.orgId, "lease_charges", charge.id, "insert", input.actorId,
      { after: { leaseId: input.leaseId, chargeType: charge.chargeType, description: charge.description, amount: charge.amount, frequency: charge.frequency, effectiveFrom: charge.effectiveFrom, effectiveTo: charge.effectiveTo, incomeAccountId: charge.incomeAccountId } },
      input.requestId ?? null);
    return { id: charge.id };
  });
}

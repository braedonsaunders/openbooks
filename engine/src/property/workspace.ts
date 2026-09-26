/** Read models, public row types, management workspace. Split from property/management.ts (pure moves only). */
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { businessToday } from "../platform/business-date.ts";
import { subsidiaryVisibleFilter, withScopeSnapshot } from "../organization/subsidiary-scope.ts";
import { uuidArray } from "../organization/subsidiaries.ts";
import { add, cmp, neg, normalizeMoney, sum } from "../money/money.ts";
import { assertEnabled, validDate, type DepositBankRow, type DepositLeaseRow, type DepositPropertyRow } from "./management-foundation.ts";

export async function securityDepositReconciliation(orgId: string, allowedSubsidiaryIds: ReadonlySet<string> | null, asOf?: string) {
  const throughOn = validDate(asOf ?? await businessToday(orgId), "Reconciliation date")!;
  await assertEnabled(db, orgId);
  // One repeatable-read snapshot, scoped before aggregating: org-wide
  // totals computed first and filtered after would mix a stale header with
  // fresh lines across a concurrent rehome, so the scope predicate sits on
  // the property read and every subordinate follows those ids.
  return withScopeSnapshot(orgId, async () => {
  const properties = (await db.execute<DepositPropertyRow>(sql`
    select p.id as "propertyId",p.code as "propertyCode",p.name as "propertyName",p.subsidiary_id as "subsidiaryId",p.location_id as "locationId",p.currency,
      p.deposit_liability_account_id as "liabilityAccountId",concat_ws(' · ',la.number,la.name) as "liabilityAccountName",
      p.default_bank_account_id as "defaultBankAccountId",concat_ws(' · ',ba.number,ba.name) as "defaultBankAccountName",
      coalesce((select sum(case when d.kind in ('received','interest','adjustment_increase') then d.amount else -d.amount end)
        from security_deposit_transactions d join property_leases l on l.id=d.lease_id and l.org_id=d.org_id
        where d.org_id=p.org_id and l.property_id=p.id and d.occurred_on<=${throughOn}),0)::text as "subledgerBalance",
      coalesce((select -sum(jl.amount) from security_deposit_transactions d
        join property_leases l on l.id=d.lease_id and l.org_id=d.org_id
        join journal_entries je on je.id=d.journal_entry_id and je.org_id=d.org_id and je.status='posted'
        join journal_lines jl on jl.entry_id=je.id and jl.org_id=je.org_id and jl.account_id=p.deposit_liability_account_id
        where d.org_id=p.org_id and l.property_id=p.id and d.occurred_on<=${throughOn}),0)::text as "linkedGlBalance",
      case when p.location_id is null or p.deposit_liability_account_id is null then null else
        coalesce((select -sum(jl.amount) from journal_lines jl join journal_entries je on je.id=jl.entry_id and je.org_id=jl.org_id
          where jl.org_id=p.org_id and je.status='posted' and je.posting_date<=${throughOn}
            and jl.account_id=p.deposit_liability_account_id and jl.location_id=p.location_id),0)::text end as "locationControlBalance",
      coalesce((select sum(case when d.kind='received' then d.amount when d.kind='refunded' then -d.amount else 0 end)
        from security_deposit_transactions d join property_leases l on l.id=d.lease_id and l.org_id=d.org_id
        where d.org_id=p.org_id and l.property_id=p.id and d.occurred_on<=${throughOn}),0)::text as "cashActivity",
      (select max(d.occurred_on)::text from security_deposit_transactions d join property_leases l on l.id=d.lease_id and l.org_id=d.org_id
        where d.org_id=p.org_id and l.property_id=p.id and d.occurred_on<=${throughOn}) as "lastActivityOn"
    from managed_properties p
    left join accounts la on la.id=p.deposit_liability_account_id and la.org_id=p.org_id
    left join accounts ba on ba.id=p.default_bank_account_id and ba.org_id=p.org_id
    where p.org_id=${orgId}
      ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds)} order by p.name
  `));
  const scopedPropertyIds = uuidArray(properties.rows.map((row) => String(row.propertyId)));
  const banks = (await db.execute<DepositBankRow>(sql`
    select l.property_id as "propertyId",d.bank_account_id as "bankAccountId",concat_ws(' · ',a.number,a.name) as "bankAccountName",
      sum(case when d.kind='received' then d.amount when d.kind='refunded' then -d.amount else 0 end)::text as "cashActivity"
    from security_deposit_transactions d join property_leases l on l.id=d.lease_id and l.org_id=d.org_id
    join accounts a on a.id=d.bank_account_id and a.org_id=d.org_id
    where d.org_id=${orgId} and d.occurred_on<=${throughOn} and d.bank_account_id is not null
      and l.property_id = any(${scopedPropertyIds}::uuid[])
    group by l.property_id,d.bank_account_id,a.number,a.name order by a.number,a.name
  `));
  const leases = (await db.execute<DepositLeaseRow>(sql`
    select l.id as "leaseId",l.property_id as "propertyId",l.lease_number as "leaseNumber",l.status,t.display_name as "tenantName",u.code as "unitCode",
      coalesce(sum(case when d.kind in ('received','interest','adjustment_increase') then d.amount else -d.amount end),0)::text as balance,
      max(d.occurred_on)::text as "lastActivityOn"
    from property_leases l join parties t on t.id=l.tenant_id and t.org_id=l.org_id
    left join property_units u on u.id=l.unit_id and u.org_id=l.org_id
    left join security_deposit_transactions d on d.lease_id=l.id and d.org_id=l.org_id and d.occurred_on<=${throughOn}
    where l.org_id=${orgId} and l.property_id = any(${scopedPropertyIds}::uuid[])
    group by l.id,t.display_name,u.code order by l.lease_number
  `));
  // The location control balance is keyed by (liability account, location)
  // only, so every property sharing both reads the SAME combined GL balance.
  // Claiming a per-property variance from that shared balance manufactures a
  // discrepancy for each balanced property in the group. Shared controls
  // reconcile as one aggregated group; unique controls keep per-property
  // variance.
  const controlKeyOf = (liabilityAccountId: string | null, locationId: string | null): string | null =>
    liabilityAccountId && locationId ? `${liabilityAccountId}|${locationId}` : null;
  const controlGroupSize = new Map<string, number>();
  for (const row of properties.rows) {
    const key = controlKeyOf(row.liabilityAccountId, row.locationId);
    if (key) controlGroupSize.set(key, (controlGroupSize.get(key) ?? 0) + 1);
  }
  const controlGroupSubledger = new Map<string, string>();
  for (const row of properties.rows) {
    const key = controlKeyOf(row.liabilityAccountId, row.locationId);
    if (!key) continue;
    controlGroupSubledger.set(key, add(controlGroupSubledger.get(key) ?? "0.0000", normalizeMoney(row.subledgerBalance ?? "0")));
  }
  const rows = properties.rows.map((row) => {
    const subledgerBalance = normalizeMoney(row.subledgerBalance ?? "0");
    const linkedGlBalance = normalizeMoney(row.linkedGlBalance ?? "0");
    const locationControlBalance = row.locationControlBalance == null ? null : normalizeMoney(row.locationControlBalance);
    const linkedVariance = add(linkedGlBalance, neg(subledgerBalance));
    const controlKey = controlKeyOf(row.liabilityAccountId, row.locationId);
    const controlShared = controlKey != null && (controlGroupSize.get(controlKey) ?? 0) > 1;
    const controlGroupPropertyIds = controlKey == null
      ? []
      : properties.rows
        .filter((peer) => controlKeyOf(peer.liabilityAccountId, peer.locationId) === controlKey)
        .map((peer) => peer.propertyId);
    // A shared GL balance covers the whole group, so no per-property variance
    // is claimed from it; the group reconciles on its combined variance.
    const controlVariance = locationControlBalance == null || controlShared
      ? null
      : add(locationControlBalance, neg(subledgerBalance));
    const controlGroupBalance = controlKey == null || locationControlBalance == null ? null : locationControlBalance;
    const controlGroupVariance = controlGroupBalance == null || controlKey == null
      ? null
      : add(controlGroupBalance, neg(controlGroupSubledger.get(controlKey) ?? "0.0000"));
    const groupVariance = controlShared && controlGroupVariance != null && cmp(controlGroupVariance, "0") !== 0;
    const status = !row.liabilityAccountId
      ? "configuration_required"
      : cmp(linkedVariance, "0") !== 0 || groupVariance || (controlVariance != null && cmp(controlVariance, "0") !== 0)
        ? "discrepancy"
        : !row.locationId
          ? "limited"
          : "reconciled";
    return {
      ...row,
      subledgerBalance,
      linkedGlBalance,
      locationControlBalance,
      linkedVariance,
      controlVariance,
      controlShared,
      controlGroupPropertyIds,
      controlGroupBalance,
      controlGroupVariance,
      controlNote: controlShared ? "shared control: reconciled together" : null,
      cashActivity: normalizeMoney(row.cashActivity ?? "0"),
      status,
      bankAccounts: banks.rows.filter((bank) => bank.propertyId === row.propertyId).map((bank) => ({ ...bank, cashActivity: normalizeMoney(bank.cashActivity ?? "0") })),
      leases: leases.rows.filter((lease) => lease.propertyId === row.propertyId).map((lease) => ({ ...lease, balance: normalizeMoney(lease.balance ?? "0") })),
    };
  });
  return {
    asOf: throughOn,
    rows,
    totals: {
      subledgerBalance: sum(rows.map((row) => row.subledgerBalance)),
      linkedGlBalance: sum(rows.map((row) => row.linkedGlBalance)),
      cashActivity: sum(rows.map((row) => row.cashActivity)),
      discrepancies: rows.filter((row) => row.status === "discrepancy").length,
      configurationRequired: rows.filter((row) => row.status === "configuration_required").length,
    },
  };
  });
}
export type ManagedPropertyRow = {
  id: string;
  code: string;
  name: string;
  propertyType: string;
  status: string;
  currency: string;
  address: Record<string, string> | null;
  custom: Record<string, unknown> | null;
  subsidiaryId: string;
  subsidiaryName: string;
  locationId: string | null;
  locationName: string | null;
  fixedAssetId: string | null;
  rentIncomeAccountId: string | null;
  camIncomeAccountId: string | null;
  depositLiabilityAccountId: string | null;
  defaultBankAccountId: string | null;
  unitCount: number;
  occupiedUnits: number;
};

export type PropertyUnitRow = {
  id: string;
  propertyId: string;
  code: string;
  name: string | null;
  unitType: string | null;
  rentableArea: string | null;
  bedrooms: number | null;
  status: string;
};

export type PropertyLeaseRow = {
  id: string;
  propertyId: string;
  unitId: string | null;
  tenantId: string;
  leaseNumber: string;
  status: string;
  startsOn: string;
  endsOn: string | null;
  billingDay: number;
  paymentTermsDays: number;
  securityDepositRequired: string;
  camMethod: string;
  camSharePercent: string | null;
  lateFeeType: string;
  lateFeeValue: string;
  graceDays: number;
  autoInvoice: boolean;
  autoPost: boolean;
  notes: string | null;
  baseRent: string | null;
  propertyName: string;
  unitCode: string | null;
  tenantName: string;
  currency: string;
  depositBalance: string;
};

export type LeaseChargeRow = {
  id: string;
  leaseId: string;
  chargeType: string;
  description: string;
  amount: string;
  frequency: string;
  effectiveFrom: string;
  effectiveTo: string | null;
};

export type LeaseEscalationRow = {
  id: string;
  leaseId: string;
  effectiveOn: string;
  method: string;
  value: string;
  previousAmount: string | null;
  newAmount: string | null;
  status: string;
};

export type LeaseScheduleRow = {
  id: string;
  leaseId: string;
  periodStartsOn: string;
  periodEndsOn: string;
  dueOn: string;
  amount: string;
  status: string;
  invoiceDocumentId: string | null;
  invoiceNumber: string | null;
  invoiceStatus: string | null;
  invoiceDueOn: string | null;
  invoiceOpenBalance: string | null;
  chargeType: string;
  description: string;
};

export type SecurityDepositRow = {
  id: string;
  leaseId: string;
  kind: string;
  occurredOn: string;
  amount: string;
  bankAccountId: string | null;
  offsetAccountId: string | null;
  appliedDocumentId: string | null;
  journalEntryId: string;
  reversalOfId: string | null;
  memo: string | null;
  reversed: boolean;
};

export type CamPoolRow = {
  id: string;
  propertyId: string;
  name: string;
  fiscalYear: number;
  periodStartsOn: string;
  periodEndsOn: string;
  allocationBasis: string;
  budgetAmount: string;
  actualAmount: string | null;
  expenseAccountIds: string[];
  status: string;
};

export type CamAllocationRow = {
  id: string;
  poolId: string;
  leaseId: string;
  sharePercent: string;
  budgetAllocation: string;
  actualAllocation: string | null;
  billedEstimate: string;
  reconciliationAmount: string | null;
  invoiceDocumentId: string | null;
};

export type ScheduleCountRow = {
  leaseId: string;
  total: number;
};

export type OverdueLeaseRow = {
  leaseId: string;
  balance: string;
};

export type OverdueInvoiceRow = {
  leaseId: string;
  documentId: string;
  documentNumber: string | null;
  dueOn: string | null;
  openBalance: string | null;
};
/** Schedule-list preview depth. Totals and money never come from the preview. */
export const SCHEDULE_PREVIEW_LIMIT = 2000;
export async function propertyManagementWorkspace(orgId: string, allowedSubsidiaryIds: ReadonlySet<string> | null, asOf?: string) {
  const overdueOn = validDate(asOf, "Overdue date") ?? await businessToday(orgId);
  // One repeatable-read snapshot for all twelve reads, every one scoped to
  // the caller: a property rehomed mid-read can neither leak another
  // entity's leases, charges and deposits into this workspace nor tear it
  // (stale A header with fresh B lines). Subordinates follow the in-scope
  // property ids read first in this same snapshot.
  return withScopeSnapshot(orgId, async () => {
  const properties = await db.execute<ManagedPropertyRow>(sql`select p.id,p.code,p.name,p.property_type as "propertyType",p.status,p.currency,p.address,p.custom,p.subsidiary_id as "subsidiaryId",s.name as "subsidiaryName",p.location_id as "locationId",l.name as "locationName",p.fixed_asset_id as "fixedAssetId",
      p.rent_income_account_id as "rentIncomeAccountId",p.cam_income_account_id as "camIncomeAccountId",p.deposit_liability_account_id as "depositLiabilityAccountId",p.default_bank_account_id as "defaultBankAccountId",
      count(u.id)::int as "unitCount",count(u.id) filter(where u.status='occupied')::int as "occupiedUnits" from managed_properties p join subsidiaries s on s.id=p.subsidiary_id and s.org_id=p.org_id
      left join locations l on l.id=p.location_id and l.org_id=p.org_id left join property_units u on u.property_id=p.id and u.org_id=p.org_id where p.org_id=${orgId}
      ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds)} group by p.id,s.name,l.name order by p.name`);
  const propertyIds = uuidArray(properties.rows.map((row) => String(row.id)));
  const leases = await db.execute<PropertyLeaseRow>(sql`select l.id,l.property_id as "propertyId",l.unit_id as "unitId",l.tenant_id as "tenantId",l.lease_number as "leaseNumber",l.status,l.starts_on as "startsOn",l.ends_on as "endsOn",
      l.billing_day as "billingDay",l.payment_terms_days as "paymentTermsDays",l.security_deposit_required as "securityDepositRequired",l.cam_method as "camMethod",l.cam_share_percent as "camSharePercent",
      l.late_fee_type as "lateFeeType",l.late_fee_value as "lateFeeValue",l.grace_days as "graceDays",l.auto_invoice as "autoInvoice",l.auto_post as "autoPost",l.notes,
      (select c.amount from lease_charges c where c.org_id=l.org_id and c.lease_id=l.id and c.charge_type='base_rent' order by c.effective_from desc limit 1) as "baseRent",
      p.name as "propertyName",u.code as "unitCode",t.display_name as "tenantName",p.currency,
      coalesce((select sum(case when d.kind in ('received','interest','adjustment_increase') then d.amount else -d.amount end) from security_deposit_transactions d where d.org_id=l.org_id and d.lease_id=l.id),0)::text as "depositBalance"
      from property_leases l join managed_properties p on p.id=l.property_id and p.org_id=l.org_id left join property_units u on u.id=l.unit_id and u.org_id=l.org_id
      join parties t on t.id=l.tenant_id and t.org_id=l.org_id where l.org_id=${orgId} and l.property_id = any(${propertyIds}::uuid[])
      order by case l.status when 'active' then 0 when 'notice' then 1 when 'draft' then 2 else 3 end,l.lease_number`);
  const leaseIds = uuidArray(leases.rows.map((row) => String(row.id)));
  const units = await db.execute<PropertyUnitRow>(sql`select id,property_id as "propertyId",code,name,unit_type as "unitType",rentable_area as "rentableArea",bedrooms,status from property_units where org_id=${orgId} and property_id = any(${propertyIds}::uuid[]) order by property_id,code`);
  const charges = await db.execute<LeaseChargeRow>(sql`select id,lease_id as "leaseId",charge_type as "chargeType",description,amount,frequency,effective_from as "effectiveFrom",effective_to as "effectiveTo" from lease_charges where org_id=${orgId} and lease_id = any(${leaseIds}::uuid[]) order by effective_from`);
  const escalations = await db.execute<LeaseEscalationRow>(sql`select id,lease_id as "leaseId",effective_on as "effectiveOn",method,value,previous_amount as "previousAmount",new_amount as "newAmount",status from lease_escalations where org_id=${orgId} and lease_id = any(${leaseIds}::uuid[]) order by effective_on,id`);
  const schedules = await db.execute<LeaseScheduleRow>(sql`select s.id,s.lease_id as "leaseId",s.period_starts_on as "periodStartsOn",s.period_ends_on as "periodEndsOn",s.due_on as "dueOn",s.amount,s.status,s.invoice_document_id as "invoiceDocumentId",d.document_number as "invoiceNumber",
      d.status as "invoiceStatus",d.due_date as "invoiceDueOn",d.open_balance as "invoiceOpenBalance",c.charge_type as "chargeType",c.description
      from lease_schedule_lines s join lease_charges c on c.id=s.charge_id and c.org_id=s.org_id
      left join documents d on d.id=s.invoice_document_id and d.org_id=s.org_id where s.org_id=${orgId} and s.lease_id = any(${leaseIds}::uuid[]) order by s.due_on desc limit ${SCHEDULE_PREVIEW_LIMIT}`);
    // Completeness evidence for the capped preview above: the full line
    // count overall and per lease, so lists render an explicit
    // "showing N of M" instead of silently dropping older lines.
  const scheduleTotal = await db.execute<{ total: number }>(sql`select count(*)::int as total from lease_schedule_lines where org_id=${orgId} and lease_id = any(${leaseIds}::uuid[])`);
  const scheduleCounts = await db.execute<ScheduleCountRow>(sql`select lease_id as "leaseId",count(*)::int as total from lease_schedule_lines where org_id=${orgId} and lease_id = any(${leaseIds}::uuid[]) group by lease_id`);
    // Past-due balances age the native posted document's remaining balance
    // once per document, over the COMPLETE set of schedule lines — never the
    // capped preview, which drops older lines first. One rent invoice covers
    // one lease (billing groups lines by lease), so the per-lease balance is
    // exact and the portfolio total de-duplicates by document.
  const overdue = await db.execute<OverdueInvoiceRow>(sql`select s.lease_id as "leaseId",d.id as "documentId",d.document_number as "documentNumber",
      d.due_date as "dueOn",d.open_balance as "openBalance"
      from lease_schedule_lines s join documents d on d.id=s.invoice_document_id and d.org_id=s.org_id
      where s.org_id=${orgId} and s.lease_id = any(${leaseIds}::uuid[]) and d.status='posted' and d.due_date<${overdueOn}
      group by s.lease_id,d.id,d.document_number,d.due_date,d.open_balance`);
  const deposits = await db.execute<SecurityDepositRow>(sql`select d.id,d.lease_id as "leaseId",d.kind,d.occurred_on as "occurredOn",d.amount,d.bank_account_id as "bankAccountId",d.offset_account_id as "offsetAccountId",d.applied_document_id as "appliedDocumentId",d.journal_entry_id as "journalEntryId",d.reversal_of_id as "reversalOfId",d.memo,
      exists(select 1 from security_deposit_transactions r where r.org_id=d.org_id and r.reversal_of_id=d.id) as reversed
      from security_deposit_transactions d where d.org_id=${orgId} and d.lease_id = any(${leaseIds}::uuid[]) order by d.occurred_on desc,d.created_at desc`);
  const pools = await db.execute<CamPoolRow>(sql`select id,property_id as "propertyId",name,fiscal_year as "fiscalYear",period_starts_on as "periodStartsOn",period_ends_on as "periodEndsOn",allocation_basis as "allocationBasis",budget_amount as "budgetAmount",actual_amount as "actualAmount",expense_account_ids as "expenseAccountIds",status from cam_pools where org_id=${orgId} and property_id = any(${propertyIds}::uuid[]) order by fiscal_year desc,name`);
  const allocations = await db.execute<CamAllocationRow>(sql`select id,pool_id as "poolId",lease_id as "leaseId",share_percent as "sharePercent",budget_allocation as "budgetAllocation",actual_allocation as "actualAllocation",billed_estimate as "billedEstimate",reconciliation_amount as "reconciliationAmount",invoice_document_id as "invoiceDocumentId" from cam_allocations where org_id=${orgId} and lease_id = any(${leaseIds}::uuid[]) order by created_at`);
  const overdueDocumentBalance = new Map<string, string>();
  const overdueByLeaseBalance = new Map<string, string>();
  for (const line of overdue.rows) {
    if (!overdueDocumentBalance.has(line.documentId)) {
      overdueDocumentBalance.set(line.documentId, normalizeMoney(line.openBalance ?? "0"));
    }
    const balance = overdueDocumentBalance.get(line.documentId)!;
    overdueByLeaseBalance.set(line.leaseId, add(overdueByLeaseBalance.get(line.leaseId) ?? "0.0000", balance));
  }
  const overdueTotal = sum([...overdueDocumentBalance.values()]);
  const overdueByLease: OverdueLeaseRow[] = [...overdueByLeaseBalance].map(([leaseId, balance]) => ({ leaseId, balance }));
  const totalSchedules = scheduleTotal.rows[0]?.total ?? 0;
  return {
    properties: properties.rows, units: units.rows, leases: leases.rows, charges: charges.rows, escalations: escalations.rows,
    schedules: schedules.rows, scheduleTotal: totalSchedules, schedulesTruncated: totalSchedules > schedules.rows.length,
    scheduleCountsByLease: scheduleCounts.rows,
    overdueAsOf: overdueOn, overdueTotal, overdueByLease,
    overdueInvoices: overdue.rows.map((line) => ({ ...line, openBalance: normalizeMoney(line.openBalance ?? "0") })),
    deposits: deposits.rows, camPools: pools.rows, camAllocations: allocations.rows,
  };
  });
}

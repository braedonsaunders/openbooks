import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { add, cmp, div, formatMoney, sum } from "./money.ts";
import {
  filingAccountRef,
  type FilingAccountRef,
  type PayrollFilingAccount,
} from "./payroll-filing.ts";
import {
  addBusinessDays,
  holidayDateSet,
  nextBusinessDay,
  resolveObservedHolidays,
} from "./payroll-holidays.ts";
import { PayrollError } from "./payroll-error.ts";
import {
  allRemittanceSchedules,
  PAYROLL_COUNTRY_PACKS,
  remittanceBandForAverage,
  remittanceFrequencyBand,
  remittanceScheduleInForce,
  statutoryRemittanceDeclaration,
  type PayrollRemittanceFrequencyBand,
  type PayrollRemittanceSchedule,
  type StatutoryRemittanceDeclaration,
} from "./payroll/packs.ts";
import {
  payrollSubsidiaryInScope,
  payrollSubsidiaryScopeFilter,
  type PayrollSubsidiaryScope,
} from "./payroll-run.ts";

type RemittanceExecutor = Pick<typeof db, "execute">;

/**
 * Payroll remittance execution — the PD7A-shaped bridge from accrued
 * withholding liabilities to money out the door.
 *
 * Committed pay runs credit each component's liability account; a remittance
 * run sums those amounts for a period, grouped by remittance destination
 * (the component's remittance party — union funds set theirs on their
 * auto-provisioned components; CA statutory components fall back to the org's
 * CRA remittance vendor) AND by the employees' payroll filing account, and
 * materializes ONE vendor bill per (destination, filing account) that DEBITS
 * the liability accounts. The bill then rides the normal AP review/post/pay
 * machinery — payroll never grows a second payment path.
 *
 * Grouping by filing account is what makes a multi-account employer correct: a
 * PD7A is filed per payroll program account (…RP0001, …RP0002), so amounts
 * withheld from RP0002's employees must never be remitted under RP0001. Orgs
 * with no filing accounts configured land in one unassigned group, which is
 * byte-for-byte the previous single-account behaviour.
 */

export interface RemittanceComponentLine {
  componentId: string;
  code: string;
  name: string;
  kind: "deduction" | "employer_contribution";
  systemKey: string | null;
  liabilityAccountId: string | null;
  accountLabel: string | null;
  amount: string;
}

export interface RemittanceGroup {
  partyId: string | null;
  partyName: string | null;
  /** The payroll program/EIN account this remittance is filed under. */
  filingAccount: FilingAccountRef;
  /**
   * True when any accrual in the group comes from a committed stub whose
   * filing account was never attributed (legacy `unknown` source). The money
   * is real and stays in the totals, but the group is unfiled: no remittance
   * bill may be raised from it until those stubs are reconciled, and the
   * group must render as unfiled/unknown rather than as an attributed filer.
   */
  hasUnknownFilingAccount: boolean;
  /**
   * The vendor settings keys that routed rows into this group (the pack or
   * regional declaration each row resolved through — never a jurisdiction).
   * Sorted, distinct, without nulls. Downstream schedule resolution keys off
   * this provenance, so a group whose rows arrived through a scheduled
   * destination's key is governed by that schedule whatever its party is.
   */
  vendorKeys: string[];
  /**
   * The destination's declared remittance schedule for the queried period —
   * authority, frequency, and the due date the bill will carry — or null when
   * no pack declares the destination (the legacy CRA-function path). A
   * scheduled destination NEVER inherits the filing account's CRA remitter
   * type: that registration is with another agency.
   */
  schedule: RemittanceGroupSchedule | null;
  /**
   * Sorted distinct stub provinces behind this group. The CRA's holiday
   * calendar is province-sensitive (Saint-Jean-Baptiste Day in Quebec, the
   * Civic Holiday everywhere but Quebec), so the bill's due date is computed
   * from these — see `remittanceGroupUsesQuebecCalendar`.
   */
  provinces: string[];
  components: RemittanceComponentLine[];
  total: string;
  /** PD7A worksheet context: gross pay and employee count in the period,
   *  counted within this filing account (the PD7A is filed per account). */
  grossPayroll: string;
  employeeCount: number;
  /** Remittance bills already raised for this destination and period. */
  existingBills: { documentId: string; documentNumber: string; status: string; total: string }[];
}

/**
 * The destination schedule governing one remittance group: which declared
 * schedule, at which frequency, producing which bill due date. Every field is
 * data the pack declared or configuration the org set — the generic layer
 * names no jurisdiction to build it.
 */
export interface RemittanceGroupSchedule {
  /** The vendor settings key whose schedule governs (e.g. `rqRemittancePartyId`). */
  vendorSettingsKey: string;
  /** The receiving authority (e.g. `Revenu Québec`). */
  authority: string;
  /** The frequency the bill is dated under. */
  frequency: string;
  /** Whether the frequency is the org's configured value or the schedule default. */
  frequencySource: "configured" | "default";
  /** The bill due date for the group's period, from the destination's schedule. */
  dueDate: string;
  /** The statutory rule applied, carried onto the bill like the CRA rules. */
  rule: string;
}

/** The raw orgs.settings.payroll blob — indexed by whatever settings keys the
 *  pack declarations name, so this module needs no typed knowledge of them. */
async function rawPayrollSettings(
  orgId: string,
  executor: RemittanceExecutor = db,
): Promise<Record<string, unknown>> {
  const r = (await executor.execute<{ p: Record<string, unknown> | null }>(
    sql`select settings->'payroll' as p from orgs where id = ${orgId}`,
  ));
  return r.rows[0]?.p ?? {};
}

/** Load filing-account labels through the caller's transaction when one is
 * active. A remittance bill must resolve its group and labels from the same
 * snapshot that supplies the accrued rows, not from a second pooled session. */
async function filingAccountsByIdIn(
  orgId: string,
  executor: RemittanceExecutor,
): Promise<Map<string, PayrollFilingAccount>> {
  const rows = await executor.execute<Record<string, unknown>>(sql`
    select id, country, program_type, account_number, name, remitter_type,
           subsidiary_id, state_code, is_default, is_active
      from payroll_filing_accounts
     where org_id = ${orgId}
     order by is_default desc, account_number
  `);
  return new Map(rows.rows.map((row) => [String(row.id), {
    id: String(row.id),
    country: String(row.country),
    programType: String(row.program_type),
    accountNumber: String(row.account_number),
    name: String(row.name),
    remitterType: row.remitter_type as PayrollFilingAccount["remitterType"],
    subsidiaryId: (row.subsidiary_id as string | null) ?? null,
    stateCode: (row.state_code as string | null) ?? null,
    isDefault: row.is_default === true,
    isActive: row.is_active === true,
  }]));
}

/**
 * Accrued-but-unremitted withholding by destination for pay dates in
 * [from, to] (committed and posted runs).
 *
 * Which system keys are internal accruals — liabilities that settle through a
 * payout to the employee, never through a remittance to anyone — is a PACK
 * declaration (`remittance: 'internal_accrual'` in engine/src/payroll/packs.ts),
 * not a spelled key. The CA pack declares `vacation_accrual`; a pack whose
 * statute banks a different accrual declares its own, and this module never
 * learns the words.
 */
export async function payrollRemittanceSummary(
  orgId: string,
  range: { from: string; to: string },
  allowedSubsidiaryIds?: PayrollSubsidiaryScope,
  executor: RemittanceExecutor = db,
): Promise<RemittanceGroup[]> {
  const rawSettings = await rawPayrollSettings(orgId, executor);
  // No org-wide unknown-filing-account refusal here: one legacy run must not
  // poison the summary for the rest. Stubs whose filing account was never
  // attributed carry a null account into the unassigned group and flag it
  // (hasUnknownFilingAccount); only bill creation for a flagged group fails
  // closed, until those stubs are reconciled.
  const filingAccount = sql`s.filing_account_id`;
  // One pack's declaration per component country, resolved country-first: two
  // packs may give the same withholding the same system key, so the country
  // stamped on the component row picks the pack. A row naming no country (or
  // none with a pack) carries no pack declaration — every lookup misses, as
  // for a system key no pack declares.
  const declarations = new Map<string, StatutoryRemittanceDeclaration | null>();
  const declarationFor = (country: string | null): StatutoryRemittanceDeclaration | null => {
    if (!country) return null;
    const hit = declarations.get(country);
    if (hit !== undefined) return hit;
    const found = PAYROLL_COUNTRY_PACKS[country] ? statutoryRemittanceDeclaration(country) : null;
    declarations.set(country, found);
    return found;
  };
  // Grouped by the STUB's snapshot province as well as by component: a
  // component whose pack declares a region-scoped remittance vendor (QPP and
  // QPIP go to Revenu Québec for QC employment, to the CRA nowhere) splits by
  // destination, and rows that resolve to the same vendor are re-merged per
  // component in groupRemittanceRows.
  const queried = (await executor.execute<{
      component_id: string; code: string; name: string; kind: "deduction" | "employer_contribution";
      system_key: string | null; country: string | null; remittance_party_id: string | null;
      liability_account_id: string | null; filing_account_id: string | null;
      filingUnknown: boolean; province: string; amount: string;
    }>(sql`
    select c.id as component_id, c.code, c.name, c.kind, c.system_key, c.country, c.remittance_party_id,
           -- Historical accrual evidence only. Current component or statutory
           -- account setup cannot establish where an older liability accrued.
           l.liability_account_id,
           ${filingAccount} as filing_account_id,
           bool_or(s.filing_account_source = 'unknown') as "filingUnknown",
           s.province,
           sum(l.amount) as amount
      from pay_stub_lines l
      join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id and r.run_status = 'committed'
      join pay_components c on c.id = l.component_id and c.org_id = l.org_id
      join documents source_document on source_document.id=r.document_id and source_document.org_id=r.org_id
     where l.org_id = ${orgId} and s.pay_date between ${range.from} and ${range.to}
       and l.kind in ('deduction', 'employer_contribution')
       ${payrollSubsidiaryScopeFilter(sql`source_document.subsidiary_id`, allowedSubsidiaryIds)}
     group by c.id, c.code, c.name, c.kind, c.system_key, c.country, c.remittance_party_id,
              l.liability_account_id, ${filingAccount}, s.province
     order by c.sequence, c.code
  `));
  // Internal accruals never remit, and each pack declares its own — so the
  // exclusion is per component country, not per system key. Rows with no
  // system key (user components) always stay in the summary.
  const rows = queried.rows.filter((row) =>
    row.system_key == null
    || !declarationFor(row.country)?.internalAccrualSystemKeys.includes(row.system_key),
  );
  if (rows.length === 0) return [];
  if (rows.some(row => !row.liability_account_id && cmp(row.amount, "0") !== 0)) {
    throw new PayrollError("Committed payroll has an unknown historical liability account. Reconcile its original payroll posting evidence before generating remittance reports or bills.");
  }

  const context = (await executor.execute<{ filing_account_id: string | null; gross: string; employees: number }>(sql`
    select ${filingAccount} as filing_account_id,
           coalesce(sum(s.gross), 0) as gross,
           count(distinct s.employee_party_id)::int as employees
      from pay_stubs s
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id and r.run_status = 'committed'
      join documents source_document on source_document.id=r.document_id and source_document.org_id=r.org_id
     where s.org_id = ${orgId} and s.pay_date between ${range.from} and ${range.to}
       ${payrollSubsidiaryScopeFilter(sql`source_document.subsidiary_id`, allowedSubsidiaryIds)}
     group by ${filingAccount}
  `));
  const contextByAccount = new Map(
    context.rows.map((row) => [row.filing_account_id ?? "", row]),
  );
  const filingAccounts = await filingAccountsByIdIn(orgId, executor);

  // Destination and account both resolve through the pack declarations. A
  // component with a REGION-scoped vendor declaration for the stub's province
  // (QPP/QPIP → the Revenu Québec vendor for QC stubs) resolves there FIRST —
  // it outranks even the component's own remittance_party_id, because that
  // column is one value on a component whose amounts split by destination.
  // Otherwise a `tax_authority` component falls back to the vendor named by
  // ITS pack's remittanceVendorSettingsKey (the CRA remittance vendor for the
  // CA pack; a pack that declares none surfaces unassigned for setup, which
  // is where the US statutory components have always landed). An `external`
  // component (WCB, SUTA) only ever uses its own remittance_party_id.
  const settingsVendor = (settingsKey: string): string | null => {
    const vendor = rawSettings[settingsKey];
    return typeof vendor === "string" && vendor ? vendor : null;
  };
  const resolveDestination = (row: (typeof rows)[number]): { partyId: string | null; vendorKey: string | null } => {
    const packDeclaration = row.system_key ? declarationFor(row.country) : null;
    const regionalKey = row.system_key
      ? packDeclaration?.regionalVendorSettingsKeyBySystemKey.get(row.system_key)?.[row.province]
      : undefined;
    // The regional key is provenance even when the org has not configured the
    // vendor yet: an unconfigured RQ destination is still an RQ destination —
    // it surfaces unassigned under the RQ schedule, never under the CRA one.
    if (regionalKey) return { partyId: settingsVendor(regionalKey), vendorKey: regionalKey };
    if (row.remittance_party_id) return { partyId: row.remittance_party_id, vendorKey: null };
    const vendorKey = row.system_key
      ? packDeclaration?.vendorSettingsKeyBySystemKey.get(row.system_key)
      : undefined;
    if (!vendorKey) return { partyId: null, vendorKey: null };
    return { partyId: settingsVendor(vendorKey), vendorKey };
  };
  const resolveParty = (row: (typeof rows)[number]): string | null => resolveDestination(row).partyId;
  const resolveVendorKey = (row: (typeof rows)[number]): string | null => resolveDestination(row).vendorKey;
  const resolveAccount = (row: (typeof rows)[number]): string | null =>
    row.liability_account_id;

  const groups = groupRemittanceRows({
    rows, contextByAccount, filingAccounts, resolveParty, resolveAccount, resolveVendorKey,
  });

  // One group, one destination, one schedule. Provenance first: rows that
  // arrived through a scheduled destination's vendor key are governed by that
  // schedule. Otherwise a group whose PARTY is a scheduled destination's
  // configured vendor (an `external` component pointed at the RQ vendor)
  // resolves through the party. Anything else keeps the legacy CRA path.
  const schedules = allRemittanceSchedules();
  for (const group of groups.values()) {
    group.schedule = scheduleForRemittanceGroup({
      vendorKeys: group.vendorKeys,
      partyId: group.partyId,
      periodTo: range.to,
      payrollSettings: rawSettings,
      schedules,
    });
  }

  // Names + account labels + prior bills for the same destination and any
  // overlapping period. Loading the complete marker window lets callers show
  // that an accrual is already covered even when their requested range is
  // wider or narrower than the bill that consumed it.
  const partyIds = [...new Set([...groups.values()].map((g) => g.partyId).filter(Boolean))] as string[];
  const accountIds = [...new Set(
    [...groups.values()].flatMap((g) => g.components.map((c) => c.liabilityAccountId)).filter(Boolean),
  )] as string[];
  // Run these reads sequentially when `executor` is a transaction. Drizzle's
  // transaction client is one PostgreSQL connection; Promise.all would queue
  // concurrent queries on that connection and can produce an overlapping
  // client.query warning while providing no snapshot benefit.
  const parties = partyIds.length
    ? await executor.execute<{ id: string; display_name: string }>(sql`select id, display_name from parties
                      where org_id = ${orgId} and id = any(${`{${partyIds.join(",")}}`}::uuid[])`)
    : { rows: [] };
  const accounts = accountIds.length
    ? await executor.execute<{ id: string; number: string | null; name: string }>(sql`select id, number, name from accounts
                      where org_id = ${orgId} and id = any(${`{${accountIds.join(",")}}`}::uuid[])`)
    : { rows: [] };
  const bills = await executor.execute<{
      id: string; document_number: string; status: string; total: string;
      party_id: string | null; filing_account_id: string | null;
      from: string | null; to: string | null;
    }>(sql`
    select id, document_number, status, total, party_id,
           custom->'payrollRemittance'->>'filingAccountId' as filing_account_id,
           custom->'payrollRemittance'->>'from' as from,
           custom->'payrollRemittance'->>'to' as to
      from documents
     where org_id = ${orgId} and kind = 'vendor_bill'
       and custom->'payrollRemittance'->>'from' <= ${range.to}
       and custom->'payrollRemittance'->>'to' >= ${range.from}
       and status <> 'voided'
       ${payrollSubsidiaryScopeFilter(sql`subsidiary_id`, allowedSubsidiaryIds)}`);
  const partyName = new Map(parties.rows.map((p) => [p.id, p.display_name]));
  const accountLabel = new Map(accounts.rows.map((a) => [a.id, a.number ? `${a.number} · ${a.name}` : a.name]));
  for (const group of groups.values()) {
    group.partyName = group.partyId ? (partyName.get(group.partyId) ?? null) : null;
    for (const component of group.components) {
      component.accountLabel = component.liabilityAccountId
        ? (accountLabel.get(component.liabilityAccountId) ?? null) : null;
    }
    group.existingBills = bills.rows
      .filter((b) =>
        b.from != null && b.to != null
        && b.from <= range.to && b.to >= range.from
        &&
        groupKey(b.party_id ?? null, b.filing_account_id) ===
          groupKey(group.partyId, group.filingAccount.id))
      .map((b) => ({ documentId: b.id, documentNumber: b.document_number, status: b.status, total: b.total }));
  }
  return [...groups.values()].sort((a, b) =>
    (a.partyName ?? "￿").localeCompare(b.partyName ?? "￿")
    || (a.filingAccount.accountNumber ?? "").localeCompare(b.filingAccount.accountNumber ?? ""));
}

/**
 * Reconcile a remittance bill against the committed payroll it snapshots.
 *
 * A bill is deliberately created as a normal AP draft, so payroll can be
 * voided or another run can commit while that draft waits for review. Posting
 * is the irreversible boundary: lock every pay run in the marked period,
 * re-read the bill marker, then compare its stored total with the current
 * destination group. The source locks serialize this check with both commit
 * and controlled payroll voids; a stale draft therefore fails closed instead
 * of becoming an over-remittance through the generic AP poster.
 */
export async function assertPayrollRemittanceBillCurrent(
  orgId: string,
  documentId: string,
  executor: RemittanceExecutor = db,
): Promise<void> {
  const marker = (await executor.execute<{
    party_id: string | null;
    total: string;
    from: string | null;
    to: string | null;
    filing_account_id: string | null;
  }>(sql`
    select party_id::text as party_id, total::text as total,
           custom->'payrollRemittance'->>'from' as from,
           custom->'payrollRemittance'->>'to' as to,
           custom->'payrollRemittance'->>'filingAccountId' as filing_account_id
      from documents
     where org_id = ${orgId} and id = ${documentId}
       and kind = 'vendor_bill' and custom ? 'payrollRemittance'
  `)).rows[0];
  if (!marker) return;
  if (
    !marker.party_id
    || !marker.from
    || !marker.to
    || !/^\d{4}-\d{2}-\d{2}$/.test(marker.from)
    || !/^\d{4}-\d{2}-\d{2}$/.test(marker.to)
    || marker.from > marker.to
    || (marker.filing_account_id !== null && !/^[0-9a-f-]{36}$/i.test(marker.filing_account_id))
  ) {
    throw new PayrollError("payroll remittance bill has an invalid source marker");
  }

  // Lock source runs and their documents BEFORE locking the bill below. The
  // controlled void path already owns a source document before it inspects
  // posted remittance bills, so this order makes the two boundaries queue
  // rather than deadlock.
  await executor.execute(sql`
    select r.document_id
      from pay_runs r
      join documents d on d.id = r.document_id and d.org_id = r.org_id
     where r.org_id = ${orgId}
       and r.pay_date between ${marker.from} and ${marker.to}
     order by r.document_id
     for update of r, d
  `);

  const locked = (await executor.execute<{
    party_id: string | null;
    total: string;
    from: string | null;
    to: string | null;
    filing_account_id: string | null;
  }>(sql`
    select party_id::text as party_id, total::text as total,
           custom->'payrollRemittance'->>'from' as from,
           custom->'payrollRemittance'->>'to' as to,
           custom->'payrollRemittance'->>'filingAccountId' as filing_account_id
      from documents
     where org_id = ${orgId} and id = ${documentId}
       and kind = 'vendor_bill' and custom ? 'payrollRemittance'
     for update
  `)).rows[0];
  if (!locked || !locked.party_id || !locked.from || !locked.to) {
    throw new PayrollError("payroll remittance bill has an invalid source marker");
  }

  const groups = await payrollRemittanceSummary(
    orgId,
    { from: locked.from, to: locked.to },
    undefined,
    executor,
  );
  const group = groups.find((candidate) =>
    candidate.partyId === locked.party_id
    && candidate.filingAccount.id === (locked.filing_account_id ?? null));
  if (!group) {
    throw new PayrollError(
      "payroll remittance source is no longer committed; regenerate this bill",
    );
  }
  if (cmp(group.total, locked.total) !== 0) {
    throw new PayrollError(
      "payroll remittance bill no longer matches committed payroll; regenerate this bill",
    );
  }
}

/** One remittance group = one destination vendor under one filing account. */
function groupKey(partyId: string | null, filingAccountId: string | null): string {
  return `${partyId ?? ""}::${filingAccountId ?? ""}`;
}

/** A withholding total for one component under one filing account, per stub
 *  province — the province is what a region-scoped remittance declaration
 *  (QPP/QPIP → Revenu Québec) resolves the destination from. */
export type RemittanceRow = {
  component_id: string;
  code: string;
  name: string;
  kind: "deduction" | "employer_contribution";
  system_key: string | null;
  /** The component row's pack country — picks the pack whose declaration governs the row. */
  country: string | null;
  remittance_party_id: string | null;
  liability_account_id: string | null;
  filing_account_id: string | null;
  /** True when any stub behind the row never had its filing account attributed. */
  filingUnknown: boolean;
  province: string;
  amount: string;
};

/**
 * Whether a remittance group's deadline follows the CRA's Québec holiday
 * calendar (CA-CRA-QC) rather than the federal one (CA-CRA).
 *
 * True exactly when every stub province behind the group is Québec: a
 * Québec-only payroll remits on Québec's schedule, where Saint-Jean-Baptiste
 * Day is a holiday and the Civic Holiday is not. Anything else — another
 * province, a mix, or no evidence at all — keeps the federal calendar the
 * bill always used. A mixed payroll's governing province is the employer's
 * province of record, which the product does not model, so mixing never
 * flips the calendar by itself.
 */
export function remittanceGroupUsesQuebecCalendar(provinces: readonly string[]): boolean {
  return provinces.length > 0 && provinces.every((province) => province === "QC");
}

/**
 * Fold component totals into one group per (destination vendor, filing
 * account). Pure, so the grouping rule that keeps one program account's
 * withholding out of another's PD7A is verifiable without a database.
 */
export function groupRemittanceRows(input: {
  rows: RemittanceRow[];
  contextByAccount: Map<string, { gross: string; employees: number }>;
  filingAccounts: Map<string, PayrollFilingAccount>;
  resolveParty: (row: RemittanceRow) => string | null;
  resolveAccount: (row: RemittanceRow) => string | null;
  /**
   * The vendor settings key the row resolved through, or null for
   * per-component destinations. Optional so existing callers keep their
   * shape; absent means no provenance, and no group carries a schedule key.
   */
  resolveVendorKey?: (row: RemittanceRow) => string | null;
}): Map<string, RemittanceGroup> {
  const groups = new Map<string, RemittanceGroup>();
  const provincesByGroup = new Map<string, Set<string>>();
  const vendorKeysByGroup = new Map<string, Set<string>>();
  for (const row of input.rows) {
    if (cmp(row.amount, "0") === 0) continue;
    const partyId = input.resolveParty(row);
    const key = groupKey(partyId, row.filing_account_id);
    const runContext = input.contextByAccount.get(row.filing_account_id ?? "");
    const group = groups.get(key) ?? {
      partyId, partyName: null,
      filingAccount: filingAccountRef(row.filing_account_id, input.filingAccounts),
      hasUnknownFilingAccount: false,
      vendorKeys: [],
      schedule: null,
      provinces: [],
      components: [], total: "0",
      grossPayroll: runContext?.gross ?? "0",
      employeeCount: runContext?.employees ?? 0,
      existingBills: [],
    };
    group.hasUnknownFilingAccount = group.hasUnknownFilingAccount || row.filingUnknown;
    // Rows arrive per (component, province); provinces that resolve to the
    // SAME destination fold back into one component line, so a bill never
    // carries two lines for one component.
    const existing = group.components.find(
      (component) => component.componentId === row.component_id && component.kind === row.kind,
    );
    if (existing) {
      existing.amount = add(existing.amount, row.amount);
    } else {
      group.components.push({
        componentId: row.component_id, code: row.code, name: row.name, kind: row.kind,
        systemKey: row.system_key, liabilityAccountId: input.resolveAccount(row),
        accountLabel: null, amount: row.amount,
      });
    }
    group.total = add(group.total, row.amount);
    groups.set(key, group);
    const provinces = provincesByGroup.get(key) ?? new Set<string>();
    provinces.add(row.province);
    provincesByGroup.set(key, provinces);
    const vendorKey = input.resolveVendorKey?.(row);
    if (vendorKey) {
      const vendorKeys = vendorKeysByGroup.get(key) ?? new Set<string>();
      vendorKeys.add(vendorKey);
      vendorKeysByGroup.set(key, vendorKeys);
    }
  }
  for (const [key, group] of groups) {
    group.provinces = [...(provincesByGroup.get(key) ?? [])].sort();
    group.vendorKeys = [...(vendorKeysByGroup.get(key) ?? [])].sort();
  }
  return groups;
}

/** Bill memo naming the period and, for multi-account employers, the account. */
function remittanceMemo(group: RemittanceGroup, from: string, to: string): string {
  const account = group.filingAccount.accountNumber
    ? ` · ${group.filingAccount.accountNumber}`
    : "";
  return `Payroll remittance ${from} – ${to}${account}`;
}

/**
 * The CRA public-holiday calendar a remittance deadline moves against.
 *
 * NOT the employer's calendar, and deliberately not tenant-overridable. The
 * CRA recognizes Easter Monday and the Civic Holiday, which no province's
 * employment standards act lists, and it excludes the Civic Holiday in Quebec
 * while recognizing Saint-Jean-Baptiste Day there. Letting an employer's own
 * closures push a federal deadline would be letting configuration create a
 * penalty; the pack's declaration is the whole input.
 *
 * Source: https://www.canada.ca/en/revenue-agency/services/tax/public-holidays.html
 */
function craCalendar(around: string, quebec: boolean): ReadonlySet<string> {
  return scheduleCalendar(around, quebec ? "CA-CRA-QC" : "CA-CRA");
}

/**
 * The working-day calendar a declared destination schedule moves deadlines
 * against. The jurisdiction is the schedule's own declaration — a
 * `tax_administration` calendar, never an employment one — so the generic
 * layer executes any pack's schedule without naming it.
 */
function scheduleCalendar(around: string, jurisdiction: string): ReadonlySet<string> {
  const year = Number(around.slice(0, 4));
  return holidayDateSet(resolveObservedHolidays({
    jurisdiction,
    from: `${year - 1}-01-01`,
    to: `${year + 1}-12-31`,
  }));
}

/** The last day of the month `date` falls in. */
function monthEnd(date: string): string {
  const [y, m] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10);
}

/** The `day`th of the month `offsetMonths` after the one `date` falls in. */
function dayOfMonth(date: string, offsetMonths: number, day: number): string {
  const [y, m] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1 + offsetMonths, day)).toISOString().slice(0, 10);
}

export interface RemittanceDue {
  dueDate: string;
  /** The statutory rule applied, carried onto the bill so an operator can
   *  see WHY the date is what it is rather than trusting it. */
  rule: string;
}

/**
 * The CRA due date for a remittance period, for every remitter type.
 *
 * A remitter's deadline is a function of
 * `payroll_filing_accounts.remitter_type` and of where the period ends inside
 * the month. Each rule below is transcribed from the CRA's published
 * "When to remit (pay)" table, verified against canada.ca:
 *
 *   https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/
 *     payroll/remitting-source-deductions/how-when-remit-due-dates.html
 *
 * - QUARTERLY — "January 1 to March 31 … April 15; April 1 to June 30 …
 *   July 15; July 1 to September 30 … October 15; October 1 to December 31 …
 *   January 15": the 15th of the month following the end of the quarter the
 *   period falls in.
 * - REGULAR — remitting period is the calendar month; due "the 15th day of the
 *   next month".
 * - ACCELERATED THRESHOLD 1 — "1st to 15th of the month … 25th day of same
 *   month; 16th to end of the month … 10th day of the next month."
 * - ACCELERATED THRESHOLD 2 — four quarter-month periods, "1st to 7th … 3rd
 *   working day after the 7th; 8th to 14th … 3rd working day after the 14th;
 *   15th to 21st … 3rd working day after the 21st; 22nd to the last day … 3rd
 *   working day after the last day of the month."
 *
 * And the shift, from the same page: "If your due date falls on a Saturday, a
 * Sunday, or a public holiday recognized by the CRA, your remittance is on
 * time if the CRA receives it on the next business day." That applies to the
 * three fixed-date schedules. Threshold 2 needs no shift — counting three
 * WORKING days necessarily lands on a working day, which is exactly why this
 * function could not exist before there was a working-day calendar.
 *
 * The penalty for getting this wrong is 3% to 10% of the remittance (20% for a
 * repeat in the same calendar year), which is why every rule above is quoted
 * rather than remembered, and why the calendar is the CRA's own list rather
 * than an employer's.
 */
export function remittanceDueDateExplained(
  periodTo: string,
  remitterType: PayrollFilingAccount["remitterType"] | null,
  options: { quebec?: boolean } = {},
): RemittanceDue {
  const date = periodTo.slice(0, 10);
  const holidays = craCalendar(date, options.quebec === true);
  const day = Number(date.slice(8, 10));
  // No filing account configured = the CRA's default registration for a new
  // employer, which is a regular remitter. Previous single-account behaviour,
  // preserved exactly.
  const remitter = remitterType ?? "regular";

  switch (remitter) {
    case "regular":
      return {
        dueDate: nextBusinessDay(dayOfMonth(date, 1, 15), holidays),
        rule: "regular remitter — the 15th of the month following the month of the pay date",
      };
    case "quarterly": {
      // The quarter the period ends in; its following month's 15th.
      const month = Number(date.slice(5, 7));
      const monthsToQuarterEnd = 2 - ((month - 1) % 3);
      return {
        dueDate: nextBusinessDay(dayOfMonth(date, monthsToQuarterEnd + 1, 15), holidays),
        rule: "quarterly remitter — the 15th of the month following the end of the quarter",
      };
    }
    case "accelerated_1":
      return day <= 15
        ? {
            dueDate: nextBusinessDay(dayOfMonth(date, 0, 25), holidays),
            rule: "accelerated threshold 1 — remuneration paid the 1st to the 15th, "
              + "due the 25th of the same month",
          }
        : {
            dueDate: nextBusinessDay(dayOfMonth(date, 1, 10), holidays),
            rule: "accelerated threshold 1 — remuneration paid the 16th to month end, "
              + "due the 10th of the following month",
          };
    case "accelerated_2": {
      // Three WORKING days after the end of the quarter-month period the
      // remittance period closes in. addBusinessDays never counts the day it
      // starts from, so a period ending on the 7th counts the 8th onward.
      const [periodEnd, label] = day <= 7 ? [dayOfMonth(date, 0, 7), "the 1st to the 7th"]
        : day <= 14 ? [dayOfMonth(date, 0, 14), "the 8th to the 14th"]
        : day <= 21 ? [dayOfMonth(date, 0, 21), "the 15th to the 21st"]
        : [monthEnd(date), "the 22nd to the last day of the month"];
      return {
        dueDate: addBusinessDays(periodEnd!, 3, holidays),
        rule: `accelerated threshold 2 — remuneration paid ${label}, due the 3rd working day `
          + "after the end of that period",
      };
    }
  }
}

/**
 * The due date alone. Never null any more: the working-day calendar this used
 * to be missing is `engine/src/payroll-holidays.ts`, and all four CRA
 * schedules are now computed rather than refused.
 */
export function remittanceDueDate(
  periodTo: string,
  remitterType: PayrollFilingAccount["remitterType"] | null,
  options: { quebec?: boolean } = {},
): string {
  return remittanceDueDateExplained(periodTo, remitterType, options).dueDate;
}

/**
 * Which frequency of a declared destination schedule governs: the org's
 * configured value under the schedule's frequency settings key, or the
 * schedule's own default when unconfigured or naming nothing declared.
 * Falling back rather than throwing is deliberate — an unconfigured schedule
 * still dates the bill, and readiness (not the bill path) nags the org to
 * confirm the frequency against the agency's notice.
 */
export function scheduledRemittanceFrequency(
  schedule: PayrollRemittanceSchedule,
  payrollSettings: Record<string, unknown>,
): { frequency: string; source: "configured" | "default" } {
  const configured = payrollSettings[schedule.frequencySettingsKey];
  if (typeof configured === "string" && remittanceFrequencyBand(schedule, configured)) {
    return { frequency: configured, source: "configured" };
  }
  return { frequency: schedule.defaultFrequency, source: "default" };
}

/**
 * The due date for a remittance period under a pack-declared destination
 * schedule (Revenu Québec's, today) — the counterpart to
 * `remittanceDueDateExplained`, which remains the legacy path for
 * destinations no pack declares. The rule shapes are the schedule's data;
 * this function only executes them against the schedule's own calendar, so a
 * second agency's timetable is a second declaration, never a branch.
 *
 * An unknown frequency falls back to the schedule default rather than
 * throwing: the caller already reports whether the frequency was configured,
 * and a bill must date itself even when configuration drifted.
 */
export function scheduledRemittanceDueDateExplained(
  schedule: PayrollRemittanceSchedule,
  frequency: string,
  periodTo: string,
): RemittanceDue {
  // The default is validated into the declaration (see allRemittanceSchedules),
  // so this fallback cannot itself miss.
  const band: PayrollRemittanceFrequencyBand =
    remittanceFrequencyBand(schedule, frequency)
    ?? remittanceFrequencyBand(schedule, schedule.defaultFrequency)!;
  const date = periodTo.slice(0, 10);
  const holidays = scheduleCalendar(date, schedule.calendar);
  const day = Number(date.slice(8, 10));
  switch (band.due.kind) {
    case "month_day":
      return {
        dueDate: nextBusinessDay(
          dayOfMonth(date, band.due.monthsAfterPeriodMonth, band.due.day), holidays,
        ),
        rule: band.rule,
      };
    case "quarter_day": {
      const month = Number(date.slice(5, 7));
      const monthsToQuarterEnd = 2 - ((month - 1) % 3);
      return {
        dueDate: nextBusinessDay(
          dayOfMonth(date, monthsToQuarterEnd + band.due.monthsAfterQuarterEnd, band.due.day),
          holidays,
        ),
        rule: band.rule,
      };
    }
    case "split_month":
      return day <= band.due.cutoffDay
        ? {
            dueDate: nextBusinessDay(
              dayOfMonth(date, band.due.firstDueMonthOffset, band.due.firstDueDay), holidays,
            ),
            rule: band.rule,
          }
        : {
            dueDate: nextBusinessDay(
              dayOfMonth(date, band.due.secondDueMonthOffset, band.due.secondDueDay), holidays,
            ),
            rule: band.ruleSecondHalf ?? band.rule,
          };
    case "quarter_month_working_days": {
      // The quarter-month the period falls in ends on the 7th, 14th, 21st or
      // month end; the deadline counts workingDays WORKING days from there on
      // the schedule's own calendar. Counting working days lands on a working
      // day by construction, so no weekend/holiday shift applies.
      const periodEnd = day <= 7 ? dayOfMonth(date, 0, 7)
        : day <= 14 ? dayOfMonth(date, 0, 14)
        : day <= 21 ? dayOfMonth(date, 0, 21)
        : monthEnd(date);
      return {
        dueDate: addBusinessDays(periodEnd, band.due.workingDays, holidays),
        rule: band.rule,
      };
    }
  }
}

/**
 * The schedule governing one remittance group for one period end — the
 * destination-keyed counterpart to the CRA-function path. Resolution order:
 *
 * 1. Provenance: a row that arrived through a scheduled destination's vendor
 *    key is governed by that schedule, even when the org left the vendor
 *    unconfigured (an unassigned RQ destination is still an RQ destination).
 *    A declared schedule always beats the legacy path, so a misconfigured org
 *    pointing two keys at one party still gets the declared date.
 * 2. Party: an `external` component pointed at a scheduled destination's
 *    configured vendor (Québec income tax remitted to the RQ vendor).
 *
 * Null when no pack declares the destination — the caller keeps the legacy
 * CRA-function behaviour. Pure over an explicit schedule list, so the
 * precedence is verifiable without a database.
 */
export function scheduleForRemittanceGroup(input: {
  vendorKeys: readonly string[];
  partyId: string | null;
  periodTo: string;
  payrollSettings: Record<string, unknown>;
  schedules?: readonly PayrollRemittanceSchedule[];
}): RemittanceGroupSchedule | null {
  const schedules = input.schedules ?? allRemittanceSchedules();
  const dated = input.vendorKeys
    .map((vendorSettingsKey) => ({
      vendorSettingsKey,
      schedule: remittanceScheduleInForce(vendorSettingsKey, input.periodTo, schedules),
    }))
    .find((candidate) => candidate.schedule);
  const byParty = (): { vendorSettingsKey: string; schedule: PayrollRemittanceSchedule } | null => {
    if (!input.partyId) return null;
    for (const schedule of schedules) {
      const configured = input.payrollSettings[schedule.vendorSettingsKey];
      if (typeof configured !== "string" || !configured || configured !== input.partyId) continue;
      const inForce = remittanceScheduleInForce(schedule.vendorSettingsKey, input.periodTo, schedules);
      if (inForce) return { vendorSettingsKey: schedule.vendorSettingsKey, schedule: inForce };
    }
    return null;
  };
  const resolved = dated ?? byParty();
  if (!resolved || !resolved.schedule) return null;
  const { frequency, source } = scheduledRemittanceFrequency(resolved.schedule, input.payrollSettings);
  const due = scheduledRemittanceDueDateExplained(resolved.schedule, frequency, input.periodTo);
  return {
    vendorSettingsKey: resolved.vendorSettingsKey,
    authority: resolved.schedule.authority,
    frequency,
    frequencySource: source,
    dueDate: due.dueDate,
    rule: due.rule,
  };
}

/**
 * Advisory: does last year's measured monthly average for a scheduled
 * destination sit in a different band than the frequency the bills date at?
 *
 * The pack's average-monthly bands are what the agency assigns frequencies
 * from, so a configured frequency two bands away from the measured average
 * is worth an operator's look — a large employer left on the monthly default
 * remits late all year. Advisory ONLY: it never throws (an org mid-setup can
 * hold committed payroll the summary refuses to read), and it never changes a
 * bill — the configured-or-default frequency dates, full stop.
 *
 * The average is the destination's committed prior-year total over 12
 * calendar months, stated in the message so the operator can judge it (a
 * mid-year adopter's partial year reads low by construction). Returns the
 * warning sentence, or null when there is no prior-year history for the
 * destination or the bands agree.
 */
export async function scheduledFrequencyAdvisory(
  orgId: string,
  schedule: PayrollRemittanceSchedule,
  vendorPartyId: string,
  payrollSettings: Record<string, unknown>,
  year: number,
  executor: RemittanceExecutor = db,
): Promise<string | null> {
  let groups: RemittanceGroup[];
  try {
    groups = await payrollRemittanceSummary(
      orgId,
      { from: `${year}-01-01`, to: `${year}-12-31` },
      undefined,
      executor,
    );
  } catch {
    return null;
  }
  const group = groups.find((candidate) => candidate.partyId === vendorPartyId);
  if (!group || cmp(group.total, "0") === 0) return null;
  const average = div(group.total, "12");
  const { frequency } = scheduledRemittanceFrequency(schedule, payrollSettings);
  const measured = remittanceBandForAverage(schedule, average);
  if (!measured || measured.frequency === frequency) return null;
  return `${schedule.authority} remittances averaged $${formatMoney(average, 2)}/month across ${year} — ` +
    `the ${measured.label.toLowerCase()} band — but bills date at the ${frequency.replaceAll("_", " ")} ` +
    `frequency; confirm it against your ${schedule.authority} notice in Setup → Payroll`;
}

/**
 * The identity of one remittance bill: destination vendor × period window ×
 * filing account. One bill per key — the key is both the advisory lock's
 * scope and the structured marker searched back before a second bill is minted.
 */
export interface RemittanceBillKey {
  partyId: string;
  from: string;
  to: string;
  filingAccountId: string | null;
}

/** The transaction advisory lock that serializes creation for one key. */
export function remittanceBillLockKey(orgId: string, key: RemittanceBillKey): string {
  return `payroll-remittance-bill:${orgId}:${key.partyId}:${key.from}:${key.to}:${key.filingAccountId ?? ""}`;
}

/**
 * The fence shared by every period for one remittance destination and filing
 * account. Periods are deliberately not part of this key: two overlapping
 * windows must serialize before the overlap check can decide which one wins.
 */
export function remittanceFenceLockKey(
  orgId: string,
  key: Pick<RemittanceBillKey, "partyId" | "filingAccountId">,
): string {
  return `payroll-remittance-fence:${orgId}:${key.partyId}:${key.filingAccountId ?? ""}`;
}

/**
 * The duplicate refusal, or null when the coast is clear.
 *
 * Pure, so the rule — one NON-voided remittance bill per key, and no second
 * short of voiding the first — is verifiable without a database. A voided bill
 * frees the key deliberately: the correction path is void-then-recreate, never
 * two live drafts debiting the same liabilities.
 */
export function duplicateRemittanceMessage(
  existing: { documentNumber: string | null } | undefined,
): string | null {
  if (!existing) return null;
  return `a remittance bill for this vendor, period and filing account already exists `
    + `(${existing.documentNumber ?? "unnumbered"}) — one bill per remittance; `
    + "post, edit or void that draft instead of raising a second";
}

/** Refusal for a new period that would consume liabilities already covered by
 * another live remittance bill. The exact-window case keeps the established
 * idempotency message; this names the two windows so a controller can choose
 * a non-overlapping correction period without guessing. */
export function overlappingRemittanceMessage(
  existing: { documentNumber: string | null; from: string; to: string } | undefined,
): string | null {
  if (!existing) return null;
  return `this remittance period overlaps ${existing.from} – ${existing.to}`
    + ` for the same vendor and filing account (${existing.documentNumber ?? "unnumbered"})`;
}

/**
 * Which vendor_bill series numbers the remittance bill: the org's EXISTING
 * one, never a parallel series.
 *
 * The bill is a vendor_bill like any other, and documents_org_kind_number
 * makes document numbers unique per (org, kind, number) — so allocating from
 * a private org-level series hardcoded 'BILL-' forks the org's vendor-bill
 * numbering and collides outright once the org's real series emits the same
 * prefix and number. Preference follows the AP path's own rule
 * (web/lib/bills.ts): the root subsidiary's series when the org scopes its
 * vendor bills per subsidiary, else the org-wide series. Null when neither
 * exists, and the caller seeds 'BILL-' exactly as it always did.
 */
export function pickRemittanceSequence(
  rows: readonly { prefix: string; subsidiaryId: string | null }[],
  rootSubsidiaryId: string,
): { prefix: string; subsidiaryId: string | null } | null {
  return rows.find((row) => row.subsidiaryId === rootSubsidiaryId)
    ?? rows.find((row) => row.subsidiaryId === null)
    ?? null;
}

/**
 * Materialize one destination's remittance as a draft vendor bill debiting
 * the liability accounts. Fails closed on unassigned accounts. The bill then
 * posts DR liabilities / CR AP and is paid like any other payable.
 *
 * `filingAccountId` selects the payroll program/EIN account being remitted;
 * omit it (or pass null) for the unassigned bucket of a single-account org.
 * One bill per account keeps each PD7A remittance separately traceable.
 *
 * Creating is IDEMPOTENT per (destination, period, filing account): a
 * transaction-scoped advisory lock serializes concurrent creators (a
 * double-click, a retried request), and an existing non-voided bill for the
 * same key is refused by name rather than minted twice.
 */
export async function createRemittanceBill(
  orgId: string,
  actorId: string,
  input: {
    partyId: string;
    from: string;
    to: string;
    filingAccountId?: string | null;
    allowedSubsidiaryIds?: PayrollSubsidiaryScope;
  },
): Promise<{ documentId: string; documentNumber: string }> {
  const filingAccountId = input.filingAccountId ?? null;
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(input.from)
    || !/^\d{4}-\d{2}-\d{2}$/.test(input.to)
    || input.from > input.to
  ) {
    throw new PayrollError("remittance period must be valid dates with from on or before to");
  }

  return await db.transaction(async (tx) => {
    // Serialize every period for this destination and filing account BEFORE
    // reading the accruals. The explicit READ COMMITTED mode is intentional:
    // PostgreSQL takes a fresh statement snapshot after a blocked advisory
    // lock returns, so accruals committed while this creator waited are in the
    // canonical summary below.
    await tx.execute(sql`
      select pg_advisory_xact_lock(hashtextextended(${remittanceFenceLockKey(orgId, {
        partyId: input.partyId, filingAccountId,
      })}, 0))
    `);

    const vendor = (await tx.execute<{ party_id: string | null; subsidiary_id: string | null }>(sql`
      select p.id as party_id, p.subsidiary_id
        from vendor_roles v
        left join parties p on p.id = v.party_id and p.org_id = v.org_id
       where v.org_id = ${orgId} and v.party_id = ${input.partyId} and v.is_active
    `));
    if (!vendor.rows.length) throw new PayrollError("the remittance destination must be an active vendor");
    const sub = (await tx.execute<{ id: string; base_currency: string | null }>(sql`
      select s.id, s.base_currency from subsidiaries s
       where s.org_id = ${orgId} and s.parent_id is null and s.is_active
       order by s.created_at limit 1
    `));
    if (!sub.rows[0]) throw new PayrollError("no active root subsidiary");
    if (
      input.allowedSubsidiaryIds != null
      && (!(vendor.rows[0]!.party_id)
        || !payrollSubsidiaryInScope(
          input.allowedSubsidiaryIds,
          vendor.rows[0]!.subsidiary_id ?? sub.rows[0].id,
        ))
    ) {
      throw new PayrollError("nothing to remit to this vendor for the period");
    }
    if (!payrollSubsidiaryInScope(input.allowedSubsidiaryIds, sub.rows[0].id)) {
      throw new PayrollError("nothing to remit to this vendor for the period");
    }

    if (filingAccountId) {
      const account = (await tx.execute<{ subsidiary_id: string | null }>(sql`
        select subsidiary_id from payroll_filing_accounts
         where org_id = ${orgId} and id = ${filingAccountId} and is_active
      `));
      const accountSub = account.rows[0]?.subsidiary_id ?? null;
      if (!account.rows[0]) throw new PayrollError("nothing to remit to this vendor for the period");
      if (
        input.allowedSubsidiaryIds != null
        && !payrollSubsidiaryInScope(input.allowedSubsidiaryIds, accountSub ?? sub.rows[0].id)
      ) {
        throw new PayrollError("nothing to remit to this vendor for the period");
      }
    }

    // Recompute from this transaction's snapshot only after the destination
    // fence is held. A pay run committed after a caller's preflight summary is
    // therefore included in this canonical bill, rather than stranded behind
    // an exact-period duplicate marker.
    const groups = await payrollRemittanceSummary(
      orgId,
      { from: input.from, to: input.to },
      input.allowedSubsidiaryIds,
      tx,
    );
    const group = groups.find(
      (g) => g.partyId === input.partyId && g.filingAccount.id === filingAccountId,
    );
    if (!group) throw new PayrollError("nothing to remit to this vendor for the period");
    // Fail closed for this run's boxes only: a group carrying unattributed
    // legacy accruals must not become a remittance bill under any account
    // until those stubs are reconciled. Every other group still bills.
    if (group.hasUnknownFilingAccount) {
      throw new PayrollError(
        "this remittance group includes payroll with an unknown historical filing account — reconcile its original payroll evidence before remitting",
      );
    }
    const missing = group.components.filter((c) => !c.liabilityAccountId);
    if (missing.length > 0) {
      throw new PayrollError(
        `no liability account for: ${missing.map((c) => c.name).join(", ")} — set it in Payroll setup → Accounts & posting`,
      );
    }

    // The structured marker written below is the bill's identity. Search all
    // live markers for this destination/account and reject any intersecting
    // date window, not only exact from/to equality.
    const overlap = (await tx.execute<{
      document_number: string | null; subsidiary_id: string | null; from: string; to: string;
    }>(sql`
      select document_number, subsidiary_id,
             custom->'payrollRemittance'->>'from' as from,
             custom->'payrollRemittance'->>'to' as to
        from documents
       where org_id = ${orgId} and kind = 'vendor_bill' and status <> 'voided'
         and custom->'payrollRemittance'->>'partyId' = ${input.partyId}
         and custom->'payrollRemittance'->>'from' <= ${input.to}
         and custom->'payrollRemittance'->>'to' >= ${input.from}
         and (custom->'payrollRemittance'->>'filingAccountId') is not distinct from ${filingAccountId}
      order by custom->'payrollRemittance'->>'from', created_at
      limit 1
    `));
    const existing = overlap.rows[0];
    if (existing) {
      // Keep the overlap fence org-wide: hiding a conflicting document must
      // never permit a duplicate liability bill. Its identifying metadata is
      // only available to actors who can read that document's legal entity.
      if (!payrollSubsidiaryInScope(input.allowedSubsidiaryIds, existing.subsidiary_id)) {
        throw new PayrollError("nothing to remit to this vendor for the period");
      }
      const exact = existing.from === input.from && existing.to === input.to;
      const refusal = exact
        ? duplicateRemittanceMessage({ documentNumber: existing.document_number })
        : overlappingRemittanceMessage({
            documentNumber: existing.document_number,
            from: existing.from,
            to: existing.to,
          });
      if (refusal) throw new PayrollError(refusal);
    }

    // Number off the org's EXISTING vendor_bill series — its prefix, padding
    // and current position — falling back to seeding the org-level 'BILL-'
    // series only when the org has no vendor_bill numbering at all.
    const sequences = (await tx.execute<{ prefix: string; subsidiary_id: string | null }>(sql`
      select prefix, subsidiary_id from number_sequences
       where org_id = ${orgId} and document_kind = 'vendor_bill'
         and (subsidiary_id = ${sub.rows[0]!.id} or subsidiary_id is null)
    `));
    const chosen = pickRemittanceSequence(
      sequences.rows.map((row) => ({ prefix: row.prefix, subsidiaryId: row.subsidiary_id })),
      sub.rows[0]!.id,
    );
    const seq = (await tx.execute<{ prefix: string; next_number: number; padding: number }>(sql`
      insert into number_sequences (org_id, document_kind, subsidiary_id, prefix)
      values (${orgId}, 'vendor_bill', ${chosen?.subsidiaryId ?? null}, ${chosen?.prefix ?? "BILL-"})
      on conflict on constraint sequences_org_kind_sub
      do update set next_number = number_sequences.next_number + 1
      where number_sequences.org_id = ${orgId}
      returning prefix, next_number, padding
    `));
    const number = `${seq.rows[0]!.prefix}${String(seq.rows[0]!.next_number).padStart(seq.rows[0]!.padding, "0")}`;

    const total = sum(group.components.map((c) => c.amount));
    // The bill's due date comes from the DESTINATION's schedule when a pack
    // declares one (Revenu Québec's, today) — the filing account's CRA
    // remitter type is a registration with another agency and never applies
    // to a scheduled destination. Undeclared destinations keep the legacy
    // CRA-function behaviour.
    const dueDate = group.schedule?.dueDate
      ?? remittanceDueDate(input.to, group.filingAccount.remitterType, {
        quebec: remittanceGroupUsesQuebecCalendar(group.provinces),
      });
    const doc = (await tx.execute<{ id: string }>(sql`
      insert into documents (org_id, kind, document_number, party_id, subsidiary_id, document_date,
                             due_date, currency, status, memo, subtotal, tax_total, total, custom,
                             created_by, updated_by)
      values (${orgId}, 'vendor_bill', ${number}, ${input.partyId}, ${sub.rows[0]!.id}, ${input.to},
              ${dueDate},
              ${sub.rows[0]!.base_currency}, 'draft',
              ${remittanceMemo(group, input.from, input.to)}, ${total}, '0', ${total},
              ${JSON.stringify({
                payrollRemittance: {
                  partyId: input.partyId, from: input.from, to: input.to, filingAccountId,
                  // The filing account's CRA registration, for operators
                  // reconciling the bill against the PD7A. It did NOT date
                  // this bill when a destination schedule governs — see
                  // `schedule`, which names what did.
                  remitterType: group.filingAccount.remitterType,
                  schedule: group.schedule
                    ? {
                        vendorSettingsKey: group.schedule.vendorSettingsKey,
                        authority: group.schedule.authority,
                        frequency: group.schedule.frequency,
                      }
                    : null,
                },
              })}::jsonb,
              ${actorId}, ${actorId})
      returning id
    `));
    const documentId = doc.rows[0]!.id;
    let lineNumber = 1;
    for (const component of group.components) {
      await tx.execute(sql`
        insert into document_lines (org_id, document_id, line_number, account_id, description,
                                    quantity, unit_price, amount, created_by, updated_by)
        values (${orgId}, ${documentId}, ${lineNumber++}, ${component.liabilityAccountId},
                ${`${component.name} · ${input.from} – ${input.to}`}, 1, ${component.amount},
                ${component.amount}, ${actorId}, ${actorId})
      `);
    }
    return { documentId, documentNumber: number };
  }, { isolationLevel: "read committed" });
}

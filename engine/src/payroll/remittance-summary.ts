import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { add, cmp, div, formatMoney, mulRate, neg, roundMoney } from "../money/money.ts";
import { type FilingAccountRef, type PayrollFilingAccount } from "./filing.ts";
import { PayrollError } from "./error.ts";
import {
  allRemittanceSchedules,
  remittanceBandForAverage,
  type PayrollRemittanceSchedule,
} from "./packs.ts";
import { payrollSubsidiaryScopeFilter, type PayrollSubsidiaryScope } from "./scope.ts";
import {
  groupKey,
  groupRemittanceRows,
  scheduledRemittanceFrequency,
  scheduleForRemittanceGroup,
  type RemittanceGroup,
  type RemittanceRow,
} from "./remittance-group-schedule.ts";
import {
  makeRemittanceDestinationResolver,
  remittancePeriodProblem,
  type RemittanceResolvableRow,
} from "./remittance-destination.ts";

/** Remittance summary: committed accruals folded by destination, filing account, and legal entity. */

export type RemittanceExecutor = Pick<typeof db, "execute">;

/** The raw orgs.settings.payroll blob — indexed by whatever settings keys the
 *  pack declarations name, so this module needs no typed knowledge of them. */
export async function rawPayrollSettings(
  orgId: string,
  executor: RemittanceExecutor = db,
): Promise<Record<string, unknown>> {
  const r = await executor.execute<{ p: Record<string, unknown> | null }>(
    sql`select settings->'payroll' as p from orgs where id = ${orgId}`,
    "objects",
  );
  return r[0]?.p ?? {};
}

/** Load filing-account labels through the caller's transaction when one is
 * active. A remittance bill must resolve its group and labels from the same
 * snapshot that supplies the accrued rows, not from a second pooled session. */
async function filingAccountsByIdIn(
  orgId: string,
  executor: RemittanceExecutor,
): Promise<Map<string, PayrollFilingAccount>> {
  const rows = await executor.execute<Record<string, unknown>>(
    sql`
    select id, country, program_type, account_number, name, remitter_type,
           subsidiary_id, state_code, is_default, is_active
      from payroll_filing_accounts
     where org_id = ${orgId}
     order by is_default desc, account_number
  `,
    "objects",
  );
  return new Map(
    rows.map((row) => [
      String(row.id),
      {
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
      },
    ]),
  );
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
/**
 * Resolve the derived consolidated average rate for every (currency, period)
 * a mixed-currency summary must translate, keyed `currency → periodId`.
 * Amounts translate ONLY through a stored consolidated row (derived at period
 * close or set by a controller override) — a missing row throws with the
 * trial balance's own message instead of being defaulted to 1.
 */
async function derivedAverageRates(
  orgId: string,
  presentation: string,
  needs: readonly { currency: string; periodId: string; periodEnd: string }[],
  executor: RemittanceExecutor,
): Promise<Map<string, string>> {
  const foreign = needs.filter((need) => need.currency !== presentation);
  if (foreign.length === 0) return new Map();
  const periodIds = [...new Set(foreign.map((need) => need.periodId))];
  const currencies = [...new Set(foreign.map((need) => need.currency))];
  const stored = await executor.execute<{
    period_id: string;
    currency: string;
    average_rate: string;
  }>(
    sql`
    select period_id::text as period_id, from_currency as currency, average_rate::text as average_rate
      from consolidated_fx_rates
     where org_id = ${orgId} and to_currency = ${presentation}
       and period_id = any(${`{${periodIds.join(",")}}`}::uuid[])
       and from_currency = any(${`{${currencies.join(",")}}`}::text[])`,
    "objects",
  );
  const byKey = new Map(
    stored.map((row) => [`${row.currency}→${row.period_id}`, row.average_rate]),
  );
  for (const need of foreign) {
    if (!byKey.has(`${need.currency}→${need.periodId}`)) {
      throw new PayrollError(
        `No consolidated exchange rates for ${need.currency} → ${presentation} in the period ending ${need.periodEnd}. Derive rates from period close first.`,
      );
    }
  }
  return byKey;
}

/**
 * The mixed-currency half of the remittance summary. When the period's
 * committed stubs span more than one currency, raw units must never be added:
 * every accrual and gross slice is translated to the organization's base
 * currency through the derived consolidated average rate of its own period,
 * or the summary refuses naming the missing pair. Single-currency scopes
 * never reach here, so their figures stay byte-identical.
 */
async function mixedCurrencyAccruals(
  orgId: string,
  range: { from: string; to: string },
  allowedSubsidiaryIds: PayrollSubsidiaryScope | undefined,
  executor: RemittanceExecutor,
  presentation: string,
  isInternalAccrual: (row: { systemKey: string | null; country: string | null }) => boolean,
): Promise<{
  rows: RemittanceRow[];
  contextByAccount: Map<string, { gross: string; employees: number }>;
}> {
  const filingAccount = sql`s.filing_account_id`;
  // Stubs whose pay date falls in no regular accounting period can be
  // neither translated nor summed: refusing names the date and why, instead
  // of silently dropping their money from the accruals below. The coverage
  // guard and the per-row lateral joins below carry the default-calendar
  // join inline (set-based form of the shared covering-period resolver:
  // same predicate, same deterministic ordering), because a row-wise
  // helper call cannot serve a grouped query.
  const dateless = await executor.execute<{ pay_date: string; currency: string }>(
    sql`
    select s.pay_date::text as pay_date, s.currency_code as currency
      from pay_stubs s
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id and r.run_status = 'committed'
      join documents source_document on source_document.id = r.document_id and source_document.org_id = r.org_id
     where s.org_id = ${orgId} and s.pay_date between ${range.from} and ${range.to}
       ${payrollSubsidiaryScopeFilter(sql`source_document.subsidiary_id`, allowedSubsidiaryIds)}
       and not exists (
         select 1 from accounting_periods p
          join fiscal_calendars fc on fc.id = p.fiscal_calendar_id and fc.org_id = p.org_id
            and fc.is_default and fc.is_active
          where p.org_id = ${orgId} and not p.is_adjustment
            and p.starts_on <= s.pay_date and p.ends_on >= s.pay_date
       )
     limit 1`,
    "objects",
  );
  if (dateless[0]) {
    throw new PayrollError(
      `cannot translate ${dateless[0].currency} payroll dated ${dateless[0].pay_date}: ` +
        `no regular accounting period covers that date, so no derived consolidated rate can exist for it`,
    );
  }
  const slices = await executor.execute<{
    component_id: string;
    code: string;
    name: string;
    kind: "deduction" | "employer_contribution" | "credit";
    system_key: string | null;
    country: string | null;
    remittance_party_id: string | null;
    component_party_id: string | null;
    covered_party_id: string | null;
    liability_account_id: string | null;
    filing_account_id: string | null;
    filingUnknown: boolean;
    province: string;
    subsidiary_id: string | null;
    currency: string;
    period_id: string;
    period_end: string;
    amount: string;
  }>(
    sql`
    select c.id as component_id, c.code, c.name, c.kind, c.system_key, c.country, l.remittance_party_id,
           c.remittance_party_id as component_party_id,
           (select cover_bill.party_id
              from payroll_remittance_coverage cov
              join documents cover_bill
                on cover_bill.id = cov.bill_document_id and cover_bill.org_id = cov.org_id
               and cover_bill.status <> 'voided'
             where cov.org_id = l.org_id and cov.stub_line_id = l.id
             order by cover_bill.created_at desc, cover_bill.id desc
             limit 1) as covered_party_id,
           l.liability_account_id,
           ${filingAccount} as filing_account_id,
           bool_or(s.filing_account_source = 'unknown' or s.filing_account_id is null) as "filingUnknown",
           s.province,
           source_document.subsidiary_id,
           s.currency_code as currency,
           period.id as period_id, period.ends_on::text as period_end,
           sum(l.amount) as amount
      from pay_stub_lines l
      join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id and r.run_status = 'committed'
      join pay_components c on c.id = l.component_id and c.org_id = l.org_id
      join documents source_document on source_document.id = r.document_id and source_document.org_id = r.org_id
      join lateral (
        select p.id, p.ends_on from accounting_periods p
          join fiscal_calendars fc on fc.id = p.fiscal_calendar_id and fc.org_id = p.org_id
            and fc.is_default and fc.is_active
         where p.org_id = ${orgId} and not p.is_adjustment
           and p.starts_on <= s.pay_date and p.ends_on >= s.pay_date
         order by p.starts_on, p.ends_on, p.id limit 1
      ) period on true
     where l.org_id = ${orgId} and s.pay_date between ${range.from} and ${range.to}
       and l.kind in ('deduction', 'employer_contribution', 'credit')
       ${payrollSubsidiaryScopeFilter(sql`source_document.subsidiary_id`, allowedSubsidiaryIds)}
     group by c.id, c.code, c.name, c.kind, c.system_key, c.country, l.remittance_party_id,
              c.remittance_party_id, covered_party_id,
              l.liability_account_id, ${filingAccount}, s.province,
              source_document.subsidiary_id,
              s.currency_code, period.id, period.ends_on
     order by c.sequence, c.code
  `,
    "objects",
  );
  const grossSlices = await executor.execute<{
    filing_account_id: string | null;
    currency: string;
    period_id: string;
    period_end: string;
    gross: string;
  }>(
    sql`
    select ${filingAccount} as filing_account_id, s.currency_code as currency,
           period.id as period_id, period.ends_on::text as period_end,
           sum(s.gross) as gross
      from pay_stubs s
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id and r.run_status = 'committed'
      join documents source_document on source_document.id = r.document_id and source_document.org_id = r.org_id
      join lateral (
        select p.id, p.ends_on from accounting_periods p
          join fiscal_calendars fc on fc.id = p.fiscal_calendar_id and fc.org_id = p.org_id
            and fc.is_default and fc.is_active
         where p.org_id = ${orgId} and not p.is_adjustment
           and p.starts_on <= s.pay_date and p.ends_on >= s.pay_date
         order by p.starts_on, p.ends_on, p.id limit 1
      ) period on true
     where s.org_id = ${orgId} and s.pay_date between ${range.from} and ${range.to}
       ${payrollSubsidiaryScopeFilter(sql`source_document.subsidiary_id`, allowedSubsidiaryIds)}
     group by ${filingAccount}, s.currency_code, period.id, period.ends_on
  `,
    "objects",
  );
  const rates = await derivedAverageRates(
    orgId,
    presentation,
    [
      ...slices.map((row) => ({
        currency: row.currency,
        periodId: row.period_id,
        periodEnd: row.period_end,
      })),
      ...grossSlices.map((row) => ({
        currency: row.currency,
        periodId: row.period_id,
        periodEnd: row.period_end,
      })),
    ],
    executor,
  );
  const translate = (amount: string, currency: string, periodId: string): string => {
    if (currency === presentation) return amount;
    const rate = rates.get(`${currency}→${periodId}`);
    if (!rate) {
      throw new PayrollError(
        `No consolidated exchange rates for ${currency} → ${presentation}. Derive rates from period close first.`,
      );
    }
    return roundMoney(mulRate(amount, rate), 2);
  };
  const rows: RemittanceRow[] = slices
    .filter((row) => !isInternalAccrual({ systemKey: row.system_key, country: row.country }))
    .map((row) => ({
      component_id: row.component_id,
      code: row.code,
      name: row.name,
      kind: row.kind,
      system_key: row.system_key,
      country: row.country,
      remittance_party_id: row.remittance_party_id,
      component_party_id: row.component_party_id,
      covered_party_id: row.covered_party_id,
      liability_account_id: row.liability_account_id,
      filing_account_id: row.filing_account_id,
      filingUnknown: row.filingUnknown,
      province: row.province,
      subsidiary_id: row.subsidiary_id,
      currency: row.currency,
      // Native units for the entity slice; translated units for the
      // consolidated group. A credit nets against the destination in both
      // readings, so the negation below applies to both.
      sliceAmount: row.kind === "credit" ? neg(row.amount) : row.amount,
      amount: translate(row.amount, row.currency, row.period_id),
    }))
    .map((row) => (row.kind === "credit" ? { ...row, amount: neg(row.amount) } : row));
  const headcounts = await executor.execute<{
    filing_account_id: string | null;
    employees: number;
  }>(
    sql`
    select ${filingAccount} as filing_account_id,
           count(distinct s.employee_party_id)::int as employees
      from pay_stubs s
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id and r.run_status = 'committed'
      join documents source_document on source_document.id = r.document_id and source_document.org_id = r.org_id
     where s.org_id = ${orgId} and s.pay_date between ${range.from} and ${range.to}
       ${payrollSubsidiaryScopeFilter(sql`source_document.subsidiary_id`, allowedSubsidiaryIds)}
     group by ${filingAccount}
  `,
    "objects",
  );
  const grossByAccount = new Map<string, string>();
  for (const slice of grossSlices) {
    const key = slice.filing_account_id ?? "";
    grossByAccount.set(
      key,
      add(grossByAccount.get(key) ?? "0", translate(slice.gross, slice.currency, slice.period_id)),
    );
  }
  const contextByAccount = new Map<string, { gross: string; employees: number }>(
    headcounts.map((row) => [
      row.filing_account_id ?? "",
      { gross: grossByAccount.get(row.filing_account_id ?? "") ?? "0", employees: row.employees },
    ]),
  );
  return { rows, contextByAccount };
}

export async function payrollRemittanceSummary(
  orgId: string,
  range: { from: string; to: string },
  allowedSubsidiaryIds?: PayrollSubsidiaryScope,
  executor: RemittanceExecutor = db,
): Promise<RemittanceGroup[]> {
  const periodProblem = remittancePeriodProblem(range.from, range.to);
  if (periodProblem) throw new PayrollError(periodProblem);
  const rawSettings = await rawPayrollSettings(orgId, executor);
  // No org-wide unknown-filing-account refusal here: one legacy run must not
  // poison the summary for the rest. Stubs whose filing account was never
  // attributed carry a null account into the unassigned group and flag it
  // (hasUnknownFilingAccount); only bill creation for a flagged group fails
  // closed, until those stubs are reconciled.
  const filingAccount = sql`s.filing_account_id`;
  // One shared destination resolver for the summary AND the bill creator's
  // coverage reads: pack declarations are resolved country-first (two packs
  // may give the same withholding the same system key, so the country
  // stamped on the component row picks the pack), and internal accruals
  // (liabilities that settle through employee payout, never remittance) are
  // excluded by the same predicate in both paths.
  const sharedResolution = makeRemittanceDestinationResolver(rawSettings);
  // Every group states its own currency (RemittanceGroup.currency): a scope
  // whose committed stubs share one currency states that native currency —
  // even when it differs from the org's base — and a scope spanning more
  // than one currency takes the mixed-currency path (translate each slice
  // through its own period's derived consolidated rate, or refuse naming the
  // missing pair) and states the org's base with `translated` set. A
  // single-currency scope keeps the historical queries below verbatim, so
  // its figures stay byte-identical.
  const presentation =
    (
      await executor.execute<{ base_currency: string }>(
        sql`
    select base_currency from orgs where id = ${orgId}`,
        "objects",
      )
    )[0]?.base_currency ?? null;
  const scopeCurrencies = presentation
    ? (
        await executor.execute<{ currency: string }>(
          sql`
      select distinct s.currency_code as currency
        from pay_stubs s
        join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id and r.run_status = 'committed'
        join documents source_document on source_document.id = r.document_id and source_document.org_id = r.org_id
       where s.org_id = ${orgId} and s.pay_date between ${range.from} and ${range.to}
         ${payrollSubsidiaryScopeFilter(sql`source_document.subsidiary_id`, allowedSubsidiaryIds)}`,
          "objects",
        )
      ).map((row) => row.currency)
    : [];
  let rows: RemittanceRow[];
  let contextByAccount: Map<string, { gross: string; employees: number }>;
  // The consolidated presentation currency, set only when the mixed path
  // below translates into the org's base. A single-currency scope states its
  // native currency per group instead — even a foreign one.
  let presentationCurrency: string | undefined;
  if (scopeCurrencies.length > 1 && presentation) {
    ({ rows, contextByAccount } = await mixedCurrencyAccruals(
      orgId,
      range,
      allowedSubsidiaryIds,
      executor,
      presentation,
      sharedResolution.isInternalAccrual,
    ));
    presentationCurrency = presentation;
  } else {
    // Grouped by the STUB's snapshot province as well as by component: a
    // component whose pack declares a region-scoped remittance vendor (QPP and
    // QPIP go to Revenu Québec for QC employment, to the CRA nowhere) splits by
    // destination, and rows that resolve to the same vendor are re-merged per
    // component in groupRemittanceRows.
    const queried = await executor.execute<{
      component_id: string;
      code: string;
      name: string;
      kind: "deduction" | "employer_contribution" | "credit";
      system_key: string | null;
      country: string | null;
      remittance_party_id: string | null;
      component_party_id: string | null;
      covered_party_id: string | null;
      liability_account_id: string | null;
      filing_account_id: string | null;
      filingUnknown: boolean;
      province: string;
      subsidiary_id: string | null;
      currency: string;
      amount: string;
    }>(
      sql`
    select c.id as component_id, c.code, c.name, c.kind, c.system_key, c.country, l.remittance_party_id,
           -- The component's CURRENT vendor: unremitted liabilities committed
           -- while the component named no vendor (null snapshot above) resolve
           -- against this live assignment instead of surfacing unassigned.
           c.remittance_party_id as component_party_id,
           -- The live bill that consumed the row's lines, if any: consumed
           -- lines keep their bill's vendor as history even when the
           -- component is reassigned afterwards. Voided bills free their
           -- lines back to live resolution, so they never pin. A scalar
           -- subquery (never a join): one row per stub line even if two
           -- live bills ever covered the same line, so grouped sums can
           -- never double-count it.
           (select cover_bill.party_id
              from payroll_remittance_coverage cov
              join documents cover_bill
                on cover_bill.id = cov.bill_document_id and cover_bill.org_id = cov.org_id
               and cover_bill.status <> 'voided'
             where cov.org_id = l.org_id and cov.stub_line_id = l.id
             order by cover_bill.created_at desc, cover_bill.id desc
             limit 1) as covered_party_id,
           -- Historical accrual evidence only. Current statutory account
           -- setup cannot establish where an older liability accrued: that
           -- stays the stub line's commit-time snapshot.
           l.liability_account_id,
           ${filingAccount} as filing_account_id,
           bool_or(s.filing_account_source = 'unknown' or s.filing_account_id is null) as "filingUnknown",
           s.province,
           -- The WRITE path's grouping dimension: which entity's books
           -- credited the accrual, and in which currency. Splitting rows by
           -- entity changes nothing consolidated — groupRemittanceRows folds
           -- them back — so single-entity figures stay byte-identical.
           source_document.subsidiary_id,
           s.currency_code as currency,
           sum(l.amount) as amount
      from pay_stub_lines l
      join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id and r.run_status = 'committed'
      join pay_components c on c.id = l.component_id and c.org_id = l.org_id
      join documents source_document on source_document.id=r.document_id and source_document.org_id=r.org_id
     where l.org_id = ${orgId} and s.pay_date between ${range.from} and ${range.to}
       and l.kind in ('deduction', 'employer_contribution', 'credit')
       ${payrollSubsidiaryScopeFilter(sql`source_document.subsidiary_id`, allowedSubsidiaryIds)}
     group by c.id, c.code, c.name, c.kind, c.system_key, c.country, l.remittance_party_id,
              c.remittance_party_id, covered_party_id,
              l.liability_account_id, ${filingAccount}, s.province,
              source_document.subsidiary_id, s.currency_code
     order by c.sequence, c.code
  `,
      "objects",
    );
    // Internal accruals never remit, and each pack declares its own — so the
    // exclusion is per component country, not per system key. Rows with no
    // system key (user components) always stay in the summary.
    // A `credit` row is money the employer reclaims from the destination, so it
    // nets AGAINST the group's withholdings (F24 compensation): the summary's
    // group total is what the employer actually sends, never the gross levy.
    // The slice amount rides along natively: this path is single-currency, so
    // it agrees with the consolidated amount by construction.
    rows = queried
      .filter(
        (row) =>
          !sharedResolution.isInternalAccrual({ systemKey: row.system_key, country: row.country }),
      )
      .map((row) => ({
        ...row,
        sliceAmount: row.kind === "credit" ? neg(row.amount) : row.amount,
      }))
      .map((row) => (row.kind === "credit" ? { ...row, amount: neg(row.amount) } : row));

    const context = await executor.execute<{
      filing_account_id: string | null;
      gross: string;
      employees: number;
    }>(
      sql`
    select ${filingAccount} as filing_account_id,
           coalesce(sum(s.gross), 0) as gross,
           count(distinct s.employee_party_id)::int as employees
      from pay_stubs s
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id and r.run_status = 'committed'
      join documents source_document on source_document.id=r.document_id and source_document.org_id=r.org_id
     where s.org_id = ${orgId} and s.pay_date between ${range.from} and ${range.to}
       ${payrollSubsidiaryScopeFilter(sql`source_document.subsidiary_id`, allowedSubsidiaryIds)}
     group by ${filingAccount}
  `,
      "objects",
    );
    contextByAccount = new Map(context.map((row) => [row.filing_account_id ?? "", row]));
  }
  if (rows.length === 0) return [];
  if (rows.some((row) => !row.liability_account_id && cmp(row.amount, "0") !== 0)) {
    throw new PayrollError(
      "Committed payroll has an unknown historical liability account. Reconcile its original payroll posting evidence before generating remittance reports or bills.",
    );
  }
  const filingAccounts = await filingAccountsByIdIn(orgId, executor);

  // Destination resolves through the pack declarations over the stub line's
  // commit-time snapshot (migration 0296) — never the live component. A
  // REGION-scoped vendor declaration for the stub's province (QPP/QPIP → the
  // Revenu Québec vendor for QC stubs) resolves FIRST, outranking even the
  // snapshot, because that column is one value on a component whose amounts
  // split by destination. Otherwise a `tax_authority` component falls back to
  // the vendor named by ITS pack's remittanceVendorSettingsKey (the CRA
  // remittance vendor for the CA pack; a pack that declares none surfaces
  // unassigned for setup, which is where the US statutory components have
  // always landed). An `external` component (WCB, SUTA) only ever uses its
  // own snapshot party.
  const resolver = sharedResolution;
  const toResolvable = (row: (typeof rows)[number]): RemittanceResolvableRow => ({
    snapshotPartyId: row.remittance_party_id,
    componentPartyId: row.component_party_id,
    coveredPartyId: row.covered_party_id,
    systemKey: row.system_key,
    country: row.country,
    province: row.province,
  });
  const resolveDestination = (
    row: (typeof rows)[number],
  ): { partyId: string | null; vendorKey: string | null } =>
    resolver.resolveDestination(toResolvable(row));
  const resolveParty = (row: (typeof rows)[number]): string | null =>
    resolveDestination(row).partyId;
  const resolveVendorKey = (row: (typeof rows)[number]): string | null =>
    resolveDestination(row).vendorKey;
  const resolveAccount = (row: (typeof rows)[number]): string | null => row.liability_account_id;

  // Slice labelling: every accrual names its entity, and the entity names
  // its currency. Read from the same snapshot as the rows above.
  const subsidiaryRows = await executor.execute<{
    id: string;
    name: string | null;
    currency: string | null;
  }>(
    sql`
    select id::text as id, name, base_currency as currency from subsidiaries
     where org_id = ${orgId} and is_active
  `,
    "objects",
  );
  const subsidiaries = new Map(
    subsidiaryRows.map((s) => [s.id, { name: s.name, currency: s.currency }]),
  );

  const groups = groupRemittanceRows({
    rows,
    contextByAccount,
    filingAccounts,
    resolveParty,
    resolveAccount,
    resolveVendorKey,
    subsidiaries,
    presentationCurrency,
  });

  // One group, one destination, one schedule. Provenance first: rows that
  // arrived through a scheduled destination's vendor key are governed by that
  // schedule. Otherwise a group whose PARTY is a scheduled destination's
  // configured vendor (an `external` component pointed at the RQ vendor)
  // resolves through the party. A destination without a schedule refuses when
  // the bill is dated.
  const schedules = allRemittanceSchedules();
  for (const group of groups.values()) {
    if (group.hasUnknownFilingAccount) {
      group.schedule = null;
      continue;
    }
    group.schedule = scheduleForRemittanceGroup({
      vendorKeys: group.vendorKeys,
      partyId: group.partyId,
      periodTo: range.to,
      payrollSettings: rawSettings,
      filingAccount: group.filingAccount,
      regionalCalendar: group.regionalCalendar,
      schedules,
    });
  }

  // Names + account labels + prior bills for the same destination and any
  // overlapping period. Loading the complete marker window lets callers show
  // that an accrual is already covered even when their requested range is
  // wider or narrower than the bill that consumed it.
  const partyIds = [
    ...new Set([...groups.values()].map((g) => g.partyId).filter(Boolean)),
  ] as string[];
  const accountIds = [
    ...new Set(
      [...groups.values()]
        .flatMap((g) => g.components.map((c) => c.liabilityAccountId))
        .filter(Boolean),
    ),
  ] as string[];
  // Run these reads sequentially when `executor` is a transaction. Drizzle's
  // transaction client is one PostgreSQL connection; Promise.all would queue
  // concurrent queries on that connection and can produce an overlapping
  // client.query warning while providing no snapshot benefit.
  const parties = partyIds.length
    ? await executor.execute<{ id: string; display_name: string }>(
        sql`select id, display_name from parties
                      where org_id = ${orgId} and id = any(${`{${partyIds.join(",")}}`}::uuid[])`,
        "objects",
      )
    : [];
  const accounts = accountIds.length
    ? await executor.execute<{ id: string; number: string | null; name: string }>(
        sql`select id, number, name from accounts
                      where org_id = ${orgId} and id = any(${`{${accountIds.join(",")}}`}::uuid[])`,
        "objects",
      )
    : [];
  const bills = await executor.execute<{
    id: string;
    document_number: string;
    status: string;
    total: string;
    party_id: string | null;
    filing_account_id: string | null;
    subsidiary_id: string | null;
    from: string | null;
    to: string | null;
  }>(
    sql`
    select id, document_number, status, total, party_id,
           custom->'payrollRemittance'->>'filingAccountId' as filing_account_id,
           custom->'payrollRemittance'->>'subsidiaryId' as subsidiary_id,
           custom->'payrollRemittance'->>'from' as from,
           custom->'payrollRemittance'->>'to' as to
      from documents
     where org_id = ${orgId} and kind = 'vendor_bill'
       and custom->'payrollRemittance'->>'from' <= ${range.to}
       and custom->'payrollRemittance'->>'to' >= ${range.from}
       and status <> 'voided'
       ${payrollSubsidiaryScopeFilter(sql`subsidiary_id`, allowedSubsidiaryIds)}`,
    "objects",
  );
  const partyName = new Map(parties.map((p) => [p.id, p.display_name]));
  const accountLabel = new Map(
    accounts.map((a) => [a.id, a.number ? `${a.number} · ${a.name}` : a.name]),
  );
  for (const group of groups.values()) {
    group.partyName = group.partyId ? (partyName.get(group.partyId) ?? null) : null;
    for (const component of group.components) {
      component.accountLabel = component.liabilityAccountId
        ? (accountLabel.get(component.liabilityAccountId) ?? null)
        : null;
    }
    for (const slice of group.slices) {
      for (const component of slice.components) {
        component.accountLabel = component.liabilityAccountId
          ? (accountLabel.get(component.liabilityAccountId) ?? null)
          : null;
      }
    }
    const matched = bills.filter(
      (b) =>
        b.from != null &&
        b.to != null &&
        b.from <= range.to &&
        b.to >= range.from &&
        groupKey(b.party_id ?? null, b.filing_account_id) ===
          groupKey(group.partyId, group.filingAccount.id),
    );
    group.existingBills = matched.map((b) => ({
      documentId: b.id,
      documentNumber: b.document_number,
      status: b.status,
      total: b.total,
    }));
    // Each slice sees its own bills plus legacy bills with no entity marker
    // (which covered the consolidated group and may cover this slice — the
    // bill creator fails closed on them rather than guessing).
    for (const slice of group.slices) {
      slice.existingBills = matched
        .filter((b) => b.subsidiary_id == null || b.subsidiary_id === slice.subsidiaryId)
        .map((b) => ({
          documentId: b.id,
          documentNumber: b.document_number,
          status: b.status,
          total: b.total,
        }));
    }
  }
  return [...groups.values()].sort(
    (a, b) =>
      (a.partyName ?? "￿").localeCompare(b.partyName ?? "￿") ||
      (a.filingAccount.accountNumber ?? "").localeCompare(b.filingAccount.accountNumber ?? ""),
  );
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
  filingAccount: FilingAccountRef | null = null,
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
  const group = groups.find(
    (candidate) =>
      candidate.partyId === vendorPartyId &&
      (schedule.frequencySource !== "filing_account" ||
        candidate.filingAccount.id === filingAccount?.id),
  );
  if (!group || cmp(group.total, "0") === 0) return null;
  const average = div(group.total, "12");
  let frequency: string;
  try {
    ({ frequency } = scheduledRemittanceFrequency(schedule, payrollSettings, filingAccount));
  } catch {
    return null;
  }
  const measured = remittanceBandForAverage(schedule, average);
  if (!measured || measured.frequency === frequency) return null;
  return (
    `${schedule.authority} remittances averaged $${formatMoney(average, 2)}/month across ${year} — ` +
    `the ${measured.label.toLowerCase()} band — but bills date at the ${frequency.replaceAll("_", " ")} ` +
    `frequency; confirm it against your ${schedule.authority} notice in Setup → Payroll`
  );
}

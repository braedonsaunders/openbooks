import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { cmp, neg, sum } from "../money/money.ts";
import { PayrollError } from "./error.ts";
import {
  rawPayrollSettings,
  payrollRemittanceSummary,
  type RemittanceExecutor,
} from "./remittance-summary.ts";
import {
  makeRemittanceDestinationResolver,
  type RemittanceResolvableRow,
} from "./remittance-destination.ts";

/** Remittance bill integrity: a generated bill must still match its live payroll source. */

/**
 * Reconcile a remittance bill against the committed payroll it snapshots.
 *
 * A bill is deliberately created as a normal AP draft, so payroll can be
 * voided or another run can commit while that draft waits for review. Posting
 * is the irreversible boundary: lock every pay run in the marked period,
 * re-read the bill marker, then prove every line this bill consumed is still
 * a live committed accrual for this bill's vendor. The source locks serialize
 * this check with both commit and controlled payroll voids; a stale draft
 * therefore fails closed instead of becoming an over-remittance through the
 * generic AP poster.
 *
 * Growth never blocks: accruals committed after the bill only extend the
 * scope, and a later incremental bill consumes them. Only the bill's OWN
 * covered lines are liveness-checked — a covered line that vanished (void),
 * changed amount (amendment), or now resolves elsewhere (settings moved it)
 * refuses by name. A bill with no coverage rows at all predates the coverage
 * write and keeps the legacy whole-scope total comparison.
 */
export async function assertPayrollRemittanceBillCurrent(
  orgId: string,
  documentId: string,
  executor: RemittanceExecutor = db,
): Promise<void> {
  const marker = (
    await executor.execute<{
      party_id: string | null;
      total: string;
      document_number: string | null;
      from: string | null;
      to: string | null;
      filing_account_id: string | null;
      subsidiary_id: string | null;
    }>(
      sql`
    select party_id::text as party_id, total::text as total,
           document_number,
           custom->'payrollRemittance'->>'from' as from,
           custom->'payrollRemittance'->>'to' as to,
           custom->'payrollRemittance'->>'filingAccountId' as filing_account_id,
           custom->'payrollRemittance'->>'subsidiaryId' as subsidiary_id
      from documents
     where org_id = ${orgId} and id = ${documentId}
       and kind = 'vendor_bill' and custom ? 'payrollRemittance'
  `,
      "objects",
    )
  )[0];
  if (!marker) return;
  if (
    !marker.party_id ||
    !marker.from ||
    !marker.to ||
    !/^\d{4}-\d{2}-\d{2}$/.test(marker.from) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(marker.to) ||
    marker.from > marker.to ||
    (marker.filing_account_id !== null && !isUuid(marker.filing_account_id))
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

  const locked = (
    await executor.execute<{
      party_id: string | null;
      total: string;
      document_number: string | null;
      currency: string;
      doc_subsidiary_id: string | null;
      from: string | null;
      to: string | null;
      filing_account_id: string | null;
      subsidiary_id: string | null;
    }>(
      sql`
    select party_id::text as party_id, total::text as total,
           document_number, currency,
           subsidiary_id::text as doc_subsidiary_id,
           custom->'payrollRemittance'->>'from' as from,
           custom->'payrollRemittance'->>'to' as to,
           custom->'payrollRemittance'->>'filingAccountId' as filing_account_id,
           custom->'payrollRemittance'->>'subsidiaryId' as subsidiary_id
      from documents
     where org_id = ${orgId} and id = ${documentId}
       and kind = 'vendor_bill' and custom ? 'payrollRemittance'
     for update
  `,
      "objects",
    )
  )[0];
  if (!locked || !locked.party_id || !locked.from || !locked.to) {
    throw new PayrollError("payroll remittance bill has an invalid source marker");
  }
  const billName = locked.document_number ?? "unnumbered";
  const staleRemedy = `void this draft and raise a fresh bill`;
  // The bill posts in its source entity's books and currency: the header row
  // must still carry the stamped subsidiary and currency. Either drifting —
  // by a header edit that bypassed the editor or by direct writes — refuses
  // here even when the coverage itself is untouched.
  if (locked.doc_subsidiary_id !== locked.subsidiary_id) {
    throw new PayrollError(
      `payroll remittance bill ${billName} no longer matches its committed source: ` +
        `its subsidiary changed; ${staleRemedy}`,
    );
  }
  if (locked.subsidiary_id !== null) {
    const entity = (
      await executor.execute<{ base_currency: string }>(
        sql`
      select base_currency from subsidiaries
       where org_id = ${orgId} and id = ${locked.subsidiary_id}
    `,
        "objects",
      )
    )[0];
    if (!entity) {
      throw new PayrollError(
        `payroll remittance bill ${billName} no longer matches its committed source: ` +
          `its source entity is gone; ${staleRemedy}`,
      );
    }
    if (locked.currency !== entity.base_currency) {
      throw new PayrollError(
        `payroll remittance bill ${billName} no longer matches its committed source: ` +
          `its currency ${locked.currency} differs from its entity's ${entity.base_currency}; ${staleRemedy}`,
      );
    }
  }

  const coverage = await executor.execute<{ stub_line_id: string; amount: string }>(
    sql`
    select cov.stub_line_id::text as stub_line_id, cov.amount::text as amount
      from payroll_remittance_coverage cov
     where cov.org_id = ${orgId} and cov.bill_document_id = ${documentId}
     order by cov.stub_line_id
  `,
    "objects",
  );

  if (coverage.length === 0) {
    // A bill with no coverage rows predates the coverage write: reconcile
    // the whole scope exactly as before, failing closed on any drift.
    const groups = await payrollRemittanceSummary(
      orgId,
      { from: locked.from, to: locked.to },
      undefined,
      executor,
    );
    const group = groups.find(
      (candidate) =>
        candidate.partyId === locked.party_id &&
        candidate.filingAccount.id === (locked.filing_account_id ?? null),
    );
    if (!group) {
      throw new PayrollError(
        "payroll remittance source is no longer committed; regenerate this bill",
      );
    }
    // An entity-stamped bill reconciles against its own slice (native units);
    // a legacy bill with no entity marker reconciles against the consolidated
    // group exactly as before.
    const expected = locked.subsidiary_id
      ? (group.slices.find((slice) => slice.subsidiaryId === locked.subsidiary_id)?.total ?? null)
      : group.total;
    if (expected == null || cmp(expected, locked.total) !== 0) {
      throw new PayrollError(
        "payroll remittance bill no longer matches committed payroll; regenerate this bill",
      );
    }
    return;
  }

  // Every line this bill consumed must still be a committed accrual with the
  // same amount, resolving to this bill's vendor through live settings. A
  // voided or amended-away line is gone; a settings-moved line resolves
  // elsewhere; both refuse naming the bill and the remedy. Scope growth
  // (accruals committed after the bill) is invisible here by construction:
  // uncovered lines are simply not the bill's.
  const live = await executor.execute<{
    line_id: string;
    kind: "deduction" | "employer_contribution" | "credit";
    amount: string;
    snapshot_party_id: string | null;
    component_party_id: string | null;
    covered_party_id: string | null;
    system_key: string | null;
    country: string | null;
    province: string;
  }>(
    sql`
    select l.id::text as line_id, l.kind, l.amount::text as amount,
           l.remittance_party_id::text as snapshot_party_id,
           c.remittance_party_id::text as component_party_id,
           (select cover_bill.party_id::text
              from payroll_remittance_coverage cov
              join documents cover_bill
                on cover_bill.id = cov.bill_document_id and cover_bill.org_id = cov.org_id
               and cover_bill.status <> 'voided'
             where cov.org_id = l.org_id and cov.stub_line_id = l.id
             order by cover_bill.created_at desc, cover_bill.id desc
             limit 1) as covered_party_id,
           c.system_key, c.country, s.province
      from pay_stub_lines l
      join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id and r.run_status = 'committed'
      join pay_components c on c.id = l.component_id and c.org_id = l.org_id
     where l.org_id = ${orgId}
       and l.id = any(${`{${coverage.map((row) => row.stub_line_id).join(",")}}`}::uuid[])
  `,
    "objects",
  );
  const liveById = new Map(
    live.map((row) => [
      row.line_id,
      {
        snapshotPartyId: row.snapshot_party_id,
        componentPartyId: row.component_party_id,
        coveredPartyId: row.covered_party_id,
        systemKey: row.system_key,
        country: row.country,
        province: row.province,
      } satisfies RemittanceResolvableRow,
    ]),
  );
  const liveAmounts = new Map(live.map((row) => [row.line_id, row.amount]));
  const liveKinds = new Map(live.map((row) => [row.line_id, row.kind]));
  const resolution = makeRemittanceDestinationResolver(await rawPayrollSettings(orgId, executor));
  let gone = 0;
  let changed = 0;
  for (const covered of coverage) {
    const row = liveById.get(covered.stub_line_id);
    if (
      !row ||
      resolution.isInternalAccrual(row) ||
      resolution.resolveDestination(row).partyId !== locked.party_id
    ) {
      gone += 1;
    } else if (cmp(liveAmounts.get(covered.stub_line_id)!, covered.amount) !== 0) {
      changed += 1;
    }
  }
  const stale = (count: number, what: string): string =>
    `${count} of its ${coverage.length} covered ${count === 1 ? "line has" : "lines have"} ${what}`;
  if (gone > 0 || changed > 0) {
    const causes = [
      gone > 0
        ? stale(
            gone,
            "left committed payroll (voided, amended away, or re-pointed to another vendor)",
          )
        : null,
      changed > 0 ? stale(changed, "a different amount than the bill consumed") : null,
    ].filter((cause): cause is string => cause !== null);
    throw new PayrollError(
      `payroll remittance bill ${billName} no longer matches its committed source: ` +
        `${causes.join("; ")}; void this draft and raise a fresh bill`,
    );
  }
  // Receipt: the bill's own total must equal its verified coverage, so a
  // hand-edited bill total cannot post against a stale-but-live source.
  if (
    cmp(
      sum(
        coverage.map((row) =>
          liveKinds.get(row.stub_line_id) === "credit" ? neg(row.amount) : row.amount,
        ),
      ),
      locked.total,
    ) !== 0
  ) {
    throw new PayrollError(
      `payroll remittance bill ${billName} no longer matches its committed source: ` +
        `its total differs from the lines it consumed; void this draft and raise a fresh bill`,
    );
  }
}

export class RemittanceSourceIntegrityError extends Error {}

/**
 * Caller holds the document revision lock. A remittance bill is generated
 * from its source entity whole: its lines (one per consumed accrual, named
 * for component and period) AND its header currency and subsidiary are
 * stamped at creation. Changing any of the three breaks the receipt the
 * posting check reconciles, so each refuses by name — even a header-only
 * save that leaves the lines alone. Other header edits (memo, dates,
 * dimensions) proceed normally.
 * Returns true for remittance bills (whose stored lines the editor must
 * keep), false for every other document.
 */
export async function assertRemittanceBillEdit(
  tx: RemittanceExecutor,
  orgId: string,
  id: string,
  preparedLines: unknown[] | null,
  patch?: { currency?: string | undefined; subsidiaryId?: string | null | undefined },
): Promise<boolean> {
  const bill = (
    await tx.execute<{
      document_number: string | null;
      currency: string;
      subsidiary_id: string | null;
    }>(
      sql`
    select document_number, currency, subsidiary_id::text as subsidiary_id
      from documents
     where org_id = ${orgId} and id = ${id}
       and kind = 'vendor_bill' and custom ? 'payrollRemittance'
  `,
      "objects",
    )
  )[0];
  if (!bill) return false;
  const name = `remittance bill ${bill.document_number ?? "unnumbered"}`;
  const remedy = "void or delete this draft and raise a fresh bill from Payroll → Remittances";
  // Currency and subsidiary are frozen to the stamped values: the bill posts
  // in its source entity's books and currency, and a header-only save must
  // not move it into another entity or currency behind the same coverage.
  if (patch?.currency !== undefined && patch.currency !== bill.currency) {
    throw new RemittanceSourceIntegrityError(
      `${name} is stamped in ${bill.currency} — its currency cannot be changed to ${patch.currency}; ${remedy}`,
    );
  }
  if (patch?.subsidiaryId !== undefined && patch.subsidiaryId !== bill.subsidiary_id) {
    throw new RemittanceSourceIntegrityError(
      `${name} belongs to its source entity — its subsidiary cannot be changed; ${remedy}`,
    );
  }
  if (preparedLines === null) return true;
  throw new RemittanceSourceIntegrityError(
    `${name} is generated from its payroll source — ` + `its lines cannot be edited; ${remedy}`,
  );
}

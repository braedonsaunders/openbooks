import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { toUnits, fromUnits } from "../money/money.ts";
import type { MigrationSource, SourceOpenItem } from "./source.ts";
import { verifyAccountMonths, verifyProjectAccountMonths } from "./verification.ts";
import type { SourceLedgerVerification, SyncResult } from "./sync-result.ts";

export function syncErrorMessage(error: unknown, limit = 300): string {
  const messages: string[] = [];
  let current: unknown = error;
  while (current instanceof Error && messages.length < 4) {
    const message = current.message.trim().split("\n", 1)[0] ?? "";
    if (message && !messages.includes(message)) messages.push(message);
    current = (current as Error & { cause?: unknown }).cause;
  }
  return (
    messages.length > 1
      ? [...messages].reverse().join(" — wrapped by: ")
      : messages[0] || String(error)
  ).slice(0, limit);
}

/**
 * Whether the only verification failures are ledger comparisons with the
 * source (trial balance, open items, account-month and project buckets),
 * which a source transaction entered while the run was in flight can explain.
 */
export function onlyLedgerComparisonsDiffer(result: SyncResult): boolean {
  return (
    syncVerificationFailures({
      ...result,
      tb: { ...result.tb, accounts: result.tb.matches },
      openItems: null,
      periods: { ...result.periods, checked: result.periods.matches },
      projectPeriods: null,
    }).length === 0
  );
}

export function syncVerificationFailures(result: SyncResult): string[] {
  const failures: string[] = [];
  if (result.docsFailed > 0) failures.push(`${result.docsFailed} transaction writes failed`);
  if (result.sourceUnbuildable > 0)
    failures.push(`${result.sourceUnbuildable} source transactions were unbuildable`);
  if (result.deletedAtSource.length > 0)
    failures.push(`${result.deletedAtSource.length} source deletions need resolution`);
  if ((result.attachments?.failures ?? 0) > 0)
    failures.push(`${result.attachments!.failures} attachments failed to import`);
  const projectInputs = result.projectFinancials;
  if (
    projectInputs &&
    (projectInputs.targetOnlyTimeEntries > 0 || projectInputs.targetOnlyProjects > 0)
  ) {
    failures.push(
      `project input replication differs: ${projectInputs.targetOnlyTimeEntries} target-only time entries; ${projectInputs.targetOnlyProjects} target-only projects; review source deletions without removing posted history`,
    );
  }
  const orphanAssetHistory = result.operationalRecords?.fixedAssets?.orphanHistoryRows ?? 0;
  if (orphanAssetHistory > 0)
    failures.push(`${orphanAssetHistory} fixed-asset history rows have no source asset`);
  const assetMismatches = result.operationalRecords?.fixedAssets?.mismatches ?? [];
  if (assetMismatches.length)
    failures.push(`fixed-asset replication differs: ${assetMismatches.join("; ")}`);
  const crm = result.operationalRecords?.crm;
  if (crm && (crm.missingParties > 0 || crm.warnings.length > 0)) {
    failures.push(
      `CRM replication is incomplete: ${crm.missingParties} missing parties; ${crm.warnings.slice(0, 5).join("; ")}`,
    );
  }
  const tbOff = result.tb.accounts - result.tb.matches;
  if (tbOff > 0) failures.push(`${tbOff} trial-balance accounts differ`);
  const openOff = result.openItems ? result.openItems.checked - result.openItems.matches : 0;
  if (openOff > 0) failures.push(`${openOff} open items differ`);
  // Unmatched or unallocated settlement links must fail financial verification.
  if (result.applications) {
    if (result.applications.skippedNoLine > 0) {
      failures.push(
        `${result.applications.skippedNoLine} settlement links could not be matched to open items`,
      );
    }
    if (toUnits(result.applications.unallocated) !== 0n) {
      failures.push(
        `unallocated settlement amount ${result.applications.unallocated} could not be applied`,
      );
    }
  }
  const periodOff = result.periods.checked - result.periods.matches;
  if (periodOff > 0) failures.push(`${periodOff} account-month buckets differ`);
  const projectPeriodOff = result.projectPeriods
    ? result.projectPeriods.checked - result.projectPeriods.matches
    : 0;
  if (projectPeriodOff > 0) {
    failures.push(`${projectPeriodOff} project-account-month buckets differ`);
  }
  const targetedOff = result.targetedDocuments
    ? result.targetedDocuments.checked - result.targetedDocuments.matches
    : 0;
  if (targetedOff > 0) {
    failures.push(`${targetedOff} targeted source documents differ`);
  }
  return failures;
}

export function verifyTargetedDocumentKeys(
  expected: readonly { sourceRef: string; canonicalKey: string }[],
  actual: ReadonlyMap<string, string>,
): NonNullable<SyncResult["targetedDocuments"]> {
  const mismatches: NonNullable<SyncResult["targetedDocuments"]>["mismatches"] = [];
  let matches = 0;
  for (const document of expected) {
    const stored = actual.get(document.sourceRef);
    if (stored == null) {
      mismatches.push({
        sourceRef: document.sourceRef,
        reason: "missing_target",
      });
    } else if (stored !== document.canonicalKey) {
      mismatches.push({
        sourceRef: document.sourceRef,
        reason: "canonical_content",
      });
    } else {
      matches++;
    }
  }
  return {
    checked: expected.length,
    matches,
    mismatches: mismatches.slice(0, 200),
  };
}

/** Refreshes exact posting periods before constructing context for a bounded repair. */
export function needsStandalonePeriodRefresh(
  sourceRefs: readonly string[] | null,
  loadEntitiesFirst: boolean,
): boolean {
  return sourceRefs !== null && sourceRefs.length > 0 && !loadEntitiesFirst;
}

/** Refuses duplicate live connections that would share source identities and master data. */
export async function assertNoSiblingConnection(
  orgId: string,
  connectionId: string,
  sourceName: string,
): Promise<void> {
  const siblings = await db.execute<{ id: string; display_name: string }>(
    sql`
    select id, display_name from connections
     where org_id = ${orgId} and source = ${sourceName} and id <> ${connectionId}
     order by display_name`,
    "objects",
  );
  if (siblings.length > 0) {
    const names = siblings.map((row) => row.display_name).join(", ");
    throw new Error(
      `organization has another ${sourceName} connection (${names}); document identity is namespaced per source, so two live connections would merge charts and cross-update each other's documents — remove the duplicate connection (or mirror each source system into its own organization) and re-run`,
    );
  }
}

export function sourceDeletionCandidates(
  fullSweep: boolean,
  existingRefs: Iterable<string>,
  currentSourceRefs: Iterable<string>,
  tombstones: Iterable<string>,
): string[] {
  const existing = new Set(existingRefs);
  const deleted = new Set([...tombstones].filter((ref) => existing.has(ref)));
  if (fullSweep) {
    const current = new Set(currentSourceRefs);
    for (const ref of existing) if (!current.has(ref)) deleted.add(ref);
  }
  return [...deleted].sort();
}

export function unresolvedSourceDeletionCandidates(
  candidates: Iterable<string>,
  resolvedRefs: Iterable<string>,
): string[] {
  const resolved = new Set(resolvedRefs);
  return [...new Set(candidates)].filter((ref) => !resolved.has(ref)).sort();
}

/** Document kinds included in per-document source open-item verification. */
export const OPEN_ITEM_DOCUMENT_KINDS = [
  "customer_invoice",
  "vendor_bill",
  "expense_report",
  "customer_credit",
  "vendor_credit",
] as const;

export function verifyOpenItems(
  truth: readonly SourceOpenItem[],
  target: readonly SourceOpenItem[],
): NonNullable<SyncResult["openItems"]> {
  // Sum duplicate refs so doubled target balances cannot pass through row-order selection.
  const mineByRef = new Map<string, bigint>();
  for (const row of target) {
    mineByRef.set(row.ref, (mineByRef.get(row.ref) ?? 0n) + toUnits(row.unpaid));
  }
  const truthRefs = new Set(truth.map((item) => item.ref));
  const mismatches: NonNullable<SyncResult["openItems"]>["mismatches"] = [];
  let matches = 0;
  for (const item of truth) {
    const want = toUnits(item.unpaid);
    const wantAbs = want < 0n ? -want : want;
    const got = mineByRef.get(item.ref);
    if (got === undefined) {
      mismatches.push({
        ref: item.ref,
        ours: "missing",
        theirs: fromUnits(wantAbs),
      });
    } else if (got === wantAbs) {
      matches++;
    } else {
      mismatches.push({
        ref: item.ref,
        ours: fromUnits(got),
        theirs: fromUnits(wantAbs),
      });
    }
  }
  for (const row of target) {
    if (truthRefs.has(row.ref)) continue;
    const got = toUnits(row.unpaid);
    if (got === 0n) continue;
    mismatches.push({
      ref: row.ref,
      ours: fromUnits(got),
      theirs: "not_in_source",
    });
  }
  return {
    checked: matches + mismatches.length,
    matches,
    mismatches: mismatches.slice(0, 50),
  };
}

/** Compares the materialized ledger with the connector-owned source projection. */
export async function verifyCurrentLedgerState(
  source: MigrationSource,
  orgId: string,
): Promise<SourceLedgerVerification> {
  const refKey = source.refKey;
  // Verify connector-owned entries and explicit connector true-ups, excluding native postings on mapped accounts.
  const sourceProjection = sql`(
    exists (
      select 1
        from documents source_document
       where source_document.id = e.source_document_id
         and source_document.org_id = e.org_id
         and source_document.custom->>${refKey} is not null
    )
    or (
      e.custom->'sourceProjection'->>'kind' = 'connector_trueup'
      and e.custom->'sourceProjection'->>'sourceName' = ${source.name}
      and e.custom->'sourceProjection'->>'refKey' = ${refKey}
    )
  )`;
  const theirs = await source.trialBalance();
  const ours = await db.execute<{ ref: string; bal: string }>(
    sql`
    select a.custom->>${refKey} as ref, sum(l.amount) as bal
      from journal_lines l
      join journal_entries e
        on e.id = l.entry_id and e.org_id = l.org_id
      join accounts a
        on a.id = l.account_id and a.org_id = l.org_id
     where l.org_id = ${orgId}
       and e.status in ('posted', 'reversed')
       and ${sourceProjection}
       and a.custom->>${refKey} is not null
     group by 1
  `,
    "objects",
  );
  const oursByRef = new Map(ours.map((row) => [row.ref, toUnits(row.bal)]));
  const theirsByRef = new Map(theirs.map((row) => [row.accountRef, toUnits(row.balance)]));
  const tbMismatches: SyncResult["tb"]["mismatches"] = [];
  let tbMatches = 0;
  const trialBalanceRefs = new Set([...oursByRef.keys(), ...theirsByRef.keys()]);
  for (const accountRef of trialBalanceRefs) {
    const mine = oursByRef.get(accountRef) ?? 0n;
    const sourceBalance = theirsByRef.get(accountRef) ?? 0n;
    if (mine === sourceBalance) tbMatches++;
    else {
      tbMismatches.push({
        accountRef,
        ours: fromUnits(mine),
        theirs: fromUnits(sourceBalance),
      });
    }
  }

  let openItems: SyncResult["openItems"] = null;
  if (source.openItems) {
    const truth = await source.openItems();
    // Compare commercial AR/AP documents; settlements, journals, and transfers use applications and trial balance.
    const mine = await db.execute<SourceOpenItem>(
      sql`
      select custom->>${refKey} as ref, coalesce(open_balance, 0) as unpaid
        from documents
       where org_id = ${orgId} and custom->>${refKey} is not null
         and kind in (${sql.join(
           OPEN_ITEM_DOCUMENT_KINDS.map((kind) => sql`${kind}`),
           sql`, `,
         )})
    `,
      "objects",
    );
    openItems = verifyOpenItems(truth, mine);
  }

  const periodTruth = await source.monthlyActivity();
  const periodMine = await db.execute<{
    accountRef: string;
    periodRef: string | null;
    month: string;
    amount: string;
  }>(
    sql`
    select a.custom->>${refKey} as "accountRef",
           ap.custom->>${refKey} as "periodRef",
           to_char(e.posting_date, 'YYYY-MM') as month,
           sum(l.amount) as amount
      from journal_lines l
      join journal_entries e
        on e.id = l.entry_id and e.org_id = l.org_id
      join accounting_periods ap
        on ap.id = e.period_id and ap.org_id = e.org_id
      join accounts a
        on a.id = l.account_id and a.org_id = l.org_id
     where l.org_id = ${orgId}
       and e.status in ('posted', 'reversed')
       and ${sourceProjection}
       and a.custom->>${refKey} is not null
       -- Opening-balance journals are point-in-time, not monthly activity:
       -- the period comparator checks target-only buckets, so counting them
       -- here would hold every opening balance against its posting month.
       and coalesce(e.custom->'sourceProjection'->>'openingBalance', 'false') <> 'true'
     group by 1, 2, 3
    having sum(l.amount) <> 0
  `,
    "objects",
  );
  const periods = verifyAccountMonths(periodTruth, periodMine);

  let projectPeriods: SyncResult["projectPeriods"] = null;
  if (source.projectMonthlyActivity) {
    const projectTruth = await source.projectMonthlyActivity();
    const projectMine = await db.execute<{
      projectRef: string;
      accountRef: string;
      periodRef: string | null;
      month: string;
      amount: string;
    }>(
      sql`
      select p.custom->>${refKey} as "projectRef",
             a.custom->>${refKey} as "accountRef",
             ap.custom->>${refKey} as "periodRef",
             to_char(e.posting_date, 'YYYY-MM') as month,
             sum(l.amount) as amount
        from journal_lines l
        join journal_entries e
          on e.id = l.entry_id and e.org_id = l.org_id
        join accounting_periods ap
          on ap.id = e.period_id and ap.org_id = e.org_id
        join projects p
          on p.id = l.project_id and p.org_id = l.org_id
        join accounts a
          on a.id = l.account_id and a.org_id = l.org_id
       where l.org_id = ${orgId}
         and e.status in ('posted', 'reversed')
         and ${sourceProjection}
         and p.custom->>${refKey} is not null
         and a.custom->>${refKey} is not null
       group by 1, 2, 3, 4
      having sum(l.amount) <> 0
    `,
      "objects",
    );
    projectPeriods = verifyProjectAccountMonths(projectTruth, projectMine);
  }

  return {
    tb: {
      accounts: trialBalanceRefs.size,
      matches: tbMatches,
      mismatches: tbMismatches.slice(0, 50),
    },
    openItems,
    periods,
    projectPeriods,
  };
}

export class SyncVerificationError extends Error {
  constructor(readonly result: SyncResult) {
    const samples = result.skipped.slice(0, 3);
    super(
      `financial verification failed: ${syncVerificationFailures(result).join("; ")}${
        samples.length > 0 ? `; samples: ${samples.join(" | ")}` : ""
      }`,
    );
    this.name = "SyncVerificationError";
  }
}

import { desc, eq, sql } from "drizzle-orm";
import { db, schema, withOrg } from "../db.ts";
import { toUnits, fromUnits, normalizeDecimal } from "../money.ts";
import {
  postDocument,
  regenerateGlImpactTx,
  runPostDocumentEffects,
  type PostingDeps,
} from "../posting.ts";
import {
  buildNativeContext,
  type NativeContext,
  type NativeDocLine,
  type NativeDocument,
  type SyncProgress,
} from "./native.ts";
import {
  loadEntities,
  syncSourceAccountingPeriods,
  syncSourceTransactionReferenceEntities,
  type EntityLoadStats,
} from "./migrate.ts";
import {
  reconcileApplications,
  recomputeOpenBalances,
  type ApplyStats,
} from "./applications.ts";
import { trueUpResidualGl, type TrueUpStats } from "./trueup.ts";
import { mirrorSourceDeletion } from "./source-deletions.ts";
import type { MigrationSource, SourceOpenItem } from "./source.ts";
import {
  verifyAccountMonths,
  type AccountMonthVerification,
  verifyProjectAccountMonths,
  type ProjectAccountMonthVerification,
} from "./verification.ts";
import {
  captureTransactionAuditSnapshot,
  recordTransactionAudit,
} from "../transaction-audit.ts";
import {
  computeImportedLineTaxEvidence,
  loadTaxComponentConfig,
  persistLineTaxComponents,
} from "../tax-persist.ts";
import type { ComputedTaxComponent } from "../tax.ts";

/**
 * NATIVE sync engine — migration and mirror are one code path.
 *
 * Every source transaction lands as a REAL business document (invoice, bill,
 * payment, journal, order) and posts through the actual posting engine
 * (postDocument → RULES → kernel), so the GL is a byproduct of native
 * transactions. Payment applications reconcile alongside, so AR/AP open
 * balances are correct and tied payment-to-bill. Then we verify: per-account
 * trial balance AND per-document open items against the LIVE source.
 *
 *  - new source txn      → insert document + lines, post through the kernel
 *  - changed source txn  → amend in place (document updated, GL projection
 *    re-materialized via regenerateGlImpactTx — entry keeps its identity so
 *    applications and bank matches stay linked)
 *  - unchanged           → skip (canonical content compare)
 *  - deleted at source   → mirrored: removed through the engine's guarded
 *    delete (settlements released, immutable audit tombstone) — the source
 *    stays the system of record; only controller-dispositioned refs are kept
 */

export interface SyncResult {
  runId: string;
  kind: "incremental" | "full_migration" | "targeted_repair";
  entities?: EntityLoadStats;
  docsNew: number;
  docsAmended: number;
  docsUnchanged: number;
  ordersNew: number;
  docsFailed: number;
  sourceUnbuildable: number;
  skipped: string[];
  /** Still unresolved after auto-mirroring (kept by controller disposition or
   * a deletion that could not be mirrored — these fail verification). */
  deletedAtSource: string[];
  /** Source deletions mirrored automatically this run (guarded delete). */
  autoResolvedDeletions: string[];
  applications: ApplyStats | null;
  trueUp: TrueUpStats | null;
  tb: {
    accounts: number;
    matches: number;
    mismatches: { accountRef: string; ours: string; theirs: string }[];
  };
  openItems: {
    checked: number;
    matches: number;
    mismatches: { ref: string; ours: string; theirs: string }[];
  } | null;
  /** Mandatory month-bucketed activity gate (catches date-allocation drift). */
  periods: AccountMonthVerification;
  /**
   * Mandatory when the connector exposes project/job ledger dimensions.
   * Verifies every project, posting account, and month exactly.
   */
  projectPeriods: ProjectAccountMonthVerification | null;
  /**
   * Present for a bounded repair. This is the authoritative gate for that
   * operation: every requested buildable source document must have the exact
   * canonical content stored after the write. A bounded repair intentionally
   * does not claim that unrelated live ledger rows were globally reconciled.
   */
  targetedDocuments?: {
    checked: number;
    matches: number;
    mismatches: {
      sourceRef: string;
      reason: "missing_target" | "canonical_content";
    }[];
  } | null;
  syncedThrough: string;
  durationMs: number;
}

export interface SourceLedgerVerification {
  tb: SyncResult["tb"];
  openItems: SyncResult["openItems"];
  periods: SyncResult["periods"];
  projectPeriods: SyncResult["projectPeriods"];
}

export interface SyncOptions {
  kind?: "incremental" | "full_migration" | "targeted_repair";
  orgId?: string;
  connectionId?: string;
  /** "auto" resumes from the watermark; null = all history; Date = explicit. */
  since?: Date | null | "auto";
  loadEntitiesFirst?: boolean;
  /**
   * Explicit bounded source transaction population. Requires the adapter's
   * nativeChangesByRefs capability and never advances the mirror cursor.
   */
  sourceRefs?: string[];
}

export function syncVerificationFailures(result: SyncResult): string[] {
  const failures: string[] = [];
  if (result.docsFailed > 0)
    failures.push(`${result.docsFailed} transaction writes failed`);
  if (result.sourceUnbuildable > 0)
    failures.push(
      `${result.sourceUnbuildable} source transactions were unbuildable`,
    );
  if (result.deletedAtSource.length > 0)
    failures.push(
      `${result.deletedAtSource.length} source deletions need resolution`,
    );
  const tbOff = result.tb.accounts - result.tb.matches;
  if (tbOff > 0) failures.push(`${tbOff} trial-balance accounts differ`);
  const openOff = result.openItems
    ? result.openItems.checked - result.openItems.matches
    : 0;
  if (openOff > 0) failures.push(`${openOff} open items differ`);
  const periodOff = result.periods.checked - result.periods.matches;
  if (periodOff > 0) failures.push(`${periodOff} account-month buckets differ`);
  const projectPeriodOff = result.projectPeriods
    ? result.projectPeriods.checked - result.projectPeriods.matches
    : 0;
  if (projectPeriodOff > 0) {
    failures.push(
      `${projectPeriodOff} project-account-month buckets differ`,
    );
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
  const mismatches: NonNullable<
    SyncResult["targetedDocuments"]
  >["mismatches"] = [];
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

/**
 * A bounded repair deliberately avoids high-volume master-data streams, but
 * exact posting-period identity is a mandatory transaction dependency. Refresh
 * the source's small period catalog before constructing the native context.
 */
export function needsStandalonePeriodRefresh(
  sourceRefs: readonly string[] | null,
  loadEntitiesFirst: boolean,
): boolean {
  return sourceRefs !== null && sourceRefs.length > 0 && !loadEntitiesFirst;
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

/** Compare every source AR/AP balance exactly, including closed zero-balance
 * documents. The target query must return a row for every imported source
 * document; a genuinely absent document remains a mismatch even when the
 * source balance is zero. */
export function verifyOpenItems(
  truth: readonly SourceOpenItem[],
  target: readonly SourceOpenItem[],
): NonNullable<SyncResult["openItems"]> {
  const mineByRef = new Map(
    target.map((row) => [row.ref, toUnits(row.unpaid)]),
  );
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
  return {
    checked: matches + mismatches.length,
    matches,
    mismatches: mismatches.slice(0, 50),
  };
}

/**
 * Read-only comparison of the currently materialized OpenBooks ledger against
 * an adapter's authoritative source ledger. Full sync, mirror, and preflight
 * all use this one implementation so the UI cannot certify a weaker contract
 * than the write path enforces.
 */
export async function verifyCurrentLedgerState(
  source: MigrationSource,
  orgId: string,
): Promise<SourceLedgerVerification> {
  const refKey = source.refKey;
  const theirs = await source.trialBalance();
  const ours = (await db.execute(sql`
    select a.custom->>${refKey} as ref, sum(l.amount) as bal
      from journal_lines l
      join journal_entries e
        on e.id = l.entry_id and e.org_id = l.org_id
      join accounts a
        on a.id = l.account_id and a.org_id = l.org_id
     where l.org_id = ${orgId}
       and e.status in ('posted', 'reversed')
       and a.custom->>${refKey} is not null
     group by 1
  `)) as unknown as { rows: { ref: string; bal: string }[] };
  const oursByRef = new Map(ours.rows.map((row) => [row.ref, toUnits(row.bal)]));
  const theirsByRef = new Map(
    theirs.map((row) => [row.accountRef, toUnits(row.balance)]),
  );
  const tbMismatches: SyncResult["tb"]["mismatches"] = [];
  let tbMatches = 0;
  const trialBalanceRefs = new Set([
    ...oursByRef.keys(),
    ...theirsByRef.keys(),
  ]);
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
    const mine = (await db.execute(sql`
      select custom->>${refKey} as ref, coalesce(open_balance, 0) as unpaid
        from documents
       where org_id = ${orgId} and custom->>${refKey} is not null
    `)) as unknown as { rows: SourceOpenItem[] };
    openItems = verifyOpenItems(truth, mine.rows);
  }

  const periodTruth = await source.monthlyActivity();
  const periodMine = (await db.execute(sql`
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
       and a.custom->>${refKey} is not null
     group by 1, 2, 3
  `)) as unknown as {
    rows: {
      accountRef: string;
      periodRef: string | null;
      month: string;
      amount: string;
    }[];
  };
  const periods = verifyAccountMonths(periodTruth, periodMine.rows);

  let projectPeriods: SyncResult["projectPeriods"] = null;
  if (source.projectMonthlyActivity) {
    const projectTruth = await source.projectMonthlyActivity();
    const projectMine = (await db.execute(sql`
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
         and p.custom->>${refKey} is not null
         and a.custom->>${refKey} is not null
       group by 1, 2, 3, 4
    `)) as unknown as {
      rows: {
        projectRef: string;
        accountRef: string;
        periodRef: string | null;
        month: string;
        amount: string;
      }[];
    };
    projectPeriods = verifyProjectAccountMonths(
      projectTruth,
      projectMine.rows,
    );
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

class SyncVerificationError extends Error {
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

/** One-click migration: master data, then every native transaction, verified. */
export function runFullMigration(
  source: MigrationSource,
  triggeredBy: string,
  ctxOpts: { orgId?: string; connectionId?: string } = {},
): Promise<SyncResult> {
  return runSync(source, triggeredBy, {
    kind: "full_migration",
    since: null,
    loadEntitiesFirst: true,
    ...ctxOpts,
  });
}

/** Governed source-exact rematerialization of a bounded transaction set. */
export function runTargetedRepair(
  source: MigrationSource,
  sourceRefs: string[],
  triggeredBy: string,
  ctxOpts: { orgId?: string; connectionId?: string } = {},
): Promise<SyncResult> {
  const refs = [...new Set(sourceRefs.map(String))];
  if (refs.length === 0) {
    throw new Error("targeted repair requires at least one source reference");
  }
  if (refs.length > 500) {
    throw new Error("targeted repair is limited to 500 source references");
  }
  return runSync(source, triggeredBy, {
    kind: "targeted_repair",
    sourceRefs: refs,
    loadEntitiesFirst: false,
    ...ctxOpts,
  });
}

/** Effective posting subsidiary for a line that inherits from its document. */
export function effectiveLineSubsidiary(
  lineSubsidiaryId: string | null | undefined,
  documentSubsidiaryId: string | null | undefined,
): string | null {
  return lineSubsidiaryId ?? documentSubsidiaryId ?? null;
}

/** A zero tax amount carries no tax-code identity in a rate-keyed import. */
export function effectiveTaxCodeId(
  taxAmount: string,
  taxCodeId: string | null | undefined,
): string | null {
  return toUnits(taxAmount) === 0n ? null : (taxCodeId ?? null);
}

/** A posted mirror cannot silently become non-posting without a reversal. */
export function requiresControlledPostingReversal(
  sourcePosting: boolean,
  storedPosted: boolean,
): boolean {
  return storedPosted && !sourcePosting;
}

/** Canonical content key of a native document (change detection). */
export function canonicalNativeDocumentKey(d: NativeDocument): string {
  return JSON.stringify([
    d.kind,
    d.posting,
    d.posting ? null : (d.lifecycleStatus ?? "approved"),
    d.partyId,
    d.subsidiaryId,
    d.documentDate,
    d.postingDate ?? d.documentDate,
    d.postingPeriodId ?? null,
    d.dueDate,
    d.currency,
    normalizeDecimal(d.fxRate ?? "1", 8),
    d.posting ? null : toUnits(d.subtotal ?? "0").toString(),
    d.posting ? null : toUnits(d.total ?? "0").toString(),
    d.memo,
    d.referenceNumber,
    d.controlAccountId,
    d.extraDims ?? {},
    d.lines.map((l) => [
      l.lineNumber,
      l.sourceLineRef ?? null,
      l.accountId,
      l.itemId,
      normalizeDecimal(l.quantity ?? "1", 8),
      l.unit ?? null,
      normalizeDecimal(l.unitPrice ?? l.amount, 8),
      toUnits(l.amount).toString(),
      toUnits(l.taxAmount).toString(),
      l.taxOverridden,
      effectiveTaxCodeId(l.taxAmount, l.taxCodeId),
      l.partyId ?? null,
      l.departmentId,
      l.projectId,
      effectiveLineSubsidiary(l.subsidiaryId, d.subsidiaryId),
      l.extraDims ?? {},
      l.description,
      l.isBillable ?? false,
      l.markupPercent == null
        ? null
        : normalizeDecimal(l.markupPercent, 4),
      l.billAmount == null
        ? null
        : toUnits(l.billAmount).toString(),
    ]),
  ]);
}

/** Human-facing source number, kept separate from the immutable sourceRef. */
export function effectiveSourceDocumentNumber(d: NativeDocument): string {
  return d.documentNumber?.trim() || d.sourceRef;
}

/** The same canonical key computed from the stored document. */
type StoredDocumentKeyRow = {
  id: string;
  kind: string;
  party_id: string | null;
  subsidiary_id: string | null;
  document_date: string;
  posting_date: string | null;
  posting_period_id: string | null;
  due: string | null;
  memo: string | null;
  reference_number: string | null;
  ctrl: string | null;
  extra_dims: Record<string, string>;
  posted: boolean;
  status: string;
  currency: string;
  fx_rate: string;
  subtotal: string;
  total: string;
};
type StoredLineKeyRow = {
  document_id: string;
  line_number: number;
  source_line_ref: string | null;
  account_id: string | null;
  item_id: string | null;
  quantity: string;
  unit: string | null;
  unit_price: string;
  amount: string;
  tax_amount: string;
  tax_overridden: boolean;
  tax_code_id: string | null;
  party_id: string | null;
  department_id: string | null;
  project_id: string | null;
  subsidiary_id: string | null;
  extra_dims: Record<string, string>;
  description: string | null;
  is_billable: boolean;
  markup_percent: string | null;
  bill_amount: string | null;
};

function storedCanonicalKey(
  d: StoredDocumentKeyRow,
  lines: StoredLineKeyRow[],
): string {
  return JSON.stringify([
    d.kind,
    d.posted,
    d.posted ? null : d.status,
    d.party_id,
    d.subsidiary_id,
    d.document_date,
    d.posting_date ?? d.document_date,
    d.posting_period_id,
    d.due,
    d.currency,
    normalizeDecimal(d.fx_rate, 8),
    d.posted ? null : toUnits(d.subtotal).toString(),
    d.posted ? null : toUnits(d.total).toString(),
    d.memo,
    d.reference_number,
    d.ctrl,
    d.extra_dims ?? {},
    lines.map((l) => [
      l.line_number,
      l.source_line_ref,
      l.account_id,
      l.item_id,
      normalizeDecimal(l.quantity, 8),
      l.unit,
      normalizeDecimal(l.unit_price, 8),
      toUnits(l.amount).toString(),
      toUnits(l.tax_amount).toString(),
      l.tax_overridden,
      effectiveTaxCodeId(l.tax_amount, l.tax_code_id),
      l.party_id ?? null,
      l.department_id,
      l.project_id,
      effectiveLineSubsidiary(l.subsidiary_id, d.subsidiary_id),
      l.extra_dims ?? {},
      l.description,
      l.is_billable,
      l.markup_percent == null
        ? null
        : normalizeDecimal(l.markup_percent, 4),
      l.bill_amount == null
        ? null
        : toUnits(l.bill_amount).toString(),
    ]),
  ]);
}

async function storedKey(docId: string): Promise<string> {
  const [d] = (
    (await db.execute(sql`
      select kind, party_id, subsidiary_id,
             document_date::text, posting_date::text,
             posting_period_id,
             due_date::text as due,
             memo, reference_number, custom->>'controlAccountId' as ctrl, extra_dims, id,
             posted_entry_id is not null as posted, status, currency, fx_rate, subtotal, total
        from documents where id = ${docId}`)) as unknown as {
      rows: StoredDocumentKeyRow[];
    }
  ).rows;
  const lines = (
    (await db.execute(sql`
      select line_number, custom->>'sourceLineRef' as source_line_ref,
             account_id, item_id, quantity, unit, unit_price,
             amount, tax_amount, tax_overridden, tax_code_id,
             party_id, department_id, project_id, subsidiary_id, extra_dims, description,
             is_billable, markup_percent, bill_amount
        from document_lines where document_id = ${docId} order by line_number`)) as unknown as {
      rows: StoredLineKeyRow[];
    }
  ).rows;
  return storedCanonicalKey(d!, lines);
}

/** Full migrations compare tens of thousands of documents; load their keys in
 * two set queries instead of issuing two round trips per transaction. */
async function loadStoredKeys(
  orgId: string,
  refKey: string,
): Promise<Map<string, string>> {
  const documents = (await db.execute(sql`
    select id, kind, party_id, subsidiary_id,
           document_date::text, posting_date::text,
           posting_period_id,
           due_date::text as due,
           memo, reference_number, custom->>'controlAccountId' as ctrl, extra_dims,
           posted_entry_id is not null as posted, status, currency, fx_rate, subtotal, total
      from documents
     where org_id = ${orgId} and custom->>${refKey} is not null
     order by id`)) as unknown as { rows: StoredDocumentKeyRow[] };
  const lineResult = (await db.execute(sql`
    select dl.document_id, dl.line_number,
           dl.custom->>'sourceLineRef' as source_line_ref,
           dl.account_id, dl.item_id, dl.quantity, dl.unit, dl.unit_price,
           dl.amount, dl.tax_amount, dl.tax_overridden,
           dl.tax_code_id, dl.party_id, dl.department_id, dl.project_id, dl.subsidiary_id,
           dl.extra_dims, dl.description,
           dl.is_billable, dl.markup_percent, dl.bill_amount
      from document_lines dl
      join documents d on d.id = dl.document_id and d.org_id = dl.org_id
     where d.org_id = ${orgId} and d.custom->>${refKey} is not null
     order by dl.document_id, dl.line_number`)) as unknown as {
    rows: StoredLineKeyRow[];
  };
  const linesByDocument = new Map<string, StoredLineKeyRow[]>();
  for (const line of lineResult.rows) {
    const lines = linesByDocument.get(line.document_id);
    if (lines) lines.push(line);
    else linesByDocument.set(line.document_id, [line]);
  }
  return new Map(
    documents.rows.map((document) => [
      document.id,
      storedCanonicalKey(document, linesByDocument.get(document.id) ?? []),
    ]),
  );
}

export interface FullSyncPreflight {
  source: string;
  orgId: string;
  connectionId: string | null;
  generatedAt: string;
  sourceDocuments: number;
  targetDocuments: number;
  newDocuments: number;
  amendedDocuments: number;
  unchangedDocuments: number;
  sourceUnbuildable: number;
  nonLedgerSourceRefs: number;
  duplicateSourceRefs: string[];
  acknowledgedSourceDeletions: string[];
  actionableSourceDeletions: string[];
  ledgerContext: {
    bookRef: string;
    bookKind: string;
  } | null;
  /** Current target state versus source, before any writes are authorized. */
  financialVerification: SourceLedgerVerification;
  samples: {
    newDocuments: string[];
    amendedDocuments: string[];
    unbuildable: Array<{ ref: string; reason: string }>;
  };
}

/**
 * Read-only full-sweep plan. It pulls and normalizes the complete source
 * transaction population, compares canonical target content, and identifies
 * every source deletion before a production operator authorizes any write.
 */
export async function preflightFullSync(
  source: MigrationSource,
  opts: { orgId: string; connectionId?: string },
): Promise<FullSyncPreflight> {
  const orgRows = (await db.execute(sql`
    select id from orgs where id = ${opts.orgId}
  `)) as unknown as { rows: { id: string }[] };
  if (!orgRows.rows[0]) throw new Error(`organization ${opts.orgId} not found`);

  const ctx = await buildNativeContext(
    opts.orgId,
    source.refKey,
    source.baseCurrency,
  );
  const changes = await source.nativeChanges(null, ctx);
  const existingRows = (await db.execute(sql`
    select id, status, document_number, custom->>${source.refKey} as ref
      from documents
     where org_id = ${opts.orgId}
       and custom->>${source.refKey} is not null
  `)) as unknown as {
    rows: {
      id: string;
      status: string;
      document_number: string;
      ref: string;
    }[];
  };
  const existingByRef = new Map(
    existingRows.rows.map((row) => [row.ref, row]),
  );
  const storedKeys = await loadStoredKeys(opts.orgId, source.refKey);

  const sourceRefCounts = new Map<string, number>();
  for (const document of changes.documents) {
    sourceRefCounts.set(
      document.sourceRef,
      (sourceRefCounts.get(document.sourceRef) ?? 0) + 1,
    );
  }
  const duplicateSourceRefs = [...sourceRefCounts]
    .filter(([, count]) => count > 1)
    .map(([ref]) => ref)
    .sort();

  const newRefs: string[] = [];
  const amendedRefs: string[] = [];
  let unchangedDocuments = 0;
  for (const sourceDocument of changes.documents) {
    const document: NativeDocument = {
      ...sourceDocument,
      subsidiaryId:
        sourceDocument.subsidiaryId ?? ctx.rootSubsidiaryId,
      currency: sourceDocument.currency ?? source.baseCurrency,
    };
    const existing = existingByRef.get(document.sourceRef);
    if (!existing) {
      newRefs.push(document.sourceRef);
      continue;
    }
    if (
      existing.document_number === effectiveSourceDocumentNumber(document) &&
      canonicalNativeDocumentKey(document)
      === storedKeys.get(existing.id)
    ) {
      unchangedDocuments++;
    } else {
      amendedRefs.push(document.sourceRef);
    }
  }

  const currentSourceRefs = [
    ...changes.documents.map((document) => document.sourceRef),
    ...changes.unbuildable.map((row) => row.ref),
    ...(changes.nonLedgerRefs ?? []),
  ];
  const deletionCandidates = sourceDeletionCandidates(
    true,
    existingRows.rows
      .filter((row) => row.status !== "voided")
      .map((row) => row.ref),
    currentSourceRefs,
    changes.deletedRefs,
  );
  const acknowledgedRows =
    opts.connectionId && deletionCandidates.length > 0
      ? ((await db.execute(sql`
          select source_ref
            from source_deletion_resolutions
           where org_id = ${opts.orgId}
             and connection_id = ${opts.connectionId}
             and source_ref in ${deletionCandidates}
        `)) as unknown as { rows: { source_ref: string }[] }).rows
      : [];
  const acknowledged = new Set(
    acknowledgedRows.map((row) => row.source_ref),
  );
  const [ledgerContext, financialVerification] = await Promise.all([
    source.ledgerContext ? source.ledgerContext() : Promise.resolve(null),
    verifyCurrentLedgerState(source, opts.orgId),
  ]);

  return {
    source: source.name,
    orgId: opts.orgId,
    connectionId: opts.connectionId ?? null,
    generatedAt: new Date().toISOString(),
    sourceDocuments: changes.documents.length,
    targetDocuments: existingRows.rows.length,
    newDocuments: newRefs.length,
    amendedDocuments: amendedRefs.length,
    unchangedDocuments,
    sourceUnbuildable: changes.unbuildable.length,
    nonLedgerSourceRefs: (changes.nonLedgerRefs ?? []).length,
    duplicateSourceRefs,
    acknowledgedSourceDeletions: deletionCandidates
      .filter((ref) => acknowledged.has(ref))
      .sort(),
    actionableSourceDeletions: deletionCandidates
      .filter((ref) => !acknowledged.has(ref))
      .sort(),
    ledgerContext,
    financialVerification,
    samples: {
      newDocuments: newRefs.slice(0, 50),
      amendedDocuments: amendedRefs.slice(0, 50),
      unbuildable: changes.unbuildable.slice(0, 50),
    },
  };
}

/** Best-effort live progress write (throttled) so the platform page can show a
 *  real "pulling/posting X of Y" bar. Never fails a sync — progress is cosmetic. */
const _progressAt = new Map<string, number>();
async function setProgress(
  runId: string,
  p: SyncProgress,
  force = false,
): Promise<void> {
  const now = Date.now();
  if (!force && now - (_progressAt.get(runId) ?? 0) < 700) return;
  _progressAt.set(runId, now);
  try {
    await db.execute(
      sql`update sync_runs set progress = ${JSON.stringify(p)}::jsonb where id = ${runId}`,
    );
  } catch {
    /* progress is best-effort */
  }
}

/** Denormalize a posted document's header totals from its journal entry. */
async function setDocumentTotalsFromEntry(docId: string): Promise<void> {
  // The document total is the amount on its OPEN-ITEM (AR/AP control) leg — the
  // receivable/payable — not the sum of every positive journal line. A retainage /
  // holdback line debits an income account (a positive amount that is NOT the
  // total); summing all positives double-counts it and overstates the invoice by
  // the holdback. Fall back to the positive-side sum for docs with no open item
  // (cash sales etc.). subtotal = total − tax.
  await db.execute(sql`
    update documents d set
      total = coalesce(nullif(abs(j.oi), 0), j.pos, 0),
      tax_total = coalesce(abs(lt.tax), 0),
      subtotal = coalesce(nullif(abs(j.oi), 0), j.pos, 0) - coalesce(abs(lt.tax), 0)
    from documents d2
    left join lateral (
      select sum(jl.amount) filter (where jl.amount > 0) as pos,
             sum(jl.amount) filter (where jl.is_open_item) as oi
        from journal_lines jl where jl.entry_id = d2.posted_entry_id) j on true
    left join lateral (
      select sum(l.tax_amount) as tax from document_lines l where l.document_id = d2.id) lt on true
    where d.id = d2.id and d2.id = ${docId}
  `);
}

type SyncTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Build the immutable tax snapshots before mutating a document. */
async function importedTaxEvidence(
  orgId: string,
  documentDate: string,
  lines: NativeDocLine[],
): Promise<Map<number, ComputedTaxComponent[]>> {
  const configs = new Map<
    string,
    Awaited<ReturnType<typeof loadTaxComponentConfig>>
  >();
  for (const taxCodeId of new Set(
    lines
      .map((line) => effectiveTaxCodeId(line.taxAmount, line.taxCodeId))
      .filter((id): id is string => Boolean(id)),
  )) {
    const config = await loadTaxComponentConfig(orgId, taxCodeId, documentDate);
    if (config.length === 0)
      throw new Error(
        `tax code ${taxCodeId} has no effective calculation configuration`,
      );
    configs.set(taxCodeId, config);
  }
  const evidence = new Map<number, ComputedTaxComponent[]>();
  for (const line of lines) {
    const taxCodeId = effectiveTaxCodeId(line.taxAmount, line.taxCodeId);
    if (!taxCodeId) continue;
    evidence.set(
      line.lineNumber,
      computeImportedLineTaxEvidence(
        line.amount,
        line.taxAmount,
        configs.get(taxCodeId)!,
      ),
    );
  }
  return evidence;
}

/** Insert source lines and their tax evidence in the caller's transaction. */
async function insertImportedLines(
  tx: SyncTx,
  orgId: string,
  documentId: string,
  lines: NativeDocLine[],
  evidence: Map<number, ComputedTaxComponent[]>,
): Promise<void> {
  const inserted = await tx
    .insert(schema.documentLines)
    .values(
      lines.map((line) => ({
        orgId,
        documentId,
        lineNumber: line.lineNumber,
        accountId: line.accountId,
        itemId: line.itemId,
        quantity: line.quantity ?? "1",
        unit: line.unit ?? null,
        unitPrice: line.unitPrice ?? line.amount,
        amount: line.amount,
        taxCodeId: effectiveTaxCodeId(line.taxAmount, line.taxCodeId),
        taxAmount: line.taxAmount,
        taxOverridden: line.taxOverridden,
        partyId: line.partyId ?? null,
        departmentId: line.departmentId,
        projectId: line.projectId,
        subsidiaryId: line.subsidiaryId,
        extraDims: line.extraDims ?? {},
        description: line.description,
        isBillable: line.isBillable ?? false,
        markupPercent: line.markupPercent ?? null,
        billAmount: line.billAmount ?? null,
        // Line identity from the source system, so a migrated document can be
        // reconciled and re-synced line by line rather than only as a whole.
        custom: line.sourceLineRef ? { sourceLineRef: line.sourceLineRef } : {},
      })),
    )
    .returning({
      id: schema.documentLines.id,
      lineNumber: schema.documentLines.lineNumber,
    });
  for (const line of inserted) {
    const components = evidence.get(line.lineNumber) ?? [];
    if (components.length > 0) {
      await persistLineTaxComponents(orgId, line.id, components, null, tx);
    }
  }
}

export async function runSync(
  source: MigrationSource,
  triggeredBy: string,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const started = Date.now();
  const kind = opts.kind ?? "incremental";
  const targetedRefs = opts.sourceRefs
    ? [...new Set(opts.sourceRefs.map(String))]
    : null;
  if (kind === "targeted_repair" && !targetedRefs?.length) {
    throw new Error("targeted repair requires explicit source references");
  }
  if (targetedRefs && kind !== "targeted_repair") {
    throw new Error("sourceRefs are only valid for a targeted repair");
  }
  if (targetedRefs && !source.nativeChangesByRefs) {
    throw new Error(
      `${source.name} does not support targeted source rematerialization`,
    );
  }
  const refKey = source.refKey;
  const connectionId = opts.connectionId ?? null;
  const org = opts.orgId
    ? { id: opts.orgId }
    : (await db.select().from(schema.orgs))[0]!;

  const [run] = await db
    .insert(schema.syncRuns)
    .values({
      orgId: org.id,
      connectionId,
      source: source.name,
      kind,
      triggeredBy,
    })
    .returning();

  try {
    // -- 1. watermark (computed first so high-volume master-data streams — e.g.
    //    time entries — can pull incrementally on a mirror instead of full).
    const [lastOk] = await db
      .select()
      .from(schema.syncRuns)
      .where(
        sql`${schema.syncRuns.status} = 'ok' and ${schema.syncRuns.syncedThrough} is not null and ${
          connectionId
            ? sql`${schema.syncRuns.connectionId} = ${connectionId}`
            : sql`${schema.syncRuns.source} = ${source.name}`
        }`,
      )
      .orderBy(desc(schema.syncRuns.syncedThrough))
      .limit(1);
    const since =
      opts.since === undefined || opts.since === "auto"
        ? (lastOk?.syncedThrough ?? new Date(Date.now() - 3 * 24 * 3600 * 1000))
        : opts.since;

    // -- 2. master data, so every reference in new transactions resolves.
    //    Default ON for mirrors too: the upsert-by-ref loader is idempotent, and
    //    a new customer/account/item referenced by a new transaction must exist
    //    before the document builds.
    await setProgress(
      run!.id,
      { phase: "starting", message: "Connecting…" },
      true,
    );
    let entityStats: EntityLoadStats | undefined;
    const loadEntitiesFirst = opts.loadEntitiesFirst ?? true;
    if (needsStandalonePeriodRefresh(targetedRefs, loadEntitiesFirst)) {
      await setProgress(
        run!.id,
        {
          phase: "entities",
          message: "Refreshing source accounting periods…",
        },
        true,
      );
      const audit = {
        connectionId,
        runId: run!.id,
        actorId: /^[0-9a-f-]{36}$/i.test(triggeredBy)
          ? triggeredBy
          : null,
        sourceName: source.name,
      };
      const referenceStats =
        await syncSourceTransactionReferenceEntities(source, org.id, audit);
      const skippedReferences = Object.values(referenceStats).reduce(
        (total, stats) => total + stats.skipped,
        0,
      );
      if (skippedReferences > 0) {
        throw new Error(
          `${skippedReferences} source transaction reference records could not be loaded`,
        );
      }
      entityStats = {
        accounting_periods: await syncSourceAccountingPeriods(source, org.id),
        ...referenceStats,
      };
    }
    if (loadEntitiesFirst && source.entities) {
      await setProgress(
        run!.id,
        { phase: "entities", message: "Loading accounts, parties, items…" },
        true,
      );
      entityStats = await loadEntities(
        source,
        org.id,
        since,
        (message, current, total) => {
          void setProgress(run!.id, {
            phase: "entities",
            message,
            current,
            total,
          });
        },
        {
          connectionId,
          runId: run!.id,
          actorId: /^[0-9a-f-]{36}$/i.test(triggeredBy)
            ? triggeredBy
            : null,
          sourceName: source.name,
        },
      );
    }

    // Fresh org: derive control accounts from the source so posting rules
    // route AR/AP/bank/tax to exactly the accounts the source used.
    if (source.controlAccounts) {
      const existingCtrl = (
        (await db.execute(
          sql`select settings->'controlAccounts' as ctrl from orgs where id = ${org.id}`,
        )) as unknown as {
          rows: { ctrl: Record<string, string> | null }[];
        }
      ).rows[0]?.ctrl;
      if (!existingCtrl?.ar || !existingCtrl?.ap) {
        const refs = await source.controlAccounts();
        const resolved: Record<string, string> = { ...(existingCtrl ?? {}) };
        for (const [key, ref] of Object.entries(refs)) {
          if (!ref) continue;
          const row = (
            (await db.execute(sql`
              select id from accounts where org_id = ${org.id} and custom->>${refKey} = ${ref} limit 1`)) as unknown as {
              rows: { id: string }[];
            }
          ).rows[0];
          if (row) resolved[key] = row.id;
        }
        // Write whatever resolved (partial is fine): a source that exposes AR
        // but not AP still lets its customer documents post. Missing legs just
        // fall back to org defaults per document kind.
        if (resolved.ar || resolved.ap || resolved.bank) {
          await db.execute(sql`
            update orgs set settings = settings || ${JSON.stringify({ controlAccounts: resolved })}::jsonb
             where id = ${org.id}`);
        }
      }
    }

    const ctx: NativeContext = await buildNativeContext(
      org.id,
      refKey,
      source.baseCurrency,
    );
    // Pull-phase progress: the adapter reports "X of Y transactions" as it streams.
    ctx.onProgress = (p) => {
      void setProgress(run!.id, p);
    };
    const deps: PostingDeps = {
      control: ctx.control,
      cardLiabilityAccountId: ctx.control.ap,
      // Source replay can cross source-owned historical locks, while
      // controller-owned close locks remain authoritative.
      migration: true,
    };

    // -- 3. pull native changes -------------------------------------------------
    await setProgress(
      run!.id,
      { phase: "pull", message: "Pulling transactions…" },
      true,
    );
    const changes = targetedRefs
      ? await source.nativeChangesByRefs!(targetedRefs, ctx)
      : await source.nativeChanges(since, ctx);
    if (targetedRefs) {
      const accountedFor = new Set([
        ...changes.documents.map((document) => document.sourceRef),
        ...changes.unbuildable.map((row) => row.ref),
        ...(changes.nonLedgerRefs ?? []),
      ]);
      const absent = targetedRefs.filter((ref) => !accountedFor.has(ref));
      if (absent.length > 0) {
        throw new Error(
          `targeted source references were not returned: ${absent.join(", ")}`,
        );
      }
    }

    // -- 4. existing documents by source ref -------------------------------------
    const existing = new Map<
      string,
      {
        id: string;
        status: string;
        posted: boolean;
        documentNumber: string;
      }
    >();
    for (const r of (
      (await db.execute(sql`
        select id, status, document_number,
               posted_entry_id is not null as posted, custom->>${refKey} as ref
          from documents where org_id = ${org.id} and custom->>${refKey} is not null`)) as unknown as {
        rows: {
          id: string;
          status: string;
          document_number: string;
          posted: boolean;
          ref: string;
        }[];
      }
    ).rows) {
      existing.set(r.ref, {
        id: r.id,
        status: r.status,
        posted: r.posted,
        documentNumber: r.document_number,
      });
    }
    // Older rate-keyed order imports retained a non-zero-rate code even when
    // no source tax existed. Zero tax has no unambiguous tax identity in this
    // adapter; remove that legacy promise before canonical change detection.
    if (!targetedRefs) {
      await db.execute(sql`
        update document_lines dl set tax_code_id = null, updated_at = now()
         where dl.tax_amount = 0 and dl.tax_code_id is not null
           and not exists (
             select 1 from document_line_tax_components c where c.document_line_id = dl.id
           )
           and exists (
             select 1 from documents d where d.id = dl.document_id and d.org_id = ${org.id}
               and d.custom->>${refKey} is not null
           )`);
    }
    const fullStoredKeys =
      since === null ? await loadStoredKeys(org.id, refKey) : null;

    let docsNew = 0,
      docsAmended = 0,
      docsUnchanged = 0,
      ordersNew = 0,
      docsFailed = 0;
    const skipped: string[] = [];
    const writeFailures: string[] = [];
    for (const u of changes.unbuildable) skipped.push(`${u.ref}: ${u.reason}`);

    const totalDocs = changes.documents.length;
    let docIndex = 0;
    for (const sourceDoc of changes.documents) {
      docIndex++;
      await setProgress(run!.id, {
        phase: "post",
        message: "Posting transactions…",
        current: docIndex,
        total: totalDocs,
        docsNew,
        docsAmended,
        docsUnchanged,
        docsFailed,
        ordersNew,
        failureSamples: writeFailures,
      });
      const doc: NativeDocument = {
        ...sourceDoc,
        subsidiaryId: sourceDoc.subsidiaryId ?? ctx.rootSubsidiaryId,
        currency: sourceDoc.currency ?? source.baseCurrency,
      };
      try {
        const taxEvidence = await importedTaxEvidence(
          org.id,
          doc.documentDate,
          doc.lines,
        );
        const have = existing.get(doc.sourceRef);
        if (!have) {
          // ---- NEW: insert + post through the kernel -------------------------
          if (
            doc.posting &&
            !doc.postingPeriodId &&
            !ctx.periodFor(doc.postingDate ?? doc.documentDate)
          ) {
            docsFailed++;
            skipped.push(`${doc.sourceRef}: no period for ${doc.documentDate}`);
            continue;
          }
          // The source document, lines, tax evidence, journal, and posted flip
          // are one accounting unit. `postDocument` reuses withOrg's pinned
          // transaction, so any posting failure rolls the source insert back.
          const docId = await withOrg(org.id, async () => {
            const [row] = await db
              .insert(schema.documents)
              .values({
                orgId: org.id,
                kind: doc.kind,
                documentNumber: effectiveSourceDocumentNumber(doc),
                partyId: doc.partyId,
                subsidiaryId: doc.subsidiaryId,
                extraDims: doc.extraDims ?? {},
                documentDate: doc.documentDate,
                postingDate: doc.postingDate ?? doc.documentDate,
                postingPeriodId: doc.postingPeriodId ?? null,
                dueDate: doc.dueDate,
                currency: doc.currency ?? source.baseCurrency,
                fxRate: doc.fxRate ?? "1",
                status: "draft",
                subtotal: doc.subtotal ?? "0",
                taxTotal: "0",
                total: doc.total ?? "0",
                memo: doc.memo,
                referenceNumber: doc.referenceNumber,
                custom: doc.controlAccountId
                  ? {
                      [refKey]: doc.sourceRef,
                      controlAccountId: doc.controlAccountId,
                    }
                  : { [refKey]: doc.sourceRef },
              })
              .returning({ id: schema.documents.id });
            await insertImportedLines(
              db as unknown as SyncTx,
              org.id,
              row!.id,
              doc.lines,
              taxEvidence,
            );
            const lifecycleStatus = doc.posting
              ? "approved"
              : (doc.lifecycleStatus ?? "approved");
            await db.execute(sql`
              update documents
                 set status = ${lifecycleStatus}, updated_at = now()
               where id = ${row!.id}
            `);
            if (doc.posting) {
              await postDocument(row!.id, deps, { deferEffects: true });
              await setDocumentTotalsFromEntry(row!.id);
            }
            return row!.id;
          });
          if (doc.posting) {
            // Automation effects observe only a fully committed document.
            try {
              await runPostDocumentEffects(docId, "approved");
            } catch (effectError) {
              console.error(
                `[sync:${source.name}] post-commit effects failed for ${doc.sourceRef}:`,
                effectError,
              );
            }
            docsNew++;
          } else {
            ordersNew++;
          }
          existing.set(doc.sourceRef, {
            id: docId,
            status: doc.posting
              ? "posted"
              : (doc.lifecycleStatus ?? "approved"),
            posted: doc.posting,
            documentNumber: effectiveSourceDocumentNumber(doc),
          });
          continue;
        }

        // ---- EXISTS: heal orphan, then amend-if-changed ------------------------
        if (requiresControlledPostingReversal(doc.posting, have.posted)) {
          throw new Error(
            "source transitioned from posting to non-posting; a controlled reversal is required",
          );
        }
        if (doc.posting && !have.posted && have.status !== "voided") {
          await withOrg(org.id, async () => {
            // Old importer versions could commit the approved document before
            // posting failed. Rebuild its lines/evidence and post as one unit;
            // a repeat failure leaves the prior approved row unchanged.
            await db.execute(sql`set local openbooks.amend = on`);
            await db.execute(sql`
              update documents
                 set document_number = ${effectiveSourceDocumentNumber(doc)},
                     posting_date = ${doc.postingDate ?? doc.documentDate},
                     posting_period_id = ${doc.postingPeriodId ?? null},
                     status = 'approved',
                     updated_at = now()
               where id = ${have.id}
            `);
            await db.execute(
              sql`delete from document_lines where document_id = ${have.id}`,
            );
            await insertImportedLines(
              db as unknown as SyncTx,
              org.id,
              have.id,
              doc.lines,
              taxEvidence,
            );
            await postDocument(have.id, deps, { deferEffects: true });
            await setDocumentTotalsFromEntry(have.id);
          });
          try {
            await runPostDocumentEffects(have.id, have.status);
          } catch (effectError) {
            console.error(
              `[sync:${source.name}] post-commit effects failed for ${doc.sourceRef}:`,
              effectError,
            );
          }
          have.posted = true;
          have.status = "posted";
          have.documentNumber = effectiveSourceDocumentNumber(doc);
          docsNew++;
          continue;
        }
        const sourceDocumentNumber = effectiveSourceDocumentNumber(doc);
        const canonicalContentUnchanged =
          canonicalNativeDocumentKey(doc) ===
          (fullStoredKeys?.get(have.id) ?? (await storedKey(have.id)));
        if (canonicalContentUnchanged) {
          if (have.documentNumber === sourceDocumentNumber) {
            docsUnchanged++;
            continue;
          }
          await db.transaction(async (tx) => {
            await tx.execute(sql`set local openbooks.amend = on`);
            await tx.execute(sql`set local openbooks.migration = on`);
            const auditBefore = await captureTransactionAuditSnapshot(
              tx,
              have.id,
            );
            if (!auditBefore) {
              throw new Error(
                `document ${have.id} disappeared during source-number reconciliation`,
              );
            }
            const updated = await tx.execute(sql`
              update documents
                 set document_number = ${sourceDocumentNumber},
                     updated_at = now()
               where id = ${have.id}
                 and org_id = ${org.id}
                 and document_number = ${have.documentNumber}
              returning id
            `);
            if (updated.rows.length !== 1) {
              throw new Error(
                `document ${have.id} changed during source-number reconciliation`,
              );
            }
            const auditAfter = await captureTransactionAuditSnapshot(
              tx,
              have.id,
            );
            if (!auditAfter) {
              throw new Error(
                `document ${have.id} disappeared after source-number reconciliation`,
              );
            }
            await recordTransactionAudit(tx, {
              orgId: org.id,
              documentId: have.id,
              action: "update",
              actorId: null,
              source: "mirror",
              reason: "source_transaction_number_changed",
              before: auditBefore,
              after: auditAfter,
            });
          });
          have.documentNumber = sourceDocumentNumber;
          docsAmended++;
          continue;
        }
        // AMEND: document is the system of record; its GL projection follows.
        // `migration` flag too: a mirror amend re-materializes HISTORY — an
        // account deactivated since must not block its own past postings.
        await db.transaction(async (tx) => {
          await tx.execute(sql`set local openbooks.amend = on`);
          await tx.execute(sql`set local openbooks.migration = on`);
          const auditCandidate = await captureTransactionAuditSnapshot(
            tx,
            have.id,
          );
          const auditBefore =
            auditCandidate?.document.status === "posted"
              ? auditCandidate
              : null;
          await tx.execute(sql`
            update documents set
              kind = ${doc.kind}, party_id = ${doc.partyId}, subsidiary_id = ${doc.subsidiaryId},
              document_number = ${sourceDocumentNumber},
              document_date = ${doc.documentDate},
              posting_date = ${doc.postingDate ?? doc.documentDate},
              posting_period_id = ${doc.postingPeriodId ?? null}, due_date = ${doc.dueDate},
              currency = ${doc.currency ?? source.baseCurrency}, fx_rate = ${doc.fxRate ?? "1"},
              memo = ${doc.memo}, reference_number = ${doc.referenceNumber},
              status = case
                when posted_entry_id is not null then status
                else ${doc.lifecycleStatus ?? "approved"}
              end,
              extra_dims = ${JSON.stringify(doc.extraDims ?? {})}::jsonb,
              custom = case
                when ${doc.controlAccountId}::text is null
                  then custom - 'controlAccountId'
                else custom || ${JSON.stringify(
                  doc.controlAccountId
                    ? { controlAccountId: doc.controlAccountId }
                    : {},
                )}::jsonb
              end,
              updated_at = now()
            where id = ${have.id}`);
          await tx.execute(
            sql`delete from document_lines where document_id = ${have.id}`,
          );
          await insertImportedLines(
            tx,
            org.id,
            have.id,
            doc.lines,
            taxEvidence,
          );
          if (have.posted)
            await regenerateGlImpactTx(tx, have.id, deps, "mirror");
          // The open-balance trigger fires only on posted_entry_id/status change;
          // an amend keeps the entry identity (to preserve applications), so the
          // trigger never sees the changed open lines. Recompute explicitly from
          // the freshly regenerated journal lines (applications are preserved).
          if (have.posted)
            await tx.execute(
              sql`select recompute_document_open_balance(${have.id})`,
            );
          if (auditBefore) {
            const auditAfter = await captureTransactionAuditSnapshot(
              tx,
              have.id,
            );
            if (!auditAfter)
              throw new Error(
                `document ${have.id} disappeared during mirror amendment`,
              );
            await recordTransactionAudit(tx, {
              orgId: org.id,
              documentId: have.id,
              action: "update",
              actorId: null,
              source: "mirror",
              reason: "source_transaction_changed",
              before: auditBefore,
              after: auditAfter,
            });
          }
        });
        if (have.posted) await setDocumentTotalsFromEntry(have.id);
        have.documentNumber = sourceDocumentNumber;
        docsAmended++;
      } catch (e) {
        docsFailed++;
        const failure = `${doc.sourceRef}: ${(e as Error).message.slice(0, 300)}`;
        skipped.push(failure);
        if (writeFailures.length < 20) writeFailures.push(failure);
        await setProgress(
          run!.id,
          {
            phase: "post",
            message: "Posting transactions…",
            current: docIndex,
            total: totalDocs,
            docsNew,
            docsAmended,
            docsUnchanged,
            docsFailed,
            ordersNew,
            failureSamples: writeFailures,
          },
          true,
        );
      }
    }

    // -- 5. deletions at source: mirrored automatically ------------------------
    // The source is the system of record: a transaction deleted (or
    // cancelled) upstream must become financially absent here too — never
    // linger as a report-only divergence. Each candidate is corrected through
    // an original-period reversal and void; settlement evidence is soft-
    // unapplied, never erased, and the complete before/after is audited in the
    // same transaction. A controller-closed period stays flagged and fails
    // verification honestly.
    // On a FULL sweep the pulled set is the complete source universe, so any
    // previously-imported ref that vanished was deleted at source (our books
    // only ever contain refs the source once returned). Already-voided
    // documents are financially exact mirrors of a deletion (net-zero GL, no
    // open balance) and are not re-flagged.
    const nonVoidedExistingRefs = [...existing]
      .filter(([, have]) => have.status !== "voided")
      .map(([ref]) => ref);
    const deletedAtSource = new Set(
      sourceDeletionCandidates(
        since === null,
        nonVoidedExistingRefs,
        [
          ...changes.documents.map((doc) => doc.sourceRef),
          ...changes.unbuildable.map((row) => row.ref),
          ...(changes.nonLedgerRefs ?? []),
        ],
        changes.deletedRefs,
      ),
    );
    // A source-CANCELLED transaction that we imported while it was posted is a
    // ledger divergence: mirror it like a deletion. An already-voided document
    // is again an exact mirror (its reversal nets the GL to zero) — skip it.
    for (const u of changes.unbuildable) {
      const have = existing.get(u.ref);
      if (u.reason === "cancelled" && have?.posted && have.status !== "voided")
        deletedAtSource.add(u.ref);
    }
    const autoResolvedDeletions: string[] = [];
    if (deletedAtSource.size > 0) {
      // Recorded controller dispositions (retain / manual void) are
      // acknowledged divergences: they stand and are never auto-mirrored.
      const resolvedRows = connectionId
        ? ((await db.execute(sql`
            select source_ref from source_deletion_resolutions
             where org_id = ${org.id} and connection_id = ${connectionId}
               and source_ref in ${[...deletedAtSource]}`)) as unknown as {
            rows: { source_ref: string }[];
          }).rows
        : [];
      for (const ref of unresolvedSourceDeletionCandidates(
        deletedAtSource,
        resolvedRows.map((row) => row.source_ref),
      )) {
        try {
          await mirrorSourceDeletion({
            orgId: org.id,
            source: source.name,
            sourceRef: ref,
          });
          autoResolvedDeletions.push(ref);
          deletedAtSource.delete(ref);
        } catch (deletionError) {
          skipped.push(
            `${ref}: source deletion could not be mirrored: ${(deletionError as Error).message.slice(0, 200)}`,
          );
        }
      }
      for (const row of resolvedRows) deletedAtSource.delete(row.source_ref);
    }

    // -- 6. applications ----------------------------------------------------------
    await setProgress(
      run!.id,
      {
        phase: "applications",
        message: "Reconciling payments & credits…",
        docsNew,
        docsAmended,
        docsUnchanged,
        docsFailed,
        ordersNew,
      },
      true,
    );
    const applications =
      changes.applications.length > 0
        ? await reconcileApplications(org.id, refKey, changes.applications)
        : null;

    // -- 6b. GL residual trueup: bring in API-opaque sub-ledger GL (inventory
    //    valuation, realized FX, opening balances) as dated adjusting journals.
    //    OPT-IN per target org (orgs.settings.glTrueup) — it posts real journals,
    //    so it must never fire silently on a live ledger (for example, a production tenant
    //    whose cumulative TB matches but has benign monthly date-allocation drift).
    const trueUpEnabled =
      (
        (await db.execute(
          sql`select (settings->>'glTrueup')::boolean as on from orgs where id = ${org.id}`,
        )) as unknown as {
          rows: { on: boolean | null }[];
        }
      ).rows[0]?.on === true;
    const trueUp = trueUpEnabled && !targetedRefs
      ? await trueUpResidualGl(org.id, source)
      : null;

    // -- 6c. authoritative open-balance sweep -------------------------------------
    // The `application_open_balance` trigger keeps open_balance fresh for normal
    // single-row application changes, but bulk application inserts and any
    // out-of-band edits can leave the denormalized column stale. Recompute it
    // set-based now so AR/AP aging and the open-item gate below reflect the real
    // applied state (only drifted rows are written).
    if (!targetedRefs) await recomputeOpenBalances(org.id);

    // -- 7. verify: authoritative source ledger ----------------------------------
    await setProgress(
      run!.id,
      {
        phase: "verify",
        message: targetedRefs
          ? "Verifying targeted source documents…"
          : "Verifying trial balance, open items, periods & project ledger…",
        docsNew,
        docsAmended,
        docsUnchanged,
        docsFailed,
        ordersNew,
        failureSamples: writeFailures,
      },
      true,
    );
    let targetedDocuments: SyncResult["targetedDocuments"] = null;
    if (targetedRefs) {
      const expectedKeys = changes.documents.map((sourceDocument) => {
        const document: NativeDocument = {
          ...sourceDocument,
          subsidiaryId:
            sourceDocument.subsidiaryId ?? ctx.rootSubsidiaryId,
          currency: sourceDocument.currency ?? source.baseCurrency,
        };
        return {
          sourceRef: document.sourceRef,
          canonicalKey: canonicalNativeDocumentKey(document),
        };
      });
      const actualKeys = new Map<string, string>();
      for (const expected of expectedKeys) {
        const have = existing.get(expected.sourceRef);
        if (have) actualKeys.set(expected.sourceRef, await storedKey(have.id));
      }
      targetedDocuments = verifyTargetedDocumentKeys(
        expectedKeys,
        actualKeys,
      );
    }
    const financialVerification: SourceLedgerVerification = targetedRefs
      ? {
          tb: { accounts: 0, matches: 0, mismatches: [] },
          openItems: null,
          periods: { checked: 0, matches: 0, mismatches: [] },
          projectPeriods: null,
        }
      : await verifyCurrentLedgerState(source, org.id);

    const result: SyncResult = {
      runId: run!.id,
      kind,
      entities: entityStats,
      docsNew,
      docsAmended,
      docsUnchanged,
      ordersNew,
      docsFailed,
      sourceUnbuildable: changes.unbuildable.length,
      skipped: skipped.slice(0, 200),
      deletedAtSource: [...deletedAtSource].sort(),
      autoResolvedDeletions: autoResolvedDeletions.sort(),
      applications,
      trueUp,
      ...financialVerification,
      targetedDocuments,
      syncedThrough: changes.syncedThrough.toISOString(),
      durationMs: Date.now() - started,
    };

    if (syncVerificationFailures(result).length > 0) {
      throw new SyncVerificationError(result);
    }

    await db
      .update(schema.syncRuns)
      .set({
        status: "ok",
        finishedAt: new Date(),
        syncedThrough: targetedRefs ? null : changes.syncedThrough,
        stats: result as unknown as Record<string, unknown>,
      })
      .where(eq(schema.syncRuns.id, run!.id));

    if (connectionId && !targetedRefs) {
      await db.execute(sql`
        update connections
           set cursor = ${changes.syncedThrough}, last_run_at = now(),
               status = 'active', last_error = null
         where id = ${connectionId}`);
    }
    return result;
  } catch (e) {
    const verificationResult =
      e instanceof SyncVerificationError ? e.result : null;
    if (connectionId) {
      await db.execute(sql`
        update connections set last_run_at = now(), updated_at = now()
         where id = ${connectionId}`);
    }
    await db
      .update(schema.syncRuns)
      .set({
        status: "failed",
        finishedAt: new Date(),
        ...(verificationResult
          ? { stats: verificationResult as unknown as Record<string, unknown> }
          : {}),
        errorMessage: (e as Error).message,
      })
      .where(eq(schema.syncRuns.id, run!.id));
    throw e;
  } finally {
    if (source.dispose) {
      try {
        await source.dispose();
      } catch (cleanupError) {
        console.error(
          `[sync:${source.name}] source cleanup failed:`,
          cleanupError,
        );
      }
    }
  }
}

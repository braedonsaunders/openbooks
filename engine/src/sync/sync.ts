import { desc, eq, sql } from "drizzle-orm";
import { db, schema, withOrg } from "../db.ts";
import { toUnits, fromUnits } from "../money.ts";
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
import { loadEntities, type EntityLoadStats } from "./migrate.ts";
import {
  reconcileApplications,
  recomputeOpenBalances,
  type ApplyStats,
} from "./applications.ts";
import { trueUpResidualGl, type TrueUpStats } from "./trueup.ts";
import type { MigrationSource, SourceOpenItem } from "./source.ts";
import {
  verifyAccountMonths,
  type AccountMonthVerification,
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
 *  - deleted at source   → reported (voiding is deliberate, never automatic)
 */

export interface SyncResult {
  runId: string;
  kind: "incremental" | "full_migration";
  entities?: EntityLoadStats;
  docsNew: number;
  docsAmended: number;
  docsUnchanged: number;
  ordersNew: number;
  docsFailed: number;
  sourceUnbuildable: number;
  skipped: string[];
  deletedAtSource: string[];
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
  syncedThrough: string;
  durationMs: number;
}

export interface SyncOptions {
  kind?: "incremental" | "full_migration";
  orgId?: string;
  connectionId?: string;
  /** "auto" resumes from the watermark; null = all history; Date = explicit. */
  since?: Date | null | "auto";
  loadEntitiesFirst?: boolean;
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
  return failures;
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

class SyncVerificationError extends Error {
  constructor(readonly result: SyncResult) {
    super(
      `financial verification failed: ${syncVerificationFailures(result).join("; ")}`,
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

/** Canonical content key of a native document (change detection). */
function nativeKey(d: NativeDocument): string {
  return JSON.stringify([
    d.kind,
    d.partyId,
    d.subsidiaryId,
    d.documentDate,
    d.dueDate,
    d.memo,
    d.referenceNumber,
    d.controlAccountId,
    d.extraDims ?? {},
    d.lines.map((l) => [
      l.accountId,
      l.itemId,
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
    ]),
  ]);
}

/** The same canonical key computed from the stored document. */
type StoredDocumentKeyRow = {
  id: string;
  kind: string;
  party_id: string | null;
  subsidiary_id: string | null;
  ddate: string;
  due: string | null;
  memo: string | null;
  reference_number: string | null;
  ctrl: string | null;
  extra_dims: Record<string, string>;
};
type StoredLineKeyRow = {
  document_id: string;
  account_id: string | null;
  item_id: string | null;
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
};

function storedCanonicalKey(
  d: StoredDocumentKeyRow,
  lines: StoredLineKeyRow[],
): string {
  return JSON.stringify([
    d.kind,
    d.party_id,
    d.subsidiary_id,
    d.ddate,
    d.due,
    d.memo,
    d.reference_number,
    d.ctrl,
    d.extra_dims ?? {},
    lines.map((l) => [
      l.account_id,
      l.item_id,
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
    ]),
  ]);
}

async function storedKey(docId: string): Promise<string> {
  const [d] = (
    (await db.execute(sql`
      select kind, party_id, subsidiary_id, posting_date::text as ddate, due_date::text as due,
             memo, reference_number, custom->>'controlAccountId' as ctrl, extra_dims, id
        from documents where id = ${docId}`)) as unknown as {
      rows: StoredDocumentKeyRow[];
    }
  ).rows;
  const lines = (
    (await db.execute(sql`
      select account_id, item_id, amount, tax_amount, tax_overridden, tax_code_id,
             party_id, department_id, project_id, subsidiary_id, extra_dims, description
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
    select id, kind, party_id, subsidiary_id, posting_date::text as ddate, due_date::text as due,
           memo, reference_number, custom->>'controlAccountId' as ctrl, extra_dims
      from documents
     where org_id = ${orgId} and custom->>${refKey} is not null
     order by id`)) as unknown as { rows: StoredDocumentKeyRow[] };
  const lineResult = (await db.execute(sql`
    select dl.document_id, dl.account_id, dl.item_id, dl.amount, dl.tax_amount, dl.tax_overridden,
           dl.tax_code_id, dl.party_id, dl.department_id, dl.project_id, dl.subsidiary_id,
           dl.extra_dims, dl.description
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
  await db.execute(sql`
    update documents d set
      total = coalesce(j.pos, 0),
      tax_total = coalesce(abs(lt.tax), 0),
      subtotal = coalesce(j.pos, 0) - coalesce(abs(lt.tax), 0)
    from documents d2
    left join lateral (
      select sum(jl.amount) filter (where jl.amount > 0) as pos
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
    if ((opts.loadEntitiesFirst ?? true) && source.entities) {
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
    const changes = await source.nativeChanges(since, ctx);

    // -- 4. existing documents by source ref -------------------------------------
    const existing = new Map<
      string,
      { id: string; status: string; posted: boolean }
    >();
    for (const r of (
      (await db.execute(sql`
        select id, status, posted_entry_id is not null as posted, custom->>${refKey} as ref
          from documents where org_id = ${org.id} and custom->>${refKey} is not null`)) as unknown as {
        rows: { id: string; status: string; posted: boolean; ref: string }[];
      }
    ).rows) {
      existing.set(r.ref, { id: r.id, status: r.status, posted: r.posted });
    }
    // Older rate-keyed order imports retained a non-zero-rate code even when
    // no source tax existed. Zero tax has no unambiguous tax identity in this
    // adapter; remove that legacy promise before canonical change detection.
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
          if (doc.posting && !ctx.periodFor(doc.documentDate)) {
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
                documentNumber: doc.sourceRef,
                partyId: doc.partyId,
                subsidiaryId: doc.subsidiaryId,
                extraDims: doc.extraDims ?? {},
                documentDate: doc.documentDate,
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
            await db.execute(
              sql`update documents set status = 'approved', updated_at = now() where id = ${row!.id}`,
            );
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
            status: doc.posting ? "posted" : "approved",
            posted: doc.posting,
          });
          continue;
        }

        // ---- EXISTS: heal orphan, then amend-if-changed ------------------------
        if (doc.posting && !have.posted && have.status !== "voided") {
          await withOrg(org.id, async () => {
            // Old importer versions could commit the approved document before
            // posting failed. Rebuild its lines/evidence and post as one unit;
            // a repeat failure leaves the prior approved row unchanged.
            await db.execute(sql`set local openbooks.amend = on`);
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
          docsNew++;
          continue;
        }
        if (
          nativeKey(doc) ===
          (fullStoredKeys?.get(have.id) ?? (await storedKey(have.id)))
        ) {
          docsUnchanged++;
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
              document_date = ${doc.documentDate}, posting_date = ${doc.documentDate}, due_date = ${doc.dueDate},
              currency = ${doc.currency ?? source.baseCurrency}, fx_rate = ${doc.fxRate ?? "1"},
              memo = ${doc.memo}, reference_number = ${doc.referenceNumber},
              extra_dims = ${JSON.stringify(doc.extraDims ?? {})}::jsonb,
              custom = custom || ${JSON.stringify(
                doc.controlAccountId
                  ? { controlAccountId: doc.controlAccountId }
                  : {},
              )}::jsonb,
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

    // -- 5. deletions at source: reported, never auto-voided ---------------------
    // On a FULL sweep the pulled set is the complete source universe, so any
    // previously-imported ref that vanished was deleted at source (our books
    // only ever contain refs the source once returned).
    const deletedAtSource = new Set(
      sourceDeletionCandidates(
        since === null,
        existing.keys(),
        [
          ...changes.documents.map((doc) => doc.sourceRef),
          ...changes.unbuildable.map((row) => row.ref),
          ...(changes.nonLedgerRefs ?? []),
        ],
        changes.deletedRefs,
      ),
    );
    // A source-CANCELLED transaction that we imported while it was posted is a
    // ledger divergence: flag it like a deletion (report-only, never auto-void).
    for (const u of changes.unbuildable) {
      if (u.reason === "cancelled" && existing.get(u.ref)?.posted)
        deletedAtSource.add(u.ref);
    }
    if (connectionId && deletedAtSource.size > 0) {
      const resolved = (await db.execute(sql`
        select source_ref from source_deletion_resolutions
         where org_id = ${org.id} and connection_id = ${connectionId}
           and source_ref in ${[...deletedAtSource]}`)) as unknown as {
        rows: { source_ref: string }[];
      };
      const unresolved = unresolvedSourceDeletionCandidates(
        deletedAtSource,
        resolved.rows.map((row) => row.source_ref),
      );
      deletedAtSource.clear();
      for (const ref of unresolved) deletedAtSource.add(ref);
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
    const trueUp = trueUpEnabled
      ? await trueUpResidualGl(org.id, source)
      : null;

    // -- 6c. authoritative open-balance sweep -------------------------------------
    // The `application_open_balance` trigger keeps open_balance fresh for normal
    // single-row application changes, but bulk application inserts and any
    // out-of-band edits can leave the denormalized column stale. Recompute it
    // set-based now so AR/AP aging and the open-item gate below reflect the real
    // applied state (only drifted rows are written).
    await recomputeOpenBalances(org.id);

    // -- 7. verify: trial balance -------------------------------------------------
    await setProgress(
      run!.id,
      { phase: "verify", message: "Verifying trial balance & open items…" },
      true,
    );
    const theirs = await source.trialBalance();
    const ours = (await db.execute(sql`
      select a.custom->>${refKey} as ref, sum(l.amount) as bal
        from journal_lines l join accounts a on a.id = l.account_id
       where l.org_id = ${org.id} and a.custom->>${refKey} is not null group by 1`)) as unknown as {
      rows: { ref: string; bal: string }[];
    };
    const oursByRef = new Map(ours.rows.map((r) => [r.ref, toUnits(r.bal)]));
    const theirsByRef = new Map(
      theirs.map((r) => [r.accountRef, toUnits(r.balance)]),
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
      else
        tbMismatches.push({
          accountRef,
          ours: fromUnits(mine),
          theirs: fromUnits(sourceBalance),
        });
    }

    // -- 8. verify: open items (AR/AP aging vs the live source) --------------------
    let openItems: SyncResult["openItems"] = null;
    if (source.openItems) {
      const truth = await source.openItems();
      const mine = (await db.execute(sql`
        select custom->>${refKey} as ref, coalesce(open_balance, 0) as unpaid
          from documents where org_id = ${org.id} and custom->>${refKey} is not null
      `)) as unknown as {
        rows: SourceOpenItem[];
      };
      openItems = verifyOpenItems(truth, mine.rows);
    }

    // -- 8b. verify: month-bucketed activity (period-allocation exactness) --------
    // The cumulative TB proves totals; this proves WHEN. Together they subsume
    // any statement check (P&L / BS are projections of per-period balances).
    // This method is mandatory on MigrationSource, so a new adapter cannot ship
    // a one-click migration or mirror that silently skips the period gate.
    const truth = await source.monthlyActivity();
    const mine = (await db.execute(sql`
      select a.custom->>${refKey} as "accountRef",
             to_char(e.posting_date, 'YYYY-MM') as month,
             sum(l.amount) as amount
        from journal_lines l
        join journal_entries e on e.id = l.entry_id
        join accounts a on a.id = l.account_id
       where l.org_id = ${org.id} and a.custom->>${refKey} is not null
       group by 1, 2`)) as unknown as {
      rows: { accountRef: string; month: string; amount: string }[];
    };
    const periods = verifyAccountMonths(truth, mine.rows);

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
      applications,
      trueUp,
      tb: {
        accounts: trialBalanceRefs.size,
        matches: tbMatches,
        mismatches: tbMismatches.slice(0, 50),
      },
      openItems,
      periods,
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
        syncedThrough: changes.syncedThrough,
        stats: result as unknown as Record<string, unknown>,
      })
      .where(eq(schema.syncRuns.id, run!.id));

    if (connectionId) {
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

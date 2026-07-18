import { desc, eq, sql } from "drizzle-orm";
import { db, schema } from "../db.ts";
import { toUnits, fromUnits } from "../money.ts";
import { postDocument, regenerateGlImpactTx, type PostingDeps } from "../posting.ts";
import { buildNativeContext, type NativeContext, type NativeDocument } from "./native.ts";
import { loadEntities, type EntityLoadStats } from "./migrate.ts";
import { reconcileApplications, recomputeOpenBalances, type ApplyStats } from "./applications.ts";
import { trueUpResidualGl, type TrueUpStats } from "./trueup.ts";
import type { MigrationSource } from "./source.ts";
import { verifyAccountMonths, type AccountMonthVerification } from "./verification.ts";
import {
  captureTransactionAuditSnapshot,
  recordTransactionAudit,
} from "../transaction-audit.ts";

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
  skipped: string[];
  deletedAtSource: string[];
  applications: ApplyStats | null;
  trueUp: TrueUpStats | null;
  tb: { accounts: number; matches: number; mismatches: { accountRef: string; ours: string; theirs: string }[] };
  openItems: { checked: number; matches: number; mismatches: { ref: string; ours: string; theirs: string }[] } | null;
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

class AccountMonthVerificationError extends Error {
  constructor(readonly result: SyncResult) {
    const mismatchCount = result.periods.checked - result.periods.matches;
    super(
      `account-month verification failed: ${mismatchCount} of ${result.periods.checked} buckets differ from the source`,
    );
    this.name = "AccountMonthVerificationError";
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

/** Canonical content key of a native document (change detection). */
function nativeKey(d: NativeDocument): string {
  return JSON.stringify([
    d.kind, d.partyId, d.subsidiaryId, d.documentDate, d.dueDate, d.memo, d.referenceNumber, d.controlAccountId, d.extraDims ?? {},
    d.lines.map((l) => [
      l.accountId, l.itemId, toUnits(l.amount).toString(), toUnits(l.taxAmount).toString(),
      l.taxOverridden, l.taxCodeId, l.departmentId, l.projectId, l.subsidiaryId, l.extraDims ?? {}, l.description,
    ]),
  ]);
}

/** The same canonical key computed from the stored document. */
async function storedKey(docId: string): Promise<string> {
  const [d] = (
    (await db.execute(sql`
      select kind, party_id, subsidiary_id, posting_date::text as ddate, due_date::text as due,
             memo, reference_number, custom->>'controlAccountId' as ctrl, extra_dims
        from documents where id = ${docId}`)) as unknown as {
      rows: { kind: string; party_id: string | null; subsidiary_id: string | null; ddate: string; due: string | null; memo: string | null; reference_number: string | null; ctrl: string | null; extra_dims: Record<string, string> }[];
    }
  ).rows;
  const lines = (
    (await db.execute(sql`
      select account_id, item_id, amount, tax_amount, tax_overridden, tax_code_id,
             department_id, project_id, subsidiary_id, extra_dims, description
        from document_lines where document_id = ${docId} order by line_number`)) as unknown as {
      rows: {
        account_id: string | null; item_id: string | null; amount: string; tax_amount: string;
        tax_overridden: boolean; tax_code_id: string | null; department_id: string | null;
        project_id: string | null; subsidiary_id: string | null; extra_dims: Record<string, string>; description: string | null;
      }[];
    }
  ).rows;
  return JSON.stringify([
    d!.kind, d!.party_id, d!.subsidiary_id, d!.ddate, d!.due, d!.memo, d!.reference_number, d!.ctrl, d!.extra_dims ?? {},
    lines.map((l) => [
      l.account_id, l.item_id, toUnits(l.amount).toString(), toUnits(l.tax_amount).toString(),
      l.tax_overridden, l.tax_code_id, l.department_id, l.project_id, l.subsidiary_id, l.extra_dims ?? {}, l.description,
    ]),
  ]);
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

export async function runSync(
  source: MigrationSource,
  triggeredBy: string,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const started = Date.now();
  const kind = opts.kind ?? "incremental";
  const refKey = source.refKey;
  const connectionId = opts.connectionId ?? null;
  const org = opts.orgId ? { id: opts.orgId } : (await db.select().from(schema.orgs))[0]!;

  const [run] = await db
    .insert(schema.syncRuns)
    .values({ orgId: org.id, connectionId, source: source.name, kind, triggeredBy })
    .returning();

  try {
    // -- 1. watermark (computed first so high-volume master-data streams — e.g.
    //    time entries — can pull incrementally on a mirror instead of full).
    const [lastOk] = await db
      .select()
      .from(schema.syncRuns)
      .where(sql`${schema.syncRuns.status} = 'ok' and ${schema.syncRuns.syncedThrough} is not null and ${
        connectionId
          ? sql`${schema.syncRuns.connectionId} = ${connectionId}`
          : sql`${schema.syncRuns.source} = ${source.name}`
      }`)
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
    let entityStats: EntityLoadStats | undefined;
    if ((opts.loadEntitiesFirst ?? true) && source.entities) {
      entityStats = await loadEntities(source, org.id, since);
    }

    // Fresh org: derive control accounts from the source so posting rules
    // route AR/AP/bank/tax to exactly the accounts the source used.
    if (source.controlAccounts) {
      const existingCtrl = (
        (await db.execute(sql`select settings->'controlAccounts' as ctrl from orgs where id = ${org.id}`)) as unknown as {
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

    const ctx: NativeContext = await buildNativeContext(org.id, refKey, source.baseCurrency);
    const deps: PostingDeps = { control: ctx.control, cardLiabilityAccountId: ctx.control.ap };

    // -- 3. pull native changes -------------------------------------------------
    const changes = await source.nativeChanges(since, ctx);

    // -- 4. existing documents by source ref -------------------------------------
    const existing = new Map<string, { id: string; status: string; posted: boolean }>();
    for (const r of (
      (await db.execute(sql`
        select id, status, posted_entry_id is not null as posted, custom->>${refKey} as ref
          from documents where org_id = ${org.id} and custom->>${refKey} is not null`)) as unknown as {
        rows: { id: string; status: string; posted: boolean; ref: string }[];
      }
    ).rows) {
      existing.set(r.ref, { id: r.id, status: r.status, posted: r.posted });
    }

    let docsNew = 0, docsAmended = 0, docsUnchanged = 0, ordersNew = 0, docsFailed = 0;
    const skipped: string[] = [];
    for (const u of changes.unbuildable) skipped.push(`${u.ref}: ${u.reason}`);

    for (const sourceDoc of changes.documents) {
      const doc: NativeDocument = {
        ...sourceDoc,
        subsidiaryId: sourceDoc.subsidiaryId ?? ctx.rootSubsidiaryId,
      };
      try {
        const have = existing.get(doc.sourceRef);
        if (!have) {
          // ---- NEW: insert + post through the kernel -------------------------
          if (doc.posting && !ctx.periodFor(doc.documentDate)) {
            docsFailed++;
            skipped.push(`${doc.sourceRef}: no period for ${doc.documentDate}`);
            continue;
          }
          const docId = await db.transaction(async (tx) => {
            const [row] = await tx.insert(schema.documents).values({
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
              status: "approved",
              subtotal: doc.subtotal ?? "0",
              taxTotal: "0",
              total: doc.total ?? "0",
              memo: doc.memo,
              referenceNumber: doc.referenceNumber,
              custom: doc.controlAccountId
                ? { [refKey]: doc.sourceRef, controlAccountId: doc.controlAccountId }
                : { [refKey]: doc.sourceRef },
            }).returning({ id: schema.documents.id });
            await tx.insert(schema.documentLines).values(
              doc.lines.map((l) => ({
                orgId: org.id,
                documentId: row!.id,
                lineNumber: l.lineNumber,
                accountId: l.accountId,
                itemId: l.itemId,
                amount: l.amount,
                taxCodeId: l.taxCodeId,
                taxAmount: l.taxAmount,
                taxOverridden: l.taxOverridden,
                departmentId: l.departmentId,
                projectId: l.projectId,
                subsidiaryId: l.subsidiaryId,
                extraDims: l.extraDims ?? {},
                description: l.description,
              })),
            );
            return row!.id;
          });
          if (doc.posting) {
            await postDocument(docId, deps);
            await setDocumentTotalsFromEntry(docId);
            docsNew++;
          } else {
            ordersNew++;
          }
          existing.set(doc.sourceRef, { id: docId, status: doc.posting ? "posted" : "approved", posted: doc.posting });
          continue;
        }

        // ---- EXISTS: heal orphan, then amend-if-changed ------------------------
        if (doc.posting && !have.posted && have.status !== "voided") {
          await postDocument(have.id, deps);
          await setDocumentTotalsFromEntry(have.id);
          have.posted = true;
          docsNew++;
          continue;
        }
        if (nativeKey(doc) === (await storedKey(have.id))) {
          docsUnchanged++;
          continue;
        }
        // AMEND: document is the system of record; its GL projection follows.
        // `migration` flag too: a mirror amend re-materializes HISTORY — an
        // account deactivated since must not block its own past postings.
        await db.transaction(async (tx) => {
          await tx.execute(sql`set local openbooks.amend = on`);
          await tx.execute(sql`set local openbooks.migration = on`);
          const auditCandidate = await captureTransactionAuditSnapshot(tx, have.id);
          const auditBefore = auditCandidate?.document.status === "posted"
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
                doc.controlAccountId ? { controlAccountId: doc.controlAccountId } : {},
              )}::jsonb,
              updated_at = now()
            where id = ${have.id}`);
          await tx.execute(sql`delete from document_lines where document_id = ${have.id}`);
          await tx.insert(schema.documentLines).values(
            doc.lines.map((l) => ({
              orgId: org.id,
              documentId: have.id,
              lineNumber: l.lineNumber,
              accountId: l.accountId,
              itemId: l.itemId,
              amount: l.amount,
              taxCodeId: l.taxCodeId,
              taxAmount: l.taxAmount,
              taxOverridden: l.taxOverridden,
              departmentId: l.departmentId,
              projectId: l.projectId,
              subsidiaryId: l.subsidiaryId,
              extraDims: l.extraDims ?? {},
              description: l.description,
            })),
          );
          if (have.posted) await regenerateGlImpactTx(tx, have.id, deps, "mirror");
          // The open-balance trigger fires only on posted_entry_id/status change;
          // an amend keeps the entry identity (to preserve applications), so the
          // trigger never sees the changed open lines. Recompute explicitly from
          // the freshly regenerated journal lines (applications are preserved).
          if (have.posted) await tx.execute(sql`select recompute_document_open_balance(${have.id})`);
          if (auditBefore) {
            const auditAfter = await captureTransactionAuditSnapshot(tx, have.id);
            if (!auditAfter) throw new Error(`document ${have.id} disappeared during mirror amendment`);
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
        skipped.push(`${doc.sourceRef}: ${(e as Error).message.slice(0, 140)}`);
      }
    }

    // -- 5. deletions at source: reported, never auto-voided ---------------------
    // On a FULL sweep the pulled set is the complete source universe, so any
    // previously-imported ref that vanished was deleted at source (our books
    // only ever contain refs the source once returned).
    const deletedAtSource = changes.deletedRefs.filter((r) => existing.has(r));
    // A source-CANCELLED transaction that we imported while it was posted is a
    // ledger divergence: flag it like a deletion (report-only, never auto-void).
    for (const u of changes.unbuildable) {
      if (u.reason === "cancelled" && existing.get(u.ref)?.posted) deletedAtSource.push(u.ref);
    }
    if (since === null) {
      const pulled = new Set(changes.documents.map((d) => d.sourceRef));
      for (const u of changes.unbuildable) pulled.add(u.ref);
      for (const ref of existing.keys()) {
        if (!pulled.has(ref)) deletedAtSource.push(ref);
      }
    }

    // -- 6. applications ----------------------------------------------------------
    const applications =
      changes.applications.length > 0
        ? await reconcileApplications(org.id, refKey, changes.applications)
        : null;

    // -- 6b. GL residual trueup: bring in API-opaque sub-ledger GL (inventory
    //    valuation, realized FX, opening balances) as dated adjusting journals.
    //    OPT-IN per target org (orgs.settings.glTrueup) — it posts real journals,
    //    so it must never fire silently on a live ledger (e.g. Rassaun/NetSuite,
    //    whose cumulative TB matches but has benign monthly date-allocation drift).
    const trueUpEnabled = (
      (await db.execute(sql`select (settings->>'glTrueup')::boolean as on from orgs where id = ${org.id}`)) as unknown as {
        rows: { on: boolean | null }[];
      }
    ).rows[0]?.on === true;
    const trueUp = trueUpEnabled ? await trueUpResidualGl(org.id, source) : null;

    // -- 6c. authoritative open-balance sweep -------------------------------------
    // The `application_open_balance` trigger keeps open_balance fresh for normal
    // single-row application changes, but bulk application inserts and any
    // out-of-band edits can leave the denormalized column stale. Recompute it
    // set-based now so AR/AP aging and the open-item gate below reflect the real
    // applied state (only drifted rows are written).
    await recomputeOpenBalances(org.id);

    // -- 7. verify: trial balance -------------------------------------------------
    const theirs = await source.trialBalance();
    const ours = (await db.execute(sql`
      select a.custom->>${refKey} as ref, sum(l.amount) as bal
        from journal_lines l join accounts a on a.id = l.account_id
       where l.org_id = ${org.id} and a.custom->>${refKey} is not null group by 1`)) as unknown as {
      rows: { ref: string; bal: string }[];
    };
    const oursByRef = new Map(ours.rows.map((r) => [r.ref, toUnits(r.bal)]));
    const tbMismatches: SyncResult["tb"]["mismatches"] = [];
    let tbMatches = 0;
    for (const t of theirs) {
      const mine = oursByRef.get(t.accountRef) ?? 0n;
      if (mine === toUnits(t.balance)) tbMatches++;
      else tbMismatches.push({ accountRef: t.accountRef, ours: fromUnits(mine), theirs: t.balance });
    }

    // -- 8. verify: open items (AR/AP aging vs the live source) --------------------
    let openItems: SyncResult["openItems"] = null;
    if (source.openItems) {
      const truth = await source.openItems();
      const mine = (await db.execute(sql`
        select custom->>${refKey} as ref, coalesce(open_balance, 0) as ob
          from documents where org_id = ${org.id} and custom->>${refKey} is not null
            and status = 'posted' and open_balance is not null`)) as unknown as {
        rows: { ref: string; ob: string }[];
      };
      const mineByRef = new Map(mine.rows.map((r) => [r.ref, toUnits(r.ob)]));
      const mismatches: NonNullable<SyncResult["openItems"]>["mismatches"] = [];
      let matches = 0;
      for (const t of truth) {
        const want = toUnits(t.unpaid);
        const got = mineByRef.get(t.ref);
        if (got === undefined) continue; // not imported (e.g. hidden types) — TB covers it
        const wantAbs = want < 0n ? -want : want;
        if (got === wantAbs) matches++;
        else mismatches.push({ ref: t.ref, ours: fromUnits(got), theirs: fromUnits(wantAbs) });
      }
      openItems = { checked: matches + mismatches.length, matches, mismatches: mismatches.slice(0, 50) };
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
      docsNew, docsAmended, docsUnchanged, ordersNew, docsFailed,
      skipped: skipped.slice(0, 200),
      deletedAtSource,
      applications,
      trueUp,
      tb: { accounts: theirs.length, matches: tbMatches, mismatches: tbMismatches.slice(0, 50) },
      openItems,
      periods,
      syncedThrough: changes.syncedThrough.toISOString(),
      durationMs: Date.now() - started,
    };

    if (periods.matches !== periods.checked) {
      throw new AccountMonthVerificationError(result);
    }

    await db.update(schema.syncRuns).set({
      status: "ok",
      finishedAt: new Date(),
      syncedThrough: changes.syncedThrough,
      stats: result as unknown as Record<string, unknown>,
    }).where(eq(schema.syncRuns.id, run!.id));

    if (connectionId) {
      await db.execute(sql`
        update connections
           set cursor = ${changes.syncedThrough}, last_run_at = now(),
               status = 'active', last_error = null
         where id = ${connectionId}`);
    }
    return result;
  } catch (e) {
    const verificationResult = e instanceof AccountMonthVerificationError ? e.result : null;
    if (connectionId) {
      await db.execute(sql`
        update connections set status = 'error', last_error = ${(e as Error).message}, last_run_at = now()
         where id = ${connectionId}`);
    }
    await db.update(schema.syncRuns).set({
      status: "failed",
      finishedAt: new Date(),
      ...(verificationResult ? { stats: verificationResult as unknown as Record<string, unknown> } : {}),
      errorMessage: (e as Error).message,
    }).where(eq(schema.syncRuns.id, run!.id));
    throw e;
  }
}

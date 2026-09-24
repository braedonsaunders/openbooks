import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({ resolve(specifier, context, next) {
  if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
  return next(specifier, context);
}});

const { sql } = await import("drizzle-orm");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} = await import("@openbooks/engine/src/testing/fixtures.ts");
import type { ScratchOrg } from "@openbooks/engine/src/testing/fixtures.ts";
const { convertOrder } = await import("./order-cycle.ts");
const { deleteDocument } = await import("@openbooks/engine/src/ledger/document-delete.ts");

// F26: conversion vs draft-child deletion must take source-order locks in the
// same header-before-lines order. convertOrder (web/lib/order-cycle.ts,
// source header FOR UPDATE then source lines FOR UPDATE OF dl) is
// header-first; releaseConvertedOrderQuantities must match it.
//
// Evidence shape, stated honestly: the converter side below replays
// convertOrder's exact lock-acquisition order (same tables, same predicates,
// same FOR UPDATE forms) rather than the full conversion, because a real
// conversion cannot be paused between its header lock and its line locks —
// and pausing there is precisely what stages the cycle. The deleter side is
// the unmodified production path: real deleteDocument into the real
// releaseConvertedOrderQuantities. The probe waits until the deleter is
// observably blocked on the converter-held header (pg_blocking_pids — not a
// sleep) and only then attempts the source line locks. Inverted order
// deadlocks here with SQLSTATE 40P01; canonical order serializes. The real
// convertOrder is exercised after the race for both safe outcomes: a
// successful re-conversion of the released remainder, then an explicitly
// classified no-remainder refusal on the second attempt.

const PROBE_ROLLBACK = "F26-PROBE-ROLLBACK";

function describeRejection(error: unknown): string {
  const parts: string[] = [];
  let cur = error as { code?: unknown; message?: unknown; cause?: unknown } | null;
  const seen = new Set<unknown>();
  while (cur && (typeof cur === "object" || typeof cur === "function") && !seen.has(cur) && parts.length < 6) {
    seen.add(cur);
    parts.push(`[${String(cur.code ?? "?")}] ${String(cur.message ?? cur)}`);
    cur = (cur.cause ?? null) as typeof cur;
  }
  if (parts.length === 0) parts.push(String(error));
  return parts.join(" <- ");
}

function isDeadlock(error: unknown): boolean {
  return /40P01|deadlock detected/i.test(describeRejection(error));
}

async function seedOrder(org: ScratchOrg, actorId: string, number: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, party_id, subsidiary_id,
       document_date, currency, status, subtotal, tax_total, total,
       created_by, updated_by)
    values (
      ${id}, ${org.orgId}, 'sales_order', ${number}, ${org.customerId},
      ${org.subsidiaryId}, ${org.date}, 'CAD', 'draft', '1000', '0', '1000',
      ${actorId}, ${actorId}
    )
  `);
  await db.execute(sql`
    insert into document_lines
      (org_id, document_id, line_number, account_id, quantity,
       quantity_billed, quantity_fulfilled, unit_price, amount,
       tax_input_amount, tax_amount, created_by, updated_by)
    values (
      ${org.orgId}, ${id}, 1, ${org.accounts.revenue}, '10',
      '0', '0', '100', '1000', '1000', '0', ${actorId}, ${actorId}
    )
  `);
  await db.execute(sql`
    update documents set status = 'approved', updated_at = now(), updated_by = ${actorId}
     where id = ${id} and org_id = ${org.orgId}
  `);
  return id;
}

async function billedOf(orgId: string, documentId: string): Promise<string> {
  return withOrgContext(orgId, async () => {
    const r = (await db.execute<{ quantity_billed: string }>(sql`
      select quantity_billed::text from document_lines
       where org_id = ${orgId} and document_id = ${documentId}
       order by line_number limit 1`));
    return r.rows[0]!.quantity_billed;
  });
}

test("conversion and draft-child deletion serialize on source-order locks (no 40P01)", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, "F26 Concurrency", "admin"));
    const tag = randomUUID().slice(0, 8);
    const soId = await withBypassContext(() => seedOrder(org, actorId, `SO-F26-${tag}`));
    const converted = await convertOrder(org.orgId, actorId, soId, "customer_invoice");
    assert.equal(await billedOf(org.orgId, soId), "10.00000000");

    let releaseHeaderHeld!: () => void;
    const headerHeld = new Promise<void>((resolve) => { releaseHeaderHeld = resolve; });
    let releaseLines!: () => void;
    const linesGate = new Promise<void>((resolve) => { releaseLines = resolve; });
    let converterPid = 0;

    // Converter lock probe: takes the source header lock first, exactly as
    // convertOrder does (documents FOR UPDATE before document_lines
    // FOR UPDATE OF dl), then waits for the deleter to be observably
    // blocked before touching the source lines. Rolls itself back with a
    // sentinel once the line locks are taken.
    const converter = withBypassContext(() => db.transaction(async (tx) => {
      try {
        await tx.execute(sql`set local lock_timeout = '15s'`);
        converterPid = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows[0]!.pid;
        await tx.execute(sql`
          select id from documents where id = ${soId} and org_id = ${org.orgId} for update
        `);
        releaseHeaderHeld();
        await linesGate;
        await tx.execute(sql`
          select dl.id from document_lines dl
           where dl.document_id = ${soId} and dl.org_id = ${org.orgId}
           order by dl.line_number
           for update of dl
        `);
      } finally {
        // Never leave the probe parked on the gate holding the source
        // header, whatever fails above.
        try { releaseLines(); } catch { /* gate already released */ }
      }
      throw new Error(PROBE_ROLLBACK);
    }));
    // Attach a settlement handler promptly so a probe failure before the
    // race below can never surface as an unhandled rejection.
    void converter.then(() => {}, () => {});
    let releaser: Promise<{ documentId: string }> | null = null;
    try {
      await Promise.race([
        headerHeld,
        converter.then(
          () => { throw new Error("converter probe exited before holding the source header"); },
          (err) => { throw new Error(`converter probe failed before holding the source header: ${describeRejection(err)}`); },
        ),
        new Promise((_, reject) => setTimeout(
          () => reject(new Error("timed out waiting for the converter to hold the source header")),
          15_000,
        )),
      ]);
      // The REAL production delete path (deleteDocument ->
      // releaseConvertedOrderQuantities) starts only after the converter
      // holds the source header.
      releaser = withBypassContext(() => deleteDocument(converted.id, actorId, org.orgId, {
        reason: `F26 concurrency probe ${tag}`,
        allowedSubsidiaryIds: null,
      }));
      void releaser.then(() => {}, () => {});

      // Blocking probe: wait until a live backend is blocked BY the
      // converter. The converter holds only the source header at this
      // point, so the blocked waiter must be queued on that header row.
      // This schedules the converter's line attempt deterministically.
      let blockedObserved = false;
      try {
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          const found = (await db.execute<{ pid: number }>(sql`
            select pid from pg_stat_activity
             where datname = current_database()
               and state = 'active'
               and pid <> pg_backend_pid()
               and ${converterPid} = any(pg_blocking_pids(pid))
             limit 1
          `)).rows[0];
          if (found) { blockedObserved = true; break; }
          if ((await Promise.race([
            releaser.then(() => "done" as const, () => "done" as const),
            new Promise((resolve) => setTimeout(() => resolve("wait" as const), 25)),
          ])) === "done") break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      } finally {
        // Always release the converter's line attempt: it either deadlocks
        // (pre-fix, the finding) or takes the free line locks (post-fix).
        // Never leave it parked on the gate holding the source header.
        releaseLines();
      }
      assert.ok(blockedObserved, "deleter must queue on the converter-held source header before lines are attempted");

      const [converterOutcome, releaserOutcome] = await Promise.allSettled([converter, releaser]);
      const problems: string[] = [];
      if (converterOutcome.status === "rejected" && isDeadlock(converterOutcome.reason)) {
        problems.push(`converter deadlocked: ${describeRejection(converterOutcome.reason)}`);
      }
      if (releaserOutcome.status === "rejected" && isDeadlock(releaserOutcome.reason)) {
        problems.push(`deleter deadlocked: ${describeRejection(releaserOutcome.reason)}`);
      }
      assert.deepEqual(problems, [], "conversion vs draft deletion must serialize without a 40P01 deadlock");
      assert.equal(
        converterOutcome.status,
        "rejected",
        "converter probe must roll itself back after taking the line locks",
      );
      assert.match(
        String((converterOutcome as PromiseRejectedResult).reason?.message ?? converterOutcome),
        new RegExp(PROBE_ROLLBACK),
        "converter probe must end in its sentinel rollback, not a lock error",
      );
      assert.equal(
        releaserOutcome.status,
        "fulfilled",
        `deleter must complete once the converter releases the header; got: ${
          releaserOutcome.status === "rejected" ? describeRejection(releaserOutcome.reason) : "fulfilled"
        }`,
      );
      assert.equal(await billedOf(org.orgId, soId), "0.00000000");
      // Both real-conversion safe outcomes: the released remainder
      // converts again, and a further conversion is refused as fully
      // converted (no-remainder refusal, explicitly classified).
      const again = await convertOrder(org.orgId, actorId, soId, "customer_invoice");
      assert.ok(again.id, "the released remainder is convertible again");
      await assert.rejects(
        convertOrder(org.orgId, actorId, soId, "customer_invoice"),
        /fully converted/,
        "a further conversion must be refused as fully converted",
      );
    } finally {
      // Settle both tenants before the scratch org is dropped: no open
      // transaction may still hold source locks when cleanup runs, on any
      // path including timeouts and assertion failures.
      try { releaseLines(); } catch { /* gate already released */ }
      await Promise.allSettled([converter, releaser ?? Promise.resolve()]);
    }
  } finally { await withBypassContext(() => dropScratchOrg(org.orgId)); }
});

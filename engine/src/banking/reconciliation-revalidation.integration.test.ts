import { seedApprovalFlow } from "../testing/fixtures.ts";
import { decideGate } from "../flows/gates.ts";
import { before } from "node:test";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext, withOrgTransaction } from "../platform/db.ts";
import { actorHasPermission } from "../organization/actor-permissions.ts";
import { fromUnits, toUnits } from "../money/money.ts";
import { postEntry } from "../journal/post-entry.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrgReporting,
} from "../testing/fixtures.ts";
import { setPeriodLockState } from "../periods/period-locks.ts";
import {
  importStatement,
  startReconciliation,
  createMatch,
  markReconciled,
  reconciliationStaleness,
} from "./banking.ts";
import {
  previewSignOffRevalidation,
  revalidateReconciliationSignOff,
} from "./reconciliation-revalidation.ts";

const enabled = { skip: !process.env.OPENBOOKS_DB_URL };
const reason =
  "Independent review of neutral late history against the retained statement and sign-off";
async function fixture() {
  const org = await createScratchOrg();
  const signer = await withBypassContext(() =>
    createScratchUser(org.orgId, "Original reconciler", "bank-sign-off"),
  );
  const reviewer = await withBypassContext(() =>
    createScratchUser(org.orgId, "Independent reconciler", "bank-review"),
  );
  await withBypassContext(async () => {
    assert.equal(
      (
        await db.execute(
          sql`update app_roles set permissions=case when key='bank-review'
      then '["banking.read","banking.review_sign_off"]'::jsonb else '["banking.reconcile","gl.post"]'::jsonb end
      where org_id=${org.orgId} and key in ('bank-sign-off','bank-review') returning id`,
          "objects",
        )
      ).length,
      2,
    );
    assert.equal(
      (
        await db.execute(
          sql`update orgs set settings=jsonb_set(settings,'{features}',
      coalesce(settings->'features','{}'::jsonb)||'{"banking":true}'::jsonb)
      where id=${org.orgId} returning id`,
          "objects",
        )
      ).length,
      1,
    );
    assert.equal(
      (
        await db.execute(
          sql`update accounts set reconcilable=true,currency_restriction='CAD',
      subsidiary_id=${org.subsidiaryId} where org_id=${org.orgId} and id=${org.accounts.bank} returning id`,
          "objects",
        )
      ).length,
      1,
    );
  });
  const ctx = (userId = reviewer) => ({ orgId: org.orgId, userId, allowedSubsidiaryIds: null });
  const inOrg = <T>(fn: () => Promise<T>) => withOrgContext(org.orgId, fn);
  const postInTransaction = async (amount: string, date = org.date) => {
    const result = await postEntry(db, {
      orgId: org.orgId,
      bookId: org.bookId,
      subsidiaryId: org.subsidiaryId,
      periodId: org.periodId,
      postingDate: date,
      entryNumber: `REV-${randomUUID()}`,
      origin: "manual",
      actorId: signer,
      currency: "CAD",
      lines: [
        { accountId: org.accounts.bank, amount, txnAmount: amount, fxRate: "1" },
        {
          accountId: org.accounts.adjustment,
          amount: fromUnits(-toUnits(amount)),
          txnAmount: fromUnits(-toUnits(amount)),
          fxRate: "1",
        },
      ],
    });
    const row = (
      await db.execute<{ id: string }>(
        sql`select id from journal_lines where org_id=${org.orgId}
      and entry_id=${result.entryId} and account_id=${org.accounts.bank}`,
        "objects",
      )
    )[0];
    assert.ok(row);
    return row.id;
  };
  const post = (amount: string, date = org.date) => inOrg(() => postInTransaction(amount, date));
  const signed = async (date: string, amount: string, balance: string) => {
    const line = await post(amount, date);
    return inOrg(async () => {
      const transaction = randomUUID();
      const content = `date,amount,description,bank_transaction_id\n${date},${amount},Deposit,${transaction}\n`;
      const imported = await importStatement(
        {
          accountId: org.accounts.bank,
          source: "csv",
          statementDate: date,
          currency: "CAD",
          lines: [
            { postedOn: date, amount, description: "Deposit", bankTransactionId: transaction },
          ],
          sourceEvidence: {
            content,
            filename: "bank.csv",
            contentType: "text/csv",
            csvMapping: { date: 0, amount: 1, description: 2, bankTransactionId: 3 },
          },
        },
        ctx(signer),
      );
      const statement = (
        await db.execute<{ id: string }>(
          sql`select id from bank_statement_lines
        where org_id=${org.orgId} and statement_id=${imported.statementId}`,
          "objects",
        )
      )[0];
      assert.ok(statement);
      const recon = await startReconciliation(
        { accountId: org.accounts.bank, throughDate: date, statementBalance: balance },
        ctx(signer),
      );
      await createMatch(
        { reconciliationId: recon.id, statementLineIds: [statement.id], journalLineIds: [line] },
        ctx(signer),
      );
      await markReconciled(recon.id, ctx(signer));
      return recon.id;
    });
  };
  const snapshot = () =>
    inOrg(async () => ({
      sessions: await db.execute(
        sql`select to_jsonb(r)::text as value from reconciliations r where org_id=${org.orgId} order by id`,
        "objects",
      ),
      matches: await db.execute(
        sql`select to_jsonb(m)::text as value from reconciliation_matches m where org_id=${org.orgId} order by id`,
        "objects",
      ),
      statements: await db.execute(
        sql`select to_jsonb(l)::text as value from bank_statement_lines l where org_id=${org.orgId} order by id`,
        "objects",
      ),
      lines: await db.execute(
        sql`select to_jsonb(l)::text as value from journal_lines l where org_id=${org.orgId} order by id`,
        "objects",
      ),
    }));
  const auditCount = () =>
    inOrg(
      async () =>
        (
          await db.execute<{ count: number }>(
            sql`select count(*)::int as count from audit_log
    where org_id=${org.orgId} and table_name='reconciliations' and changes->>'operation'='revalidate_sign_off'`,
            "objects",
          )
        )[0]!.count,
    );
  const close = () => dropScratchOrgReporting(org.orgId);
  return {
    org,
    signer,
    reviewer,
    ctx,
    inOrg,
    post,
    postInTransaction,
    signed,
    snapshot,
    auditCount,
    close,
  };
}

test(
  "neutral late history is independently reviewed once without changing signed evidence, and later sign-offs inherit only identical current proof",
  enabled,
  async () => {
    const f = await fixture();
    try {
      const first = await f.signed(f.org.date, "250.00", "250.00");
      const next = new Date(f.org.date + "T00:00:00Z");
      next.setUTCDate(next.getUTCDate() + 1);
      const later = await f.signed(next.toISOString().slice(0, 10), "100.00", "350.00");
      await f.post("10.00");
      await f.post("-10.00");
      const before = await f.snapshot();
      assert.equal((await f.inOrg(() => reconciliationStaleness(first, f.ctx()))).stale, true);
      assert.equal((await f.inOrg(() => reconciliationStaleness(later, f.ctx()))).stale, true);
      const preview = await f.inOrg(() => previewSignOffRevalidation(first, f.ctx()));
      assert.equal(preview.proof.lateEffect, "0.0000");
      assert.equal(preview.proof.lateEntries, 2);
      const results = await Promise.all(
        [1, 2].map(() =>
          f.inOrg(() =>
            revalidateReconciliationSignOff(
              first,
              { expectedDigest: preview.proof.digest, reason },
              f.ctx(),
            ),
          ),
        ),
      );
      assert.equal(
        results.filter((result) => result.status === "recorded" && result.replayed).length,
        1,
      );
      assert.equal(await f.auditCount(), 1);
      assert.deepEqual(
        await f.snapshot(),
        before,
        "review preserves all original statements, matches, stamps and sign-offs",
      );
      const own = await f.inOrg(() => reconciliationStaleness(first, f.ctx()));
      const inherited = await f.inOrg(() => reconciliationStaleness(later, f.ctx()));
      assert.equal(own.stale, false);
      assert.equal(own.revalidation?.inherited, false);
      assert.equal(inherited.stale, false);
      assert.equal(inherited.revalidation?.inherited, true);
      assert.equal(inherited.revalidation?.reviewedReconciliationId, first);
      assert.equal(
        inherited.lateEntries.length,
        2,
        "reviewed late lines remain visible and uncleared",
      );
      await f.post("1.00");
      assert.equal((await f.inOrg(() => reconciliationStaleness(first, f.ctx()))).stale, true);
      assert.equal((await f.inOrg(() => reconciliationStaleness(later, f.ctx()))).stale, true);
      assert.equal(await f.auditCount(), 1);
    } finally {
      await f.close();
    }
  },
);

test(
  "review requires current evidence, live authority, requested scope and an open Banking period; caught rollback records no certificate",
  enabled,
  async () => {
    const f = await fixture();
    try {
      const id = await f.signed(f.org.date, "250.00", "250.00");
      await f.post("5.00");
      await f.post("-5.00");
      const before = await f.snapshot();
      const preview = await f.inOrg(() => previewSignOffRevalidation(id, f.ctx()));
      assert.equal(
        (await f.inOrg(() => previewSignOffRevalidation(id, f.ctx(f.signer)))).proof.digest,
        preview.proof.digest,
        "the tenant can permit the original signer to submit a review",
      );
      await assert.rejects(
        f.inOrg(() =>
          previewSignOffRevalidation(id, {
            ...f.ctx(),
            allowedSubsidiaryIds: new Set([randomUUID()]),
          }),
        ),
      );
      await assert.rejects(
        f.inOrg(() =>
          revalidateReconciliationSignOff(id, { expectedDigest: "0".repeat(64), reason }, f.ctx()),
        ),
        /evidence changed/,
      );
      await f.inOrg(() =>
        setPeriodLockState({
          orgId: f.org.orgId,
          periodId: f.org.periodId,
          bookId: f.org.bookId,
          module: "banking",
          state: "soft_closed",
          actorId: f.signer,
          reason: "Independent close before revalidation",
        }),
      );
      await assert.rejects(
        f.inOrg(() =>
          revalidateReconciliationSignOff(
            id,
            { expectedDigest: preview.proof.digest, reason },
            f.ctx(),
          ),
        ),
        /Banking is closed/,
      );
      await f.inOrg(() =>
        setPeriodLockState({
          orgId: f.org.orgId,
          periodId: f.org.periodId,
          bookId: f.org.bookId,
          module: "banking",
          state: "open",
          actorId: f.signer,
          reason: "Controlled test review window",
        }),
      );
      await withBypassContext(() =>
        db.execute(sql`update app_roles set permissions='[]'::jsonb
      where org_id=${f.org.orgId} and key='bank-review'`),
      );
      await assert.rejects(
        f.inOrg(() =>
          revalidateReconciliationSignOff(
            id,
            { expectedDigest: preview.proof.digest, reason },
            f.ctx(),
          ),
        ),
      );
      await withBypassContext(() =>
        db.execute(sql`update app_roles set permissions='["banking.review_sign_off"]'::jsonb
      where org_id=${f.org.orgId} and key='bank-review'`),
      );
      await assert.rejects(
        f.inOrg(() =>
          withOrgTransaction(f.org.orgId, async () => {
            await revalidateReconciliationSignOff(
              id,
              { expectedDigest: preview.proof.digest, reason },
              f.ctx(),
            );
            throw new Error("Caller rolls back the review");
          }),
        ),
        /Caller rolls back/,
      );
      await withBypassContext(() =>
        db.execute(sql`update orgs set settings=jsonb_set(settings,'{features,banking}','false'::jsonb)
      where id=${f.org.orgId}`),
      );
      await assert.rejects(
        f.inOrg(() =>
          revalidateReconciliationSignOff(
            id,
            { expectedDigest: preview.proof.digest, reason },
            f.ctx(),
          ),
        ),
      );
      assert.equal(await f.auditCount(), 0);
      assert.deepEqual(await f.snapshot(), before);
    } finally {
      await f.close();
    }
  },
);

test(
  "a balance-changing late posting refuses neutral review without changing any signed evidence",
  enabled,
  async () => {
    const f = await fixture();
    try {
      const id = await f.signed(f.org.date, "250.00", "250.00");
      await f.post("0.01");
      const before = await f.snapshot();
      await assert.rejects(
        f.inOrg(() => previewSignOffRevalidation(id, f.ctx())),
        /Late postings change the statement-currency balance/,
      );
      assert.equal(await f.auditCount(), 0);
      assert.deepEqual(await f.snapshot(), before);
    } finally {
      await f.close();
    }
  },
);

test(
  "a transaction that began before sign-off and commits after review invalidates the full cut-off proof even with an older posting timestamp",
  enabled,
  async () => {
    const f = await fixture();
    let release!: () => void, began!: () => void;
    const ready = new Promise<void>((resolve) => {
      began = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = f.inOrg(() =>
      withOrgTransaction(f.org.orgId, async () => {
        await db.execute(sql`select now()`);
        began();
        await gate;
        return f.postInTransaction("1.00");
      }),
    );
    try {
      await ready;
      const id = await f.signed(f.org.date, "250.00", "250.00");
      await f.post("5.00");
      await f.post("-5.00");
      const preview = await f.inOrg(() => previewSignOffRevalidation(id, f.ctx()));
      await f.inOrg(() =>
        revalidateReconciliationSignOff(
          id,
          { expectedDigest: preview.proof.digest, reason },
          f.ctx(),
        ),
      );
      assert.equal((await f.inOrg(() => reconciliationStaleness(id, f.ctx()))).stale, false);
      release();
      const line = await pending;
      const oldTimestamp = await f.inOrg(
        async () =>
          (
            await db.execute<{ older: boolean }>(
              sql`
      select je.posted_at<=r.signed_off_at as older from journal_lines jl
       join journal_entries je on je.org_id=jl.org_id and je.id=jl.entry_id
       join reconciliations r on r.org_id=jl.org_id and r.id=${id}
       where jl.org_id=${f.org.orgId} and jl.id=${line}
    `,
              "objects",
            )
          )[0],
      );
      assert.equal(oldTimestamp?.older, true);
      const changed = await f.inOrg(() => reconciliationStaleness(id, f.ctx()));
      assert.equal(
        changed.lateEntries.length,
        2,
        "the legacy timestamp predicate alone does not identify this later commit",
      );
      assert.equal(
        changed.stale,
        true,
        "the complete ledger fingerprint invalidates the old certificate",
      );
      assert.equal(await f.auditCount(), 1);
      await assert.rejects(
        f.inOrg(() => previewSignOffRevalidation(id, f.ctx())),
        /uncleared balance changed outside the identified late movements/,
      );
    } finally {
      release();
      await pending.catch(() => {});
      await f.close();
    }
  },
);

test(
  "a late movement offset by retained older uncleared evidence is reviewed as one neutral set without clearing or discarding either source",
  enabled,
  async () => {
    const f = await fixture();
    try {
      await f.post("-8000.00");
      const id = await f.signed(f.org.date, "250.00", "250.00");
      const next = new Date(f.org.date + "T00:00:00Z");
      next.setUTCDate(next.getUTCDate() + 1);
      const later = await f.signed(next.toISOString().slice(0, 10), "100.00", "350.00");
      await f.post("8000.00");
      const before = await f.snapshot();
      const preview = await f.inOrg(() => previewSignOffRevalidation(id, f.ctx()));
      assert.equal(preview.proof.lateEffect, "8000.0000");
      assert.equal(preview.proof.outstandingEffect, "0.0000");
      assert.equal(preview.proof.neutralBasis, "outstanding_movements");
      assert.equal(preview.proof.outstandingJournalLines, 2);
      await f.inOrg(() =>
        revalidateReconciliationSignOff(
          id,
          { expectedDigest: preview.proof.digest, reason },
          f.ctx(),
        ),
      );
      const reviewed = await f.inOrg(() => reconciliationStaleness(id, f.ctx()));
      assert.equal(reviewed.stale, false);
      assert.equal(
        reviewed.clearedEffect,
        "8000.0000",
        "the late movement is retained truthfully, not relabelled as zero",
      );
      const inherited = await f.inOrg(() => reconciliationStaleness(later, f.ctx()));
      assert.equal(inherited.stale, false);
      assert.equal(inherited.revalidation?.inherited, true);
      assert.deepEqual(await f.snapshot(), before);
      assert.equal(await f.auditCount(), 1);
    } finally {
      await f.close();
    }
  },
);

test(
  "a later sign-off cannot inherit an earlier review when an older transaction changes only its uncleared cutoff history",
  enabled,
  async () => {
    const f = await fixture();
    const next = new Date(f.org.date + "T00:00:00Z");
    next.setUTCDate(next.getUTCDate() + 1);
    const laterDate = next.toISOString().slice(0, 10);
    let release!: () => void, began!: () => void;
    const ready = new Promise<void>((resolve) => {
      began = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = f.inOrg(() =>
      withOrgTransaction(f.org.orgId, async () => {
        await db.execute(sql`select now()`);
        began();
        await gate;
        return f.postInTransaction("1.00", laterDate);
      }),
    );
    try {
      await ready;
      const first = await f.signed(f.org.date, "250.00", "250.00");
      const later = await f.signed(laterDate, "100.00", "350.00");
      await f.post("5.00");
      await f.post("-5.00");
      const preview = await f.inOrg(() => previewSignOffRevalidation(first, f.ctx()));
      await f.inOrg(() =>
        revalidateReconciliationSignOff(
          first,
          { expectedDigest: preview.proof.digest, reason },
          f.ctx(),
        ),
      );
      assert.equal(
        (await f.inOrg(() => reconciliationStaleness(later, f.ctx()))).revalidation?.inherited,
        true,
      );
      const before = await f.snapshot();
      release();
      const line = await pending;
      const timestamp = await f.inOrg(
        async () =>
          (
            await db.execute<{ older: boolean }>(
              sql`
      select je.posted_at<=r.signed_off_at as older from journal_lines jl
       join journal_entries je on je.org_id=jl.org_id and je.id=jl.entry_id
       join reconciliations r on r.org_id=jl.org_id and r.id=${later}
       where jl.org_id=${f.org.orgId} and jl.id=${line}
    `,
              "objects",
            )
          )[0],
      );
      assert.equal(timestamp?.older, true);
      assert.equal(
        (await f.inOrg(() => reconciliationStaleness(first, f.ctx()))).stale,
        false,
        "the earlier cutoff evidence is unchanged",
      );
      const changed = await f.inOrg(() => reconciliationStaleness(later, f.ctx()));
      assert.equal(
        changed.lateEntries.length,
        2,
        "the new line is absent from the legacy late-timestamp selection",
      );
      assert.equal(
        changed.stale,
        true,
        "a different uncleared set cannot inherit an earlier certificate",
      );
      assert.equal(changed.revalidation, undefined);
      const after = await f.snapshot();
      for (const key of ["sessions", "matches", "statements"] as const)
        assert.deepEqual(after[key], before[key]);
      assert.equal(await f.auditCount(), 1);
    } finally {
      release();
      await pending.catch(() => {});
      await f.close();
    }
  },
);

test(
  "narrow sign-off review authority preserves reconciliation authority and refuses live role-scope or duty loss",
  enabled,
  async () => {
    const f = await fixture();
    try {
      const id = await f.signed(f.org.date, "250.00", "250.00");
      await f.post("5.00");
      await f.post("-5.00");
      const before = await f.snapshot();
      assert.equal(
        await f.inOrg(() =>
          actorHasPermission(db, f.org.orgId, f.reviewer, "banking.review_sign_off"),
        ),
        true,
      );
      assert.equal(
        await f.inOrg(() => actorHasPermission(db, f.org.orgId, f.reviewer, "banking.reconcile")),
        false,
      );
      const preview = await f.inOrg(() => previewSignOffRevalidation(id, f.ctx()));
      await withBypassContext(() =>
        db.execute(sql`update app_roles set subsidiary_restriction='{"mode":"list","subsidiaryIds":[]}'::jsonb
      where org_id=${f.org.orgId} and key='bank-review'`),
      );
      await assert.rejects(
        f.inOrg(() =>
          revalidateReconciliationSignOff(
            id,
            { expectedDigest: preview.proof.digest, reason },
            f.ctx(),
          ),
        ),
      );
      await withBypassContext(() =>
        db.execute(sql`update app_roles set subsidiary_restriction='{"mode":"all"}'::jsonb,
      permissions='["banking.read"]'::jsonb where org_id=${f.org.orgId} and key='bank-review'`),
      );
      await assert.rejects(f.inOrg(() => previewSignOffRevalidation(id, f.ctx())));
      assert.equal(await f.auditCount(), 0);
      assert.deepEqual(await f.snapshot(), before);
      await withBypassContext(() =>
        db.execute(sql`update app_roles set permissions='["banking.reconcile"]'::jsonb
      where org_id=${f.org.orgId} and key='bank-review'`),
      );
      assert.equal(
        (await f.inOrg(() => previewSignOffRevalidation(id, f.ctx()))).proof.digest,
        preview.proof.digest,
        "existing full reconciliation authority can still review the same evidence",
      );
      await withBypassContext(() =>
        db.execute(sql`update app_roles set permissions='["banking.review_sign_off"]'::jsonb
      where org_id=${f.org.orgId} and key='bank-review'`),
      );
      const reviewed = await f.inOrg(() =>
        revalidateReconciliationSignOff(
          id,
          { expectedDigest: preview.proof.digest, reason },
          f.ctx(),
        ),
      );
      assert.equal(
        reviewed.status,
        "recorded",
        "The zero-gate submission must complete its native outcome",
      );
      if (reviewed.status !== "recorded")
        throw new Error("The zero-gate submission unexpectedly awaits approval.");
      assert.equal(reviewed.replayed, false);
      assert.equal(reviewed.certificate.reviewedBy, f.reviewer);
      assert.deepEqual(await f.snapshot(), before);
      assert.equal(await f.auditCount(), 1);
    } finally {
      await f.close();
    }
  },
);

// Exercise the same native Flow composition installed by application entry points.
before(async () => {
  const { installEngineSeams } = await import("../composition/install.ts");
  installEngineSeams();
});

test(
  "all tenant sign-off gates complete before the session and matched ledger evidence seal together",
  enabled,
  async () => {
    const f = await fixture();
    try {
      await withBypassContext(() =>
        db.execute(
          sql`update orgs set settings=jsonb_set(settings,'{features,flows}','true'::jsonb) where id=${f.org.orgId}`,
        ),
      );
      for (let index = 0; index < 10; index++)
        await withBypassContext(() =>
          seedApprovalFlow(f.org.orgId, {
            subjectKind: "bank_reconciliation_sign_off",
            assignees: [{ type: "user", userId: f.signer }],
            mode: "all",
            preventSelfApproval: false,
          }),
        );
      const id = await f.signed(f.org.date, "250.00", "250.00");
      const read = () =>
        f.inOrg(() =>
          db.execute<{ status: string; stamps: number }>(
            sql`select r.status,
    (select count(*)::int from journal_lines l where l.org_id=r.org_id and l.reconciliation_id=r.id and l.reconciled_at is not null) as stamps
    from reconciliations r where r.org_id=${f.org.orgId} and r.id=${id}`,
            "objects",
          ),
        );
      const gates = await f.inOrg(() =>
        db.execute<{ id: string }>(
          sql`select id from flow_gates where org_id=${f.org.orgId} and subject_kind='bank_reconciliation_sign_off' and subject_id=${id} and status='pending' order by id`,
          "objects",
        ),
      );
      assert.equal(gates.length, 10);
      for (const gate of gates.slice(0, -1))
        await decideGate({ gateId: gate.id, userId: f.signer, decision: "approved" });
      assert.deepEqual((await read())[0], { status: "balanced", stamps: 0 });
      await decideGate({ gateId: gates.at(-1)!.id, userId: f.signer, decision: "approved" });
      assert.deepEqual((await read())[0], { status: "signed_off", stamps: 1 });
      assert.deepEqual(await f.inOrg(() => markReconciled(id, f.ctx(f.signer))), {
        status: "signed_off",
        journalLinesReconciled: 1,
      });
    } finally {
      await f.close();
    }
  },
);

test(
  "the original signer can submit and decide a neutral review when its tenant Flow permits self approval",
  enabled,
  async () => {
    const f = await fixture();
    try {
      const id = await f.signed(f.org.date, "250.00", "250.00");
      await f.post("5.00");
      await f.post("-5.00");
      await withBypassContext(() =>
        db.execute(
          sql`update orgs set settings=jsonb_set(settings,'{features,flows}','true'::jsonb) where id=${f.org.orgId}`,
        ),
      );
      await withBypassContext(() =>
        seedApprovalFlow(f.org.orgId, {
          subjectKind: "bank_reconciliation_review",
          assignees: [{ type: "user", userId: f.signer }],
          mode: "all",
          preventSelfApproval: false,
        }),
      );
      const preview = await f.inOrg(() => previewSignOffRevalidation(id, f.ctx(f.signer)));
      const before = await f.snapshot();
      assert.deepEqual(
        await f.inOrg(() =>
          revalidateReconciliationSignOff(
            id,
            { expectedDigest: preview.proof.digest, reason },
            f.ctx(f.signer),
          ),
        ),
        { status: "pending_approval" },
      );
      assert.equal(await f.auditCount(), 0);
      const gate = (
        await f.inOrg(() =>
          db.execute<{ id: string }>(
            sql`select id from flow_gates where org_id=${f.org.orgId} and subject_kind='bank_reconciliation_review' and subject_id=${id} and status='pending'`,
            "objects",
          ),
        )
      )[0]!;
      await decideGate({ gateId: gate.id, userId: f.signer, decision: "approved" });
      assert.equal(await f.auditCount(), 1);
      assert.deepEqual(await f.snapshot(), before, "review preserves signed financial evidence");
    } finally {
      await f.close();
    }
  },
);

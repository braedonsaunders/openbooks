import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import {
  db,
  env,
  withBypass,
  withOrgContext,
} from "./db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "./test-fixtures.ts";
import {
  deriveAppInvocationKey,
  executeAppInvocation,
  AppInvocationRequestMismatchError,
  type AppInvocationAttempt,
  type AppInvocationAuditRow,
} from "./apps-invocations.ts";

const DB = !!env.OPENBOOKS_DB_URL;

/**
 * Live-PG proofs for the invocation-exactly-once envelope that wraps every
 * App backend execution (engine/src/apps-invocations.ts). Effect staging uses
 * the real documents table so "rolled back" is verified against committed
 * Postgres state, never against in-memory bookkeeping.
 */

type Fixture = {
  orgId: string;
  actorId: string;
  appId: string;
};

async function makeFixture(): Promise<Fixture> {
  return await withBypass(async () => {
    const org = await createScratchOrg();
    const actorId = await createScratchUser(org.orgId, "Invocation Caller", "admin");
    const appId = randomUUID();
    await db.execute(sql`
      insert into apps (id, org_id, key, name, icon_key, status, granted_permissions, created_by)
      values (${appId}, ${org.orgId}, ${"inv-" + appId.slice(0, 8)}, ${"Invoked App"}, 'box', 'installed', '[]'::jsonb, ${actorId})`);
    return { orgId: org.orgId, actorId, appId };
  });
}

/** Stage one material draft row inside whatever transaction owns this call. */
async function stageEffect(orgId: string, actorId: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into documents (id, org_id, kind, document_number, document_date, currency,
                           subtotal, tax_total, total, created_by)
    values (${id}, ${orgId}, 'journal', ${"INV-" + id.slice(0, 8)}, '2026-07-15', 'CAD',
            '10', '0', '10', ${actorId})`);
  return id;
}

/** The strict audit writer envelopes are exercised with (mirrors web wiring). */
function auditingAgainst(fx: Fixture, sink: AppInvocationAuditRow[]) {
  return async (row: AppInvocationAuditRow): Promise<void> => {
    sink.push(row);
    await db.execute(sql`
      insert into app_runs (org_id, app_id, version_id, endpoint, status, units, logs, error_message, duration_ms, actor_id)
      values (${row.orgId}, ${row.appId}, ${row.versionId}, ${row.endpoint}, ${row.status}, ${row.units},
              ${JSON.stringify(row.logs)}::jsonb, ${row.errorMessage}, ${row.durationMs}, ${row.actorId})`);
  };
}

/** Committed-state row counts: verification escapes any ambient tx scope. */
const committedEffects = async (orgId: string): Promise<number> =>
  Number(
    (
      await withOrgContext(orgId, () =>
        db.execute<{ n: string }>(sql`select count(*) as n from documents where org_id = ${orgId}`),
      )
    ).rows[0]!.n,
  );

const claimCount = async (orgId: string): Promise<number> =>
  Number(
    (
      await withOrgContext(orgId, () =>
        db.execute<{ n: string }>(sql`
          select count(*) as n from application_idempotency_keys
           where org_id = ${orgId} and source = 'app'`),
      )
    ).rows[0]!.n,
  );

const runStatuses = async (orgId: string): Promise<string[]> =>
  (
    await withOrgContext(orgId, () =>
      db.execute<{ status: string }>(sql`select status from app_runs where org_id = ${orgId} order by at`),
    )
  ).rows.map((r) => r.status);

test(
  "a successful invocation commits its claim, stored response, and audit evidence atomically",
  { skip: !DB },
  async () => {
    const fx = await makeFixture();
    try {
      const audits: AppInvocationAuditRow[] = [];
      let executions = 0;
      let stagedEffect = "";
      const outcome = await executeAppInvocation({
        orgId: fx.orgId,
        actorId: fx.actorId,
        appId: fx.appId,
        versionId: null,
        endpoint: "do",
        operation: "apps.call_backend.do",
        idempotencyKey: deriveAppInvocationKey({ endpoint: "do", body: { n: 1 } }),
        requestHash: deriveAppInvocationKey({ requestHashOf: { endpoint: "do", body: { n: 1 } } }),
        run: async (): Promise<AppInvocationAttempt> => {
          executions++;
          stagedEffect = await stageEffect(fx.orgId, fx.actorId);
          return { status: "ok", response: { effect: stagedEffect }, logs: ["ran"], units: 7, durationMs: 3 };
        },
        audit: auditingAgainst(fx, audits),
      });

      assert.equal(outcome.replayed, false);
      assert.equal(executions, 1);
      assert.deepEqual(audits.map((a) => [a.endpoint, a.status]), [["do", "ok"]]);

      // The stored response is durable exactly as returned, ready for replay.
      const claim = await withOrgContext(fx.orgId, () =>
        db.execute<{ response: unknown }>(sql`
          select response from application_idempotency_keys
           where org_id = ${fx.orgId} and source = 'app'
             and operation = 'apps.call_backend.do'`),
      );
      assert.deepEqual(claim.rows[0]?.response ?? null, { effect: stagedEffect });
      assert.equal(await committedEffects(fx.orgId), 1);
    } finally {
      await dropScratchOrg(fx.orgId);
    }
  },
);

for (const refusal of [
  { label: "throwing handler", attempt: (): AppInvocationAttempt => ({ status: "error", error: "handler threw after staging" }) },
  { label: "timed-out handler", attempt: (): AppInvocationAttempt => ({ status: "timeout", error: "execution timed out" }) },
]) {
  test(
    `a ${refusal.label} failing after staging leaves zero effects, releases the claim, keeps one audit row`,
    { skip: !DB },
    async () => {
      const fx = await makeFixture();
      try {
        const audits: AppInvocationAuditRow[] = [];
        let executions = 0;
        const refused = await executeAppInvocation({
          orgId: fx.orgId,
          actorId: fx.actorId,
          appId: fx.appId,
          versionId: null,
          endpoint: "flaky",
          operation: "apps.call_backend.flaky",
          idempotencyKey: deriveAppInvocationKey({ endpoint: "flaky", seq: refusal.label }),
          requestHash: deriveAppInvocationKey({ requestHashOf: refusal.label }),
          run: async (): Promise<AppInvocationAttempt> => {
            executions++;
            await stageEffect(fx.orgId, fx.actorId);
            return refusal.attempt();
          },
          audit: auditingAgainst(fx, audits),
        });

        assert.equal(refused.replayed, false);
        assert.equal(refused.attempt.error, refusal.attempt().error);
        assert.equal(audits.length, 1);
        // All-or-nothing: nothing the handler staged became durable…
        assert.equal(await committedEffects(fx.orgId), 0);
        // …the failed attempt persists exactly one UNCOMPLETED claim (append-
        // only evidence proving zero durable effects)…
        const failedClaim = await withOrgContext(fx.orgId, () =>
          db.execute<{ completedAt: Date | null }>(sql`
            select completed_at as "completedAt" from application_idempotency_keys
             where org_id = ${fx.orgId} and source = 'app'`),
        );
        assert.equal(failedClaim.rows.length, 1);
        assert.equal(failedClaim.rows[0]!.completedAt, null);
        // …and exactly one durable invocation record proves it happened.
        assert.deepEqual(await runStatuses(fx.orgId), [refusal.attempt().status]);
        assert.equal(executions, 1);

        // A retry after the failure takes the same claim over and succeeds —
        // with no effects left behind by the failure, never a duplicate.
        const retried = await executeAppInvocation({
          orgId: fx.orgId,
          actorId: fx.actorId,
          appId: fx.appId,
          versionId: null,
          endpoint: "flaky",
          operation: "apps.call_backend.flaky",
          idempotencyKey: deriveAppInvocationKey({ endpoint: "flaky", seq: refusal.label }),
          requestHash: deriveAppInvocationKey({ requestHashOf: refusal.label }),
          run: async (): Promise<AppInvocationAttempt> => {
            await stageEffect(fx.orgId, fx.actorId);
            return { status: "ok", response: { recovered: true } };
          },
          audit: auditingAgainst(fx, audits),
        });
        assert.equal(retried.attempt.status, "ok");
        assert.equal(retried.replayed, false);
        // The recovering attempt CAN commit material effects for real.
        assert.equal(await committedEffects(fx.orgId), 1);
        const recoveredClaims = await withOrgContext(fx.orgId, () =>
          db.execute<{ completedAt: Date | null }>(sql`
            select completed_at as "completedAt" from application_idempotency_keys
             where org_id = ${fx.orgId} and source = 'app'`),
        );
        assert.equal(recoveredClaims.rows.length, 1);
        assert.ok(recoveredClaims.rows[0]!.completedAt != null);
      } finally {
        await dropScratchOrg(fx.orgId);
      }
    },
  );
}

test(
  "a completed claim replays without re-executing; reused keys demand the same input",
  { skip: !DB },
  async () => {
    const fx = await makeFixture();
    try {
      const key = deriveAppInvocationKey({ endpoint: "charge", body: { cents: 100 } });
      const storedHash = deriveAppInvocationKey({ requestHashFor: "charge-100" });
      let executions = 0;
      const envelopeArgs = () => ({
        orgId: fx.orgId,
        actorId: fx.actorId,
        appId: fx.appId,
        versionId: null,
        endpoint: "charge",
        operation: "apps.call_backend.charge",
        idempotencyKey: key,
        requestHash: storedHash,
        run: async (): Promise<AppInvocationAttempt> => {
          executions++;
          await stageEffect(fx.orgId, fx.actorId);
          return { status: "ok" as const, response: { documentNumber: "JE-000001" } };
        },
        audit: auditingAgainst(fx, []),
      });

      const first = await executeAppInvocation(envelopeArgs());
      assert.equal(first.replayed, false);

      const second = await executeAppInvocation(envelopeArgs());
      assert.equal(second.replayed, true);
      assert.deepEqual(second.attempt.response, first.attempt.response);
      assert.equal(executions, 1);
      assert.equal(await committedEffects(fx.orgId), 1);

      // Same key, different input fails closed instead of replaying.
      await assert.rejects(
        executeAppInvocation({ ...envelopeArgs(), requestHash: deriveAppInvocationKey({ tampered: true }) }),
        AppInvocationRequestMismatchError,
      );
    } finally {
      await dropScratchOrg(fx.orgId);
    }
  },
);

test(
  "concurrent duplicates of one key execute the work exactly once",
  { skip: !DB },
  async () => {
    const fx = await makeFixture();
    try {
      let executions = 0;
      const args = () => ({
        orgId: fx.orgId,
        actorId: fx.actorId,
        appId: fx.appId,
        versionId: null,
        endpoint: "parallel",
        operation: "apps.call_backend.parallel",
        idempotencyKey: deriveAppInvocationKey({ endpoint: "parallel" }),
        requestHash: deriveAppInvocationKey({ requestHashOf: "parallel" }),
        run: async (): Promise<AppInvocationAttempt> => {
          executions++;
          await stageEffect(fx.orgId, fx.actorId);
          return { status: "ok" as const, response: { once: true } };
        },
        audit: () => Promise.resolve(),
      });

      const outcomes = await Promise.all([
        executeAppInvocation(args()).catch((e) => e),
        executeAppInvocation(args()).catch((e) => e),
        executeAppInvocation(args()).catch((e) => e),
      ]);

      // Exactly one attempt executed; rivals either failed closed (refused
      // while in-flight) or served the completed claim as a replay — they
      // NEVER ran the work themselves.
      assert.equal(outcomes.filter((o) => o?.attempt?.status === "ok").length >= 1, true);
      assert.equal(executions, 1);
      assert.equal(await committedEffects(fx.orgId), 1);
      for (const o of outcomes.slice(1)) {
        const isReplay = o?.replayed === true;
        const isInFlightRefusal =
          o instanceof Error && /already in progress/.test(String(o.message));
        assert.ok(isReplay || isInFlightRefusal, `unexpected duplicate outcome: ${JSON.stringify(o)}`);
      }
    } finally {
      await dropScratchOrg(fx.orgId);
    }
  },
);

test(
  "an audit-write failure rolls back staged effects and the claim instead of publishing unaudited results",
  { skip: !DB },
  async () => {
    const fx = await makeFixture();
    try {
      const triggerName = "app_runs_fail_closed_invocations";
      // Org-scoped sabotage: only THIS scratch org's audit inserts fail.
      await withBypass(async () => {
        await db.execute(sql`
          create or replace function fail_invocation_audit() returns trigger language plpgsql as $fn$
          begin
            raise exception 'app_runs unavailable';
          end
          $fn$`);
        await db.execute(sql`
          create trigger ${sql.raw(triggerName)}
            before insert on app_runs
            for each row when (new.org_id = ${sql.raw("'" + fx.orgId + "'")}::uuid)
            execute function fail_invocation_audit()`);
      });
      try {
        await assert.rejects(
          executeAppInvocation({
            orgId: fx.orgId,
            actorId: fx.actorId,
            appId: fx.appId,
            versionId: null,
            endpoint: "unauditable",
            operation: "apps.call_backend.unauditable",
            idempotencyKey: deriveAppInvocationKey({ endpoint: "unauditable" }),
            requestHash: deriveAppInvocationKey({ forceAuditFailure: true }),
            run: async (): Promise<AppInvocationAttempt> => {
              await stageEffect(fx.orgId, fx.actorId);
              return { status: "ok", response: { wouldBe: "material" } };
            },
            audit: auditingAgainst(fx, []),
          }),
          (rejection: Error | undefined) => {
            let cur: unknown = rejection;
            while (cur instanceof Error && !/app_runs unavailable/.test(cur.message)) {
              cur = (cur as Error & { cause?: unknown }).cause;
            }
            return cur != null;
          },
        );

        // The unaudited result was not published: zero effects, zero residue.
        assert.equal(await committedEffects(fx.orgId), 0);
        assert.equal(await claimCount(fx.orgId), 0);
        assert.deepEqual(await runStatuses(fx.orgId), []);
      } finally {
        await withBypass(() => db.execute(sql`drop trigger if exists ${sql.raw(triggerName)} on app_runs`));
      }
    } finally {
      await dropScratchOrg(fx.orgId);
    }
  },
);

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrg, withOrgTransaction } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  seedApprovalFlow,
  seedPostingAccount,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import { createChangeRequestDraft, submitChangeRequest } from "../hrm/change-requests.ts";
import { HRM_CHANGE_REQUEST_SUBJECT_KIND } from "@openbooks/schema/src/hrm-change-requests.ts";
import { postEntry } from "../journal/post-entry.ts";
import { recordHistoricalContributionFixture } from "../testing/historical-translations.ts";
import { decideGate } from "../flows/gates.ts";
import { createSandbox, deleteSandbox } from "./lifecycle.ts";
import { errorChainMatches } from "../testing/error-chain.ts";
import { grantPermissions, linkPerson, seedEmployment } from "../testing/hrm-harness.ts";
import { installEngineSeams } from "../composition/install.ts";

// Gate releases and post_document run through the installed engine
// seams; without this the gates strand on a not-registered
// refusal instead of releasing.
installEngineSeams();

/**
 * A source org holding terminal history (an applied HRM change request and an
 * applied financial change) clones verbatim. Both BEFORE INSERT guards refuse
 * rows born outside draft in ordinary sessions; the clone authority replays
 * that history, and ordinary sessions keep every born-terminal refusal.
 *
 * Proofs are read back from storage: the sandbox carries the exact applied
 * rows (id, status, digest, application evidence), and ordinary-session
 * INSERTs of terminal rows are still refused by name.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

async function gateOf(requestId: string): Promise<{ id: string }> {
  const rows = await db.execute<{ id: string }>(
    sql`
    select id from flow_gates where subject_id = ${requestId} order by created_at
  `,
    "objects",
  );
  assert.equal(rows.length, 1, "exactly one gate decides the request");
  return rows[0]!;
}

/** Drive one hire request draft → submit → approve → applied, returning its id. */
async function seedAppliedChangeRequest(orgId: string, subsidiaryId: string): Promise<string> {
  const submitterId = await createScratchUser(orgId, "Clone Flow Submitter", "hrm_author");
  const approverId = await createScratchUser(orgId, "Clone Flow Approver", "hrm_decider");
  await grantPermissions(orgId, submitterId, ["hrm.employment.read", "hrm.employment.manage"]);
  await grantPermissions(orgId, approverId, ["hrm.employment.read", "hrm.employment.approve"]);
  await linkPerson(orgId, submitterId);
  await linkPerson(orgId, approverId);
  await seedApprovalFlow(orgId, {
    subjectKind: HRM_CHANGE_REQUEST_SUBJECT_KIND,
    assignees: [{ type: "user", userId: approverId }],
    mode: "any",
  });

  // A hire records a person who already holds the employee role.
  const { employmentId } = await seedEmployment(orgId, subsidiaryId, {
    displayName: "Cloned Worker",
    withVersion: false,
    employeeRole: true,
  });

  const draft = await createChangeRequestDraft({
    orgId,
    actorId: submitterId,
    employmentId,
    payload: { kind: "hire", status: "active", effectiveFrom: "2026-09-01" },
  });
  await submitChangeRequest({
    orgId,
    actorId: submitterId,
    requestId: draft.id,
    reason: "staff the cloned template cohort",
  });
  const gate = await gateOf(draft.id);
  const decided = await decideGate({ gateId: gate.id, decision: "approved", userId: approverId });
  assert.equal(decided.ok, true);
  const status = (
    await db.execute<{ status: string }>(
      sql`
    select status from hrm_employment_change_requests where id = ${draft.id}
  `,
      "objects",
    )
  )[0]!.status;
  assert.equal(status, "applied");
  return draft.id;
}

/** Apply an evidenced contribution through the tenant's native zero-gate policy. */
async function seedAppliedFinancialChange(org: ScratchOrg, actorId: string): Promise<string> {
  return withOrgTransaction(org.orgId, async () => {
    await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',
      coalesce(settings->'features','{}'::jsonb)||'{"multiCurrency":true}'::jsonb) where id=${org.orgId}`);
    const equity = await seedPostingAccount(
      org.orgId,
      "CLONE-CAP",
      "Contribution capital",
      "equity",
    );
    const posted = await postEntry(db, {
      orgId: org.orgId,
      actorId,
      bookId: org.bookId,
      subsidiaryId: org.subsidiaryId,
      periodId: org.periodId,
      entryNumber: `CAP-${randomUUID()}`,
      postingDate: org.date,
      currency: "CAD",
      origin: "manual",
      lines: [
        {
          accountId: equity,
          subsidiaryId: org.subsidiaryId,
          amount: "-100",
          currency: "CAD",
          txnAmount: "-100",
          fxRate: "1",
        },
        {
          accountId: org.accounts.bank,
          subsidiaryId: org.subsidiaryId,
          amount: "100",
          currency: "CAD",
          txnAmount: "100",
          fxRate: "1",
        },
      ],
    });
    const source = (
      await db.execute<{ id: string }>(
        sql`select id from journal_lines
      where org_id=${org.orgId} and entry_id=${posted.entryId} and account_id=${equity}`,
        "objects",
      )
    )[0];
    assert.ok(source);
    await recordHistoricalContributionFixture({
      orgId: org.orgId,
      actorId,
      sourceLineId: source.id,
      measurementCurrency: "CAD",
      presentationCurrency: "USD",
      historicalDate: org.date,
      amount: "-100",
      rate: "1.2",
    });
    const applied = await db.execute<{ id: string }>(
      sql`select id from financial_changes
      where org_id=${org.orgId} and subject_id=${source.id} and status='applied'`,
      "objects",
    );
    assert.equal(applied.length, 1);
    return applied[0]!.id;
  });
}

/** Delete every sandbox cut from a production org, so a failed clone's committed
 * shell cannot block the source org's drop (orgs_sandbox_of_fkey) or mask the
 * body's own failure behind a teardown error. */
async function deleteSandboxesFor(productionOrgId: string): Promise<void> {
  const rows = await db.execute<{ id: string }>(
    sql`
    select id from sandboxes where production_org_id = ${productionOrgId}`,
    "objects",
  );
  for (const row of rows) await deleteSandbox(row.id);
}

test(
  "a full sandbox clones applied HRM and financial-change history verbatim",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const requestId = await seedAppliedChangeRequest(org.orgId, org.subsidiaryId);
      const actor = await createScratchUser(org.orgId, "Clone Flow Actor", "admin");
      const changeId = await seedAppliedFinancialChange(org, actor);

      // ids are rebased by the copy, so correlate on rebase-invariant evidence:
      // the storage-computed digest, the payload bytes, and the natural
      // idempotency key.
      const sourceRequest = (
        await db.execute<{
          status: string;
          digest: string;
          payload: string;
          appliedRevision: number | null;
        }>(
          sql`
      select status, payload_digest as digest, payload::text as payload,
             applied_employment_revision as "appliedRevision"
        from hrm_employment_change_requests where id = ${requestId}
    `,
          "objects",
        )
      )[0]!;
      assert.equal(sourceRequest.status, "applied");
      assert.match(sourceRequest.digest, /^[0-9a-f]{64}$/);
      assert.ok(sourceRequest.appliedRevision);

      const created = await createSandbox({
        productionOrgId: org.orgId,
        name: `TerminalHistory ${randomUUID()}`,
        tier: "full",
        masked: false,
      });

      // The applied HRM request arrives intact: terminal status,
      // storage-computed digest, payload bytes, and application evidence that
      // still points at the cloned canonical change (rebased both sides).
      const clonedRequests = await db.execute<{
        status: string;
        digest: string;
        payload: string;
        appliedRevision: number | null;
        changeRevision: number | null;
      }>(
        sql`
      select r.status, r.payload_digest as digest, r.payload::text as payload,
             r.applied_employment_revision as "appliedRevision",
             c.revision as "changeRevision"
        from hrm_employment_change_requests r
        left join employment_changes c
          on c.id = r.applied_employment_change_id and c.org_id = r.org_id
       where r.org_id = ${created.sandboxOrgId}
    `,
        "objects",
      );
      assert.equal(clonedRequests.length, 1, "the clone carries the applied change request");
      const clonedRequest = clonedRequests[0]!;
      assert.equal(clonedRequest.status, "applied");
      assert.equal(clonedRequest.digest, sourceRequest.digest);
      assert.equal(clonedRequest.payload, sourceRequest.payload);
      assert.equal(clonedRequest.appliedRevision, sourceRequest.appliedRevision);
      assert.equal(
        clonedRequest.changeRevision,
        sourceRequest.appliedRevision,
        "the cloned application evidence still references the cloned canonical change",
      );

      // The applied financial change arrives intact too, keyed by its natural
      // idempotency key (the row id is rebased).
      const clonedChange = (
        await db.execute<{ status: string }>(
          sql`
      select status from financial_changes
       where org_id = ${created.sandboxOrgId} and idempotency_key =
         (select idempotency_key from financial_changes where org_id=${org.orgId} and id=${changeId})
    `,
          "objects",
        )
      )[0];
      assert.ok(clonedChange, "the clone carries the applied financial change");
      assert.equal(clonedChange!.status, "applied");

      // ...while ordinary sessions are still refused by name on both tables.
      const employmentId = (
        await db.execute<{ id: string }>(
          sql`
      select id from worker_employments where org_id = ${org.orgId} limit 1
    `,
          "objects",
        )
      )[0]!.id;
      // The driver wraps the guard refusal (DrizzleQueryError cause chain), so
      // match down the chain — the guard's own message must name the remedy.
      await assert.rejects(
        withOrg(org.orgId, () =>
          db.execute(sql`
        insert into hrm_employment_change_requests
          (org_id, employment_id, expected_employment_revision, payload,
           payload_digest, payload_schema_version, status)
        values (${org.orgId}, ${employmentId}, 1, '{}'::jsonb, 'forged', '1', 'applied')
      `),
        ),
        (error: unknown) => {
          assert.ok(
            errorChainMatches(error, /must be inserted as draft, then submitted/),
            "an ordinary applied INSERT is still refused by name",
          );
          return true;
        },
      );
      await assert.rejects(
        withOrg(org.orgId, () =>
          db.execute(sql`
        insert into financial_changes
          (org_id, subsidiary_id, domain, subject_id, operation, effective_on,
           reason, idempotency_key, payload, before_state, status, submitted_by)
        values (${org.orgId}, ${org.subsidiaryId}, 'lease', ${randomUUID()}, 'remeasure',
                ${"2026-09-02"}, 'forged terminal insert probe', ${`probe-terminal-${randomUUID()}`},
                '{}'::jsonb, '{}'::jsonb, 'approved', ${actor})
      `),
        ),
        (error: unknown) => {
          assert.ok(
            errorChainMatches(error, /must start as draft/),
            "an ordinary approved financial-change INSERT is still refused by name",
          );
          return true;
        },
      );
    } finally {
      await deleteSandboxesFor(org.orgId);
      await dropScratchOrg(org.orgId);
    }
  },
);

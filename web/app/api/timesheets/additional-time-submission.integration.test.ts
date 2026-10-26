import {
  configureTimesheetReviewFixture,
  decideTimesheetFixture,
} from "../../../testing/timesheet-flows";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "@openbooks/engine/platform/db";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrgReporting,
} from "@openbooks/engine/testing/fixtures";
import { resolveAuthzByUserId, type Authz } from "../../../lib/authz-core";
import { withAuthzContext } from "../../../lib/authz-context";
import { loadWeek } from "./_lib";
import { POST as submit } from "./submit/route";

import { POST as withdraw } from "./withdraw/route";

const enabled = { skip: !process.env.OPENBOOKS_DB_URL };
const WEEK = "2026-04-05";
type Selection = { id: string; updatedAt: string };

async function fixture() {
  const org = await withBypassContext(() => createScratchOrg());
  const employee = randomUUID(),
    header = randomUUID();
  const prior = randomUUID(),
    chosen = randomUUID(),
    untouched = randomUUID();
  const actor = await withBypassContext(() =>
    createScratchUser(org.orgId, "Time reviewer", "additional-time-reviewer"),
  );
  await withBypassContext(async () => {
    assert.equal(
      (
        await db.execute(
          sql`update app_roles set permissions='["time.read","time.manage","time.approve"]'::jsonb
      where org_id=${org.orgId} and key='additional-time-reviewer' returning id`,
          "objects",
        )
      ).length,
      1,
    );
    assert.equal(
      (
        await db.execute(
          sql`update orgs set settings=settings ||
      '{"features":{"projects":false,"timeTracking":true}}'::jsonb
      where id=${org.orgId} returning id`,
          "objects",
        )
      ).length,
      1,
    );
    await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom)
      values(${employee},${org.orgId},'employee','Additional time worker',${org.subsidiaryId},true,'{}'::jsonb)`);
    await db.execute(sql`insert into employee_roles(id,org_id,party_id,is_active)
      values(${randomUUID()},${org.orgId},${employee},true)`);
    await db.execute(sql`insert into timesheet_weeks(id,org_id,employee_party_id,week_start,status,
      approved_by,approved_at,created_by,updated_by)
      values(${header},${org.orgId},${employee},${WEEK}::date,'approved',${actor},now(),${actor},${actor})`);
    for (const [id, day, hours, status] of [
      [prior, "2026-04-06", "8.0000", "approved"],
      [chosen, "2026-04-07", "1.5000", "draft"],
      [untouched, "2026-04-08", "2.0000", "draft"],
    ] as const) {
      await db.execute(sql`insert into time_entries(id,org_id,employee_party_id,worked_on,hours,status,
        is_billable,costing_basis,custom,created_by,updated_by,approved_by,approved_at)
        values(${id},${org.orgId},${employee},${day}::date,${hours},${status},false,'actual','{}'::jsonb,
        ${actor},${actor},${status === "approved" ? actor : null},${status === "approved" ? new Date() : null})`);
    }
  });
  await configureTimesheetReviewFixture(org.orgId, actor, false);
  const auth = async () =>
    withOrgContext(org.orgId, async () => {
      const resolved = await resolveAuthzByUserId(org.orgId, actor);
      assert.ok(resolved, "the native route has an active resolved actor");
      return resolved;
    });
  const read = () => withOrgContext(org.orgId, () => loadWeek(org.orgId, employee, WEEK));
  const snapshot = () =>
    withOrgContext(
      org.orgId,
      async () =>
        await db.execute<{ id: string; value: string }>(
          sql`
    select id,to_jsonb(te)::text as value from time_entries te where org_id=${org.orgId} order by id`,
          "objects",
        ),
    );
  const post = async (selections: Selection[], held?: Authz) => {
    const authority = held ?? (await auth());
    return withOrgContext(org.orgId, () =>
      withAuthzContext(authority, () =>
        submit(
          new Request("http://time.local/api/timesheets/submit", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              employee,
              week: WEEK,
              selections,
              reason: "Submit the independently reviewed additional entries",
            }),
          }),
        ),
      ),
    );
  };
  const approveSelected = async () =>
    withOrgContext(org.orgId, async () =>
      withAuthzContext(await auth(), () =>
        decideTimesheetFixture({
          orgId: org.orgId,
          ...{ employee, week: WEEK },
          decision: "approved",
        }),
      ),
    );
  const withdrawSelected = async () =>
    withOrgContext(org.orgId, async () =>
      withAuthzContext(await auth(), () =>
        withdraw(
          new Request("http://time.local/api/timesheets/withdraw", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ employee, week: WEEK }),
          }),
        ),
      ),
    );
  const selections = async () =>
    (await read())
      .pendingEntries!.filter((entry) => entry.id === chosen)
      .map(({ id, updatedAt }) => ({ id, updatedAt }));
  const close = () => dropScratchOrgReporting(org.orgId);
  return {
    org,
    actor,
    employee,
    header,
    prior,
    chosen,
    untouched,
    auth,
    read,
    snapshot,
    post,
    approveSelected,
    withdrawSelected,
    selections,
    close,
  };
}

test(
  "withdrawn selected time can be reviewed and resubmitted without submitting held drafts or changing prior approvals",
  enabled,
  async () => {
    const f = await fixture();
    try {
      const before = await f.snapshot(),
        originalChoice = await f.selections();
      const submitted = await f.post(originalChoice);
      assert.equal(submitted.status, 200, await submitted.clone().text());
      const withdrawn = await f.withdrawSelected();
      assert.equal(withdrawn.status, 200, await withdrawn.clone().text());
      assert.equal((await f.read()).status, "draft");
      const afterWithdraw = await f.snapshot();
      const stale = await f.post(originalChoice);
      assert.equal(stale.status, 409, await stale.clone().text());
      assert.deepEqual(await f.snapshot(), afterWithdraw);
      const choice = await f.selections();
      const resubmitted = await f.post(choice);
      assert.equal(resubmitted.status, 200, await resubmitted.clone().text());
      assert.equal((await f.read()).status, "submitted");
      const repeated = await f.post(choice);
      assert.equal(repeated.status, 409, await repeated.clone().text());
      const audits = await withOrgContext(
        f.org.orgId,
        async () =>
          await db.execute<{
            changes: { before: { status: string }; entries: Selection[] };
          }>(
            sql`select changes from audit_log where org_id=${f.org.orgId} and row_id=${f.header}
      and changes->>'event'='additional_time_submitted'`,
            "objects",
          ),
      );
      assert.equal(audits.length, 2);
      const recalled = audits.find((row) => row.changes.before.status === "draft");
      assert.ok(recalled, "the new audit records the actual withdrawn draft state");
      assert.deepEqual(
        recalled.changes.entries.map(({ id, updatedAt }) => ({ id, updatedAt })),
        choice,
      );
      const approved = await f.approveSelected();
      assert.equal(approved.status, 200, await approved.clone().text());
      const after = await f.snapshot();
      for (const id of [f.prior, f.untouched])
        assert.equal(
          after.find((row) => row.id === id)?.value,
          before.find((row) => row.id === id)?.value,
          "recall, resubmission and approval preserve every unselected row field",
        );
      assert.equal(JSON.parse(after.find((row) => row.id === f.chosen)!.value).status, "approved");
      assert.deepEqual(
        (await f.read()).pendingEntries!.map((entry) => entry.id),
        [f.untouched],
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "selective submission and native approval preserve earlier approved time and unselected drafts",
  enabled,
  async () => {
    const f = await fixture();
    try {
      const before = await f.snapshot();
      const journalCount = () =>
        withOrgContext(
          f.org.orgId,
          async () =>
            (
              await db.execute<{ count: number }>(
                sql`
      select count(*)::int as count from journal_entries where org_id=${f.org.orgId}`,
                "objects",
              )
            )[0]!.count,
        );
      const journalsBefore = await journalCount();
      const choice = await f.selections();
      assert.equal(choice.length, 1);
      const response = await f.post(choice);
      assert.equal(response.status, 200, await response.clone().text());
      const read = await f.read();
      assert.equal(read.status, "submitted");
      assert.deepEqual(
        read.pendingEntries!.map((entry) => entry.id),
        [f.untouched],
      );
      const afterSubmit = await f.snapshot();
      for (const id of [f.prior, f.untouched])
        assert.equal(
          afterSubmit.find((row) => row.id === id)?.value,
          before.find((row) => row.id === id)?.value,
          "unselected financial/approval/source fields are immutable under this command",
        );
      const audit = await withOrgContext(
        f.org.orgId,
        async () =>
          await db.execute<{
            changes: {
              entries: { id: string; updatedAt: string }[];
              before: { approval: { actorId: string } };
              reason: string;
            };
          }>(
            sql`select changes from audit_log where org_id=${f.org.orgId} and row_id=${f.header}
      and changes->>'event'='additional_time_submitted'`,
            "objects",
          ),
      );
      assert.equal(audit.length, 1);
      assert.deepEqual(
        audit[0]!.changes.entries.map(({ id, updatedAt }) => ({ id, updatedAt })),
        choice,
      );
      assert.equal(audit[0]!.changes.before.approval.actorId, f.actor);
      assert.match(audit[0]!.changes.reason, /independently reviewed/);
      const approved = await f.approveSelected();
      assert.equal(approved.status, 200, await approved.clone().text());
      assert.equal((await f.read()).status, "approved");
      const afterApproval = await f.snapshot();
      for (const id of [f.prior, f.untouched])
        assert.equal(
          afterApproval.find((row) => row.id === id)?.value,
          before.find((row) => row.id === id)?.value,
          "approval consumes only the submitted selection",
        );
      const chosen = JSON.parse(afterApproval.find((row) => row.id === f.chosen)!.value);
      assert.equal(chosen.status, "approved");
      assert.equal(
        chosen.cost_journal_entry_id,
        null,
        "standalone time does not manufacture project costing",
      );
      assert.equal(await journalCount(), journalsBefore);
    } finally {
      await f.close();
    }
  },
);

test(
  "stale, duplicate, foreign and revoked-authority selections refuse without changing time or lifecycle",
  enabled,
  async () => {
    const f = await fixture();
    const other = await withBypassContext(() => createScratchOrg());
    try {
      const before = await f.snapshot(),
        choice = await f.selections();
      const foreignEmployee = randomUUID(),
        foreignEntry = randomUUID();
      await withBypassContext(async () => {
        await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom)
        values(${foreignEmployee},${other.orgId},'person','Other time worker',${other.subsidiaryId},true,'{}'::jsonb)`);
        await db.execute(sql`insert into time_entries(id,org_id,employee_party_id,worked_on,hours,status,
        is_billable,costing_basis,custom)
        values(${foreignEntry},${other.orgId},${foreignEmployee},'2026-04-07','1.5000','draft',false,'actual','{}'::jsonb)`);
      });
      const attempts = [
        [{ ...choice[0]!, updatedAt: "2026-04-01T00:00:00.000000Z" }],
        [choice[0]!, choice[0]!],
        [{ id: foreignEntry, updatedAt: choice[0]!.updatedAt }],
      ];
      for (const selection of attempts) {
        const response = await f.post(selection);
        assert.equal(response.status, 409, await response.clone().text());
        assert.deepEqual(await f.snapshot(), before);
        assert.equal((await f.read()).status, "approved");
      }
      const held = await f.auth();
      await withBypassContext(() =>
        db.execute(sql`update app_roles set permissions='["time.read"]'::jsonb
      where org_id=${f.org.orgId} and key='additional-time-reviewer'`),
      );
      const revoked = await f.post(choice, held);
      assert.ok(
        revoked.status >= 400 && revoked.status < 500,
        "the service rechecks a live grant after the route snapshot",
      );
      assert.deepEqual(await f.snapshot(), before);
      assert.equal((await f.read()).status, "approved");
      await withBypassContext(() =>
        db.execute(sql`update app_roles set permissions='["time.read","time.manage"]'::jsonb,
      subsidiary_restriction='{"mode":"list","subsidiaryIds":[]}'::jsonb
      where org_id=${f.org.orgId} and key='additional-time-reviewer'`),
      );
      const scoped = await f.post(choice, held);
      assert.ok(
        scoped.status >= 400 && scoped.status < 500,
        "a stale unrestricted request cannot override the current empty role scope",
      );
      assert.deepEqual(await f.snapshot(), before);
    } finally {
      await f.close();
      await dropScratchOrgReporting(other.orgId);
    }
  },
);

test(
  "consumed time and a disabled workspace refuse the additional submission without a lifecycle stamp",
  enabled,
  async () => {
    const f = await fixture();
    try {
      await withBypassContext(() =>
        db.execute(sql`update time_entries set billing_status='billed',updated_at=now()
      where org_id=${f.org.orgId} and id=${f.chosen}`),
      );
      const before = await f.snapshot();
      const consumed = await f.post(await f.selections());
      assert.equal(consumed.status, 409, await consumed.clone().text());
      assert.deepEqual(await f.snapshot(), before);
      assert.equal((await f.read()).status, "approved");
      const held = await f.auth();
      const choice = await f.selections();
      await withBypassContext(() =>
        db.execute(sql`update orgs set settings=jsonb_set(settings,'{features,timeTracking}','false'::jsonb)
      where id=${f.org.orgId}`),
      );
      const disabled = await f.post(choice, held);
      assert.equal(disabled.status, 404, await disabled.clone().text());
      assert.deepEqual(await f.snapshot(), before);
      const header = await withOrgContext(
        f.org.orgId,
        async () =>
          (
            await db.execute<{ status: string }>(
              sql`
      select status from timesheet_weeks where org_id=${f.org.orgId} and id=${f.header}`,
              "objects",
            )
          )[0],
      );
      assert.equal(header?.status, "approved");
    } finally {
      await f.close();
    }
  },
);

test(
  "concurrent additional submissions converge on one native lifecycle and one selection audit",
  enabled,
  async () => {
    const f = await fixture();
    try {
      const choice = await f.selections();
      const responses = await Promise.all([f.post(choice), f.post(choice)]);
      assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
      const audit = await withOrgContext(
        f.org.orgId,
        async () =>
          (
            await db.execute<{ count: number }>(
              sql`
      select count(*)::int as count from audit_log where org_id=${f.org.orgId} and row_id=${f.header}
        and changes->>'event'='additional_time_submitted'`,
              "objects",
            )
          )[0]!.count,
      );
      assert.equal(audit, 1);
      assert.deepEqual(
        (await f.read()).pendingEntries!.map((entry) => entry.id),
        [f.untouched],
      );
    } finally {
      await f.close();
    }
  },
);

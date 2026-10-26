import {
  configureTimesheetReviewFixture,
  decideTimesheetFixture,
} from "../../../../testing/timesheet-flows";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  db,
  withBypassContext,
  withOrgContext,
  withOrgTransaction,
} from "@openbooks/engine/platform/db";
import { correctUnapprovedTimeType } from "@openbooks/engine/projects/time-type-correction";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrgReporting,
} from "@openbooks/engine/testing/fixtures";
import { resolveAuthzByUserId, type Authz } from "../../../../lib/authz-core";
import { withAuthzContext } from "../../../../lib/authz-context";
import {
  createFieldTicket,
  loadFieldTicket,
  saveCrewGrid,
  submitFieldTicket,
} from "../../../../lib/field-tickets";
import { loadWeek, loadPickers } from "../_lib";
import { POST } from "./route";
import { POST as submit } from "../submit/route";

import { PUT as save } from "../route";

const enabled = { skip: !process.env.OPENBOOKS_DB_URL };
const WEEK = "2026-07-12";
async function fixture() {
  const org = await withBypassContext(() => createScratchOrg());
  const actor = await withBypassContext(() =>
    createScratchUser(org.orgId, "Time classifier", "time-classifier"),
  );
  const employee = randomUUID(),
    project = randomUUID(),
    regular = randomUUID(),
    overtime = randomUUID(),
    prior = randomUUID();
  await withBypassContext(async () => {
    await db.execute(sql`update app_roles set permissions='["time.read","time.manage","time.approve","projects.read","gl.post"]'::jsonb
      where org_id=${org.orgId} and key='time-classifier'`);
    await db.execute(
      sql`update orgs set settings=settings || ${JSON.stringify({
        features: { projects: true, fieldTickets: true, timeTracking: true },
        laborCosting: { mode: "post", hoursPerDay: "8", annualHours: "2080", components: [] },
        controlAccounts: {
          ar: org.accounts.ar,
          ap: org.accounts.ap,
          bank: org.accounts.bank,
          laborWip: org.accounts.cogs,
          laborClearing: org.accounts.clearing,
        },
      })}::jsonb where id=${org.orgId}`,
    );
    await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active,custom)
      values(${employee},${org.orgId},'employee','Source time worker',${org.subsidiaryId},true,'{}'::jsonb)`);
    await db.execute(
      sql`insert into employee_roles(id,org_id,party_id,is_active) values(${randomUUID()},${org.orgId},${employee},true)`,
    );
    await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active,custom)
      values(${project},${org.orgId},${org.subsidiaryId},'TIME','Classification project',${org.customerId},'active',true,'{}'::jsonb)`);
    await db.execute(sql`insert into time_types(id,org_id,name,classification,cost_multiplier,bill_multiplier,show_on_field_ticket)
      values(${regular},${org.orgId},'Regular','regular','1','1',true),(${overtime},${org.orgId},'Overtime','overtime','1.5','1.5',true)`);
    await db.execute(sql`insert into labor_cost_rates(org_id,employee_party_id,currency,rate,basis,effective_from,is_active)
      values(${org.orgId},${employee},'CAD','30','hour','2026-01-01',true)`);
    await db.execute(
      sql`update items set default_rate='100' where org_id=${org.orgId} and id=${org.items.service}`,
    );
  });
  const inOrg = <T>(fn: () => Promise<T>) => withOrgContext(org.orgId, fn);
  const ticket = await inOrg(async () => {
    const created = await createFieldTicket(org.orgId, actor, {
      projectId: project,
      date: "2026-07-14",
      period: "daily",
      allowedSubsidiaryIds: null,
    });
    const loaded = await loadFieldTicket(org.orgId, created.id);
    await saveCrewGrid(
      org.orgId,
      actor,
      created.id,
      [
        {
          employeePartyId: employee,
          itemId: org.items.service,
          timeTypeId: regular,
          hours: { "2026-07-14": "2" },
        },
      ],
      loaded.revision,
    );
    await submitFieldTicket(
      org.orgId,
      actor,
      created.id,
      (await loadFieldTicket(org.orgId, created.id)).revision,
    );
    assert.equal((await loadFieldTicket(org.orgId, created.id)).status, "approved");
    return created.id;
  });
  const read = () => inOrg(() => loadWeek(org.orgId, employee, WEEK));
  const first = await read();
  const entry = first.pendingEntries!.find((row) => row.fieldTicketId === ticket)!.id;
  await withBypassContext(async () => {
    await db.execute(sql`update timesheet_weeks set status='approved',approved_by=${actor},approved_at=now()
      where org_id=${org.orgId} and id=${first.weekId}`);
    await db.execute(sql`insert into time_entries(id,org_id,employee_party_id,worked_on,hours,time_type_id,project_id,status,
      is_billable,costing_basis,custom,created_by,updated_by,approved_by,approved_at)
      values(${prior},${org.orgId},${employee},'2026-07-13','8',${regular},${project},'approved',false,'actual','{}'::jsonb,${actor},${actor},${actor},now())`);
  });
  await configureTimesheetReviewFixture(org.orgId, actor, false);
  const authority = () =>
    inOrg(async () => {
      const result = await resolveAuthzByUserId(org.orgId, actor);
      assert.ok(result);
      return result;
    });
  const request = async () => {
    const row = (await read()).pendingEntries!.find((row) => row.id === entry)!;
    const types = await inOrg(() => loadPickers(org.orgId, employee, null));
    return {
      employeePartyId: employee,
      weekStart: WEEK,
      entryId: entry,
      expectedUpdatedAt: row.updatedAt,
      timeTypeId: overtime,
      timeTypeUpdatedAt: types.timeTypes.find((type) => type.value === overtime)!.updatedAt!,
      commandId: randomUUID(),
      reason: "Correct the reviewed worked-time classification before approval",
    };
  };
  type Body = Awaited<ReturnType<typeof request>>;
  const call = async (body: Body, held?: Authz) =>
    inOrg(async () =>
      withAuthzContext(held ?? (await authority()), () =>
        POST(
          new Request("http://time.local/api/timesheets/time-type", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
        ),
      ),
    );
  const snapshots = () =>
    inOrg(async () => ({
      time: await db.execute<{ id: string; raw: string }>(
        sql`select id,to_jsonb(t)::text as raw from time_entries t where org_id=${org.orgId} order by id`,
        "objects",
      ),
      ticket: await db.execute<{ raw: string }>(
        sql`select to_jsonb(l)::text as raw from field_ticket_labor_lines l where org_id=${org.orgId} and field_ticket_id=${ticket} order by id`,
        "objects",
      ),
      header: await db.execute<{ raw: string }>(
        sql`select to_jsonb(w)::text as raw from timesheet_weeks w where org_id=${org.orgId} order by id`,
        "objects",
      ),
      journals: (
        await db.execute<{ n: number }>(
          sql`select count(*)::int as n from journal_entries where org_id=${org.orgId}`,
          "objects",
        )
      )[0]!.n,
      audits: (
        await db.execute<{ n: number }>(
          sql`select count(*)::int as n from audit_log where org_id=${org.orgId} and changes->>'event'='time_type_corrected'`,
          "objects",
        )
      )[0]!.n,
    }));
  const cleanup = () => dropScratchOrgReporting(org.orgId);
  return {
    org,
    actor,
    employee,
    project,
    regular,
    overtime,
    prior,
    ticket,
    entry,
    inOrg,
    read,
    authority,
    request,
    call,
    snapshots,
    cleanup,
  };
}

test(
  "native classification retains ticket evidence and stable time identity; separate approval costs the corrected type",
  enabled,
  async () => {
    const f = await fixture();
    try {
      const before = await f.snapshots(),
        body = await f.request();
      const response = await f.call(body);
      assert.equal(response.status, 200, await response.clone().text());
      const after = await f.snapshots();
      assert.deepEqual(after.ticket, before.ticket);
      assert.deepEqual(after.header, before.header);
      assert.equal(after.journals, before.journals);
      assert.equal(after.audits, before.audits + 1);
      assert.equal(
        after.time.find((row) => row.id === f.prior)!.raw,
        before.time.find((row) => row.id === f.prior)!.raw,
      );
      const old = JSON.parse(before.time.find((row) => row.id === f.entry)!.raw),
        current = JSON.parse(after.time.find((row) => row.id === f.entry)!.raw);
      for (const key of Object.keys(old).filter(
        (key) => !["time_type_id", "updated_at", "updated_by"].includes(key),
      ))
        assert.deepEqual(current[key], old[key], key);
      assert.equal(current.time_type_id, f.overtime);
      assert.equal(current.cost_rate, null);
      assert.equal(current.bill_rate, null);
      assert.equal(current.status, "draft");
      const replay = await f.call(body);
      assert.equal(replay.status, 200, await replay.clone().text());
      assert.deepEqual(await f.snapshots(), after);
      const payload = await f.read();
      assert.equal(
        payload.rows.find((row) => row.timeTypeId === f.overtime)!.immutable,
        true,
        "ticket time cannot be churned by a weekly grid save",
      );
      const selected = payload
        .pendingEntries!.filter((row) => row.id === f.entry)
        .map(({ id, updatedAt }) => ({ id, updatedAt }));
      const submitted = await f.inOrg(async () =>
        withAuthzContext(await f.authority(), () =>
          submit(
            new Request("http://time.local/api/timesheets/submit", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                employee: f.employee,
                week: WEEK,
                selections: selected,
                reason: "Approve the independently reviewed time classification",
              }),
            }),
          ),
        ),
      );
      assert.equal(submitted.status, 200, await submitted.clone().text());
      const approved = await f.inOrg(async () =>
        withAuthzContext(await f.authority(), () =>
          decideTimesheetFixture({
            orgId: f.org.orgId,
            ...{ employee: f.employee, week: WEEK },
            decision: "approved",
          }),
        ),
      );
      assert.equal(approved.status, 200, await approved.clone().text());
      const approvedRow = JSON.parse(
        (await f.snapshots()).time.find((row) => row.id === f.entry)!.raw,
      );
      assert.equal(approvedRow.cost_rate, 45);
      assert.equal(approvedRow.bill_rate, 150);
      assert.ok(approvedRow.cost_journal_entry_id);
      assert.deepEqual((await f.snapshots()).ticket, before.ticket);
    } finally {
      await f.cleanup();
    }
  },
);

test(
  "stale type/entry, live duty and scope revocation, submitted or consumed time refuse without mutation",
  enabled,
  async () => {
    const f = await fixture();
    try {
      const body = await f.request(),
        before = await f.snapshots(),
        held = await f.authority();
      for (const bad of [
        { ...body, expectedUpdatedAt: "2026-01-01T00:00:00.000000Z" },
        { ...body, timeTypeUpdatedAt: "2026-01-01T00:00:00.000000Z" },
        { ...body, timeTypeId: randomUUID() },
        { ...body, entryId: randomUUID() },
      ]) {
        const response = await f.call(bad);
        assert.equal(response.status, 409, await response.clone().text());
        assert.deepEqual(await f.snapshots(), before);
      }
      await withBypassContext(() =>
        db.execute(
          sql`update app_roles set permissions='["time.read","projects.read"]'::jsonb where org_id=${f.org.orgId} and key='time-classifier'`,
        ),
      );
      assert.ok((await f.call(body, held)).status >= 400);
      assert.deepEqual(await f.snapshots(), before);
      await withBypassContext(() =>
        db.execute(sql`update app_roles set permissions='["time.read","time.manage","projects.read"]'::jsonb,
      subsidiary_restriction='{"mode":"list","subsidiaryIds":[]}'::jsonb where org_id=${f.org.orgId} and key='time-classifier'`),
      );
      assert.ok((await f.call(body, held)).status >= 400);
      assert.deepEqual(await f.snapshots(), before);
      await withBypassContext(() =>
        db.execute(
          sql`update app_roles set subsidiary_restriction='{"mode":"all"}'::jsonb where org_id=${f.org.orgId} and key='time-classifier'`,
        ),
      );
      await withBypassContext(() =>
        db.execute(
          sql`update timesheet_weeks set status='submitted' where org_id=${f.org.orgId} and employee_party_id=${f.employee}`,
        ),
      );
      const submitted = await f.snapshots();
      assert.equal((await f.call(body, held)).status, 409);
      assert.deepEqual(await f.snapshots(), submitted);
      await withBypassContext(() =>
        db.execute(
          sql`update timesheet_weeks set status='rejected' where org_id=${f.org.orgId} and employee_party_id=${f.employee}`,
        ),
      );
      await withBypassContext(() =>
        db.execute(
          sql`update time_entries set cost_rate='30' where org_id=${f.org.orgId} and id=${f.entry}`,
        ),
      );
      const costed = await f.snapshots();
      assert.equal((await f.call(await f.request(), held)).status, 409);
      assert.deepEqual(await f.snapshots(), costed);
    } finally {
      await f.cleanup();
    }
  },
);

test(
  "same-command concurrency is once-only, an aborted transaction rolls back, and a weekly save preserves rejected ticket time",
  enabled,
  async () => {
    const f = await fixture();
    try {
      await withBypassContext(() =>
        db.execute(
          sql`update timesheet_weeks set status='rejected' where org_id=${f.org.orgId} and employee_party_id=${f.employee}`,
        ),
      );
      await withBypassContext(() =>
        db.execute(
          sql`update time_entries set status='rejected' where org_id=${f.org.orgId} and id=${f.entry}`,
        ),
      );
      const before = await f.snapshots(),
        body = await f.request();
      await assert.rejects(
        f.inOrg(() =>
          withOrgTransaction(f.org.orgId, async () => {
            await correctUnapprovedTimeType({
              ...body,
              orgId: f.org.orgId,
              actorId: f.actor,
              requestedScope: null,
            });
            throw new Error("Abort the enclosing transaction");
          }),
        ),
        /Abort the enclosing transaction/,
      );
      assert.deepEqual(await f.snapshots(), before);
      const responses = await Promise.all([f.call(body), f.call(body)]);
      assert.deepEqual(
        responses.map((response) => response.status),
        [200, 200],
      );
      const afterConcurrent = await f.snapshots();
      assert.equal(afterConcurrent.audits, before.audits + 1);
      const current = (await f.read()).pendingEntries!.find((row) => row.id === f.entry)!;
      const regular = (
        await f.inOrg(() => loadPickers(f.org.orgId, f.employee, null))
      ).timeTypes.find((type) => type.value === f.regular)!;
      // A non-API caller receives the same transaction and audit guarantee.
      const direct = await f.inOrg(() =>
        correctUnapprovedTimeType({
          ...body,
          orgId: f.org.orgId,
          actorId: f.actor,
          requestedScope: null,
          commandId: randomUUID(),
          expectedUpdatedAt: current.updatedAt,
          timeTypeId: f.regular,
          timeTypeUpdatedAt: regular.updatedAt!,
        }),
      );
      assert.deepEqual(direct, { changed: true, replayed: false });
      const after = await f.snapshots();
      assert.equal(after.audits, before.audits + 2);
      assert.deepEqual(after.ticket, before.ticket);
      assert.deepEqual(after.header, before.header);
      assert.equal(after.journals, before.journals);
      const payload = await f.read();
      const saved = await f.inOrg(async () =>
        withAuthzContext(await f.authority(), () =>
          save(
            new Request("http://time.local/api/timesheets", {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                employee: f.employee,
                week: WEEK,
                expectedRevision: payload.revision,
                rows: [],
              }),
            }),
          ),
        ),
      );
      assert.equal(saved.status, 200, await saved.clone().text());
      assert.deepEqual(
        (await f.snapshots()).time,
        after.time,
        "the grid does not delete a source ticket row or approved time",
      );
      assert.deepEqual((await f.snapshots()).ticket, after.ticket);
      const altered = { ...body, reason: "A different reason cannot reuse this command identity" };
      assert.equal((await f.call(altered)).status, 409);
    } finally {
      await f.cleanup();
    }
  },
);

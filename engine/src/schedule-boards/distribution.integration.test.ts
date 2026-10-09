import { ScopeNotFoundError } from '../organization/subsidiary-scope.ts';
import { scheduleBoardTimerGraph } from "../flows/schedule-board-adapter.ts";
import {
  runDueScheduledFlows,
  recoverLostScheduledFlows,
  FLOW_OCCURRENCE_STALE_MS,
} from "../flows/scheduled.ts";
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db, withBypassContext, withOrgTransaction } from '../platform/db.ts';
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrgReporting,
} from '../testing/fixtures.ts';
import { installEngineSeams } from '../composition/install.ts';
import { applyBoardChanges } from './entries.ts';
import { listBoards } from './boards.ts';
import { loadBoardWindow } from './window.ts';
import { saveResourceRecipient } from './resource-recipients.ts';
import {
  importSourceHistory,
  previewSourceHistory,
  sourceHistoryHash,
} from './source-history.ts';
import {
  previewScheduleDistribution,
  sendScheduleDistribution,
} from './distribution.ts';

const enabled = { skip: !process.env.OPENBOOKS_DB_URL };
const dates = { from: '2026-10-12', through: '2026-10-18' };
const personal = {
  visibility: 'personal' as const,
  everyone: true,
  subjectIds: [],
};
async function fixture(
  run: (f: {
    orgId: string;
    subsidiaryId: string;
    actorId: string;
    readerId: string;
    boardId: string;
    ana: string;
    ben: string;
    flow: (trigger?: string) => Promise<void>;
  }) => Promise<void>,
) {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const ids = await withBypassContext(async () => {
      const actorId = await createScratchUser(
          org.orgId,
          'Scheduler',
          'scheduler',
        ),
        readerId = await createScratchUser(
          org.orgId,
          'Reader',
          'schedule-reader',
        );
      await db.execute(
        sql`update app_roles set permissions='["hrm.shifts.read","hrm.shifts.manage","hrm.shifts.approve","flows.manage","projects.read","projects.manage","admin.setup.manage"]'::jsonb where org_id=${org.orgId} and key='scheduler'`,
      );
      await db.execute(
        sql`update app_roles set permissions='["hrm.shifts.read"]'::jsonb where org_id=${org.orgId} and key='schedule-reader'`,
      );
      // A disposable relay configuration is resolved but never connected or drained.
      await db.execute(
        sql`update orgs set settings=jsonb_set(jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"hrm":true,"hrmShiftPlanning":true,"projects":true,"projectScheduling":true,"flows":true}'::jsonb),'{email}','{"enabled":true,"provider":"smtp","smtpHost":"relay.example.test","smtpPort":2525,"fromEmail":"schedule@example.test"}'::jsonb) where id=${org.orgId}`,
      );
      const person = async (name: string, email: string) => {
        const id = randomUUID();
        await db.execute(
          sql`insert into parties(id,org_id,kind,display_name,email,subsidiary_id,is_active) values(${id},${org.orgId},'person',${name},${email},${org.subsidiaryId},true)`,
        );
        await db.execute(
          sql`insert into employee_roles(org_id,party_id,is_active,hired_on) values(${org.orgId},${id},true,'2025-01-01')`,
        );
        return id;
      };
      const ana = await person('Ana Field', 'ana@example.test'),
        ben = await person('Ben Shop', 'ben@example.test'),
        boardId = randomUUID();
      await db.execute(
        sql`insert into schedule_boards(id,org_id,code,name,row_kind,views,default_view,time_zone,subsidiary_id) values(${boardId},${org.orgId},'PEOPLE','People schedule','people','{grid,targets,calendar,timeline}','grid','America/Toronto',${org.subsidiaryId})`,
      );
      return { actorId, readerId, ana, ben, boardId };
    });
    installEngineSeams();
    const actor = { orgId: org.orgId, actorId: ids.actorId };
    const booked = await applyBoardChanges({
      ...actor,
      boardId: ids.boardId,
      changes: [
        {
          op: 'create',
          id: randomUUID(),
          workerPartyId: ids.ana,
          onDate: dates.from,
          target: null,
          span: { mode: 'day' },
          notes: 'PRIVATE operator note',
        },
      ],
    });
    assert.equal(booked.results[0]?.ok, true);
    const payload = { id: 1, label: 'SHOP/ N' };
    const batch = {
      sourceSystem: 'LegacyPlanning',
      sourceDataset: 'manpower',
      captureHash: sourceHistoryHash([payload]),
      rows: [
        {
          sourceKey: '1',
          sourceHash: sourceHistoryHash(payload),
          payload,
          disposition: 'recorded' as const,
          boardId: ids.boardId,
          workerPartyId: ids.ben,
          onDate: dates.from,
          label: payload.label,
          result: null,
          notes: 'PRIVATE source note',
          visibleInSource: true,
          linkedEntryId: null,
          expectedPriorId: null,
          reason: 'Adopt literal date evidence',
        },
      ],
    };
    await importSourceHistory(
      actor,
      batch,
      (await previewSourceHistory(actor, batch)).approvalHash,
    );
    const flow = async (trigger = 'on_submit') =>
      withBypassContext(async () => {
        const graph = {
          schemaVersion: 1,
          nodes: [
            {
              id: 'trigger',
              position: { x: 0, y: 0 },
              data: { kind: 'trigger', trigger: { trigger } },
            },
            {
              id: 'email',
              position: { x: 200, y: 0 },
              data: {
                kind: 'action',
                action: { action: 'distribute_schedule' },
              },
            },
          ],
          edges: [
            {
              id: 'next',
              source: 'trigger',
              target: 'email',
              sourceHandle: 'next',
            },
          ],
        };
        await db.execute(
          sql`insert into flows(org_id,name,subject_kind,enabled,graph) values(${org.orgId},'Reviewed schedule','schedule_distribution',true,${JSON.stringify(graph)}::jsonb)`,
        );
      });
    await run({
      orgId: org.orgId,
      subsidiaryId: org.subsidiaryId,
      ...ids,
      flow,
    });
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
}
const preview = (
  f: { orgId: string; actorId: string; boardId: string },
  audience = personal,
) =>
  previewScheduleDistribution(
    { orgId: f.orgId, actorId: f.actorId },
    f.boardId,
    dates.from,
    dates.through,
    audience,
  );
const issue = (
  f: { orgId: string; actorId: string; boardId: string },
  p: Awaited<ReturnType<typeof preview>>,
  key = randomUUID(),
) =>
  sendScheduleDistribution(
    { orgId: f.orgId, actorId: f.actorId },
    {
      boardId: f.boardId,
      ...dates,
      audience: p.audience,
      version: p.version,
      reason: 'Reviewed weekly schedule',
      key,
    },
  );
const counts = async (orgId: string) =>
  withOrgTransaction(orgId, async () => ({
    requests: (
      await db.execute<{ n: number }>(
        sql`select count(*)::int n from schedule_distributions`,
      )
    ).rows[0]!.n,
    outbox: (
      await db.execute<{ n: number }>(
        sql`select count(*)::int n from scheduler_outbox where kind='flow_email'`,
      )
    ).rows[0]!.n,
  }));

test(
  'personal previews retain literal dates and unknown hours without private notes or peer rows',
  enabled,
  () =>
    fixture(async (f) => {
      const p = await preview(f);
      assert.equal(p.refusals.length, 0);
      assert.equal(p.recipients.length, 2);
      const ana = p.recipients.find((r) => r.partyId === f.ana)!,
        ben = p.recipients.find((r) => r.partyId === f.ben)!;
      assert.deepEqual(
        [...new Set(ana.lines.map((l) => l.subject))],
        ["Ana Field"],
      );
      assert.deepEqual(
        [...new Set(ben.lines.map((l) => l.subject))],
        ['Ben Shop'],
      );
      assert.equal(ben.lines[0]!.assignment, 'SHOP/ N');
      assert.equal(ben.lines[0]!.hours, 'Hours unknown');
      assert.ok(!JSON.stringify(p).includes('PRIVATE'));
      assert.deepEqual(await counts(f.orgId), { requests: 0, outbox: 0 });
      await assert.rejects(
        previewScheduleDistribution(
          { orgId: f.orgId, actorId: f.readerId },
          f.boardId,
          dates.from,
          dates.through,
          personal,
        ),
      );
    }),
);

test(
  'foreign-organization boards cannot be previewed or create recipient/outbox evidence',
  enabled,
  () =>
    fixture(async (f) => {
      const foreign = await withBypassContext(() => createScratchOrg());
      try {
        const boardId = randomUUID();
        await withBypassContext(() =>
          db.execute(
            sql`insert into schedule_boards(id,org_id,code,name,row_kind,views,default_view,time_zone,subsidiary_id) values(${boardId},${foreign.orgId},'FOREIGN','Private schedule','people','{grid}','grid','America/Toronto',${foreign.subsidiaryId})`,
          ),
        );
        await assert.rejects(
          previewScheduleDistribution(
            f,
            boardId,
            dates.from,
            dates.through,
            personal,
          ),
        );
        assert.deepEqual(await counts(f.orgId), { requests: 0, outbox: 0 });
        assert.deepEqual(await counts(foreign.orgId), {
          requests: 0,
          outbox: 0,
        });
      } finally {
        await withBypassContext(() => dropScratchOrgReporting(foreign.orgId));
      }
    }),
);

test(
  'whole-board reports require explicit scope policy, then include everyone for every reviewed recipient',
  enabled,
  () =>
    fixture(async (f) => {
      const audience = { ...personal, visibility: 'board' as const };
      await assert.rejects(
        previewScheduleDistribution(
          f,
          f.boardId,
          dates.from,
          dates.through,
          audience,
        ),
        /Whole-board/,
      );
      await withBypassContext(() =>
        db.execute(
          sql`update schedule_boards set distribution_visibility='board' where id=${f.boardId}`,
        ),
      );
      const p = await previewScheduleDistribution(
        f,
        f.boardId,
        dates.from,
        dates.through,
        audience,
      );
      assert.equal(p.recipients.length, 2);
      for (const recipient of p.recipients)
        assert.deepEqual(
          new Set(recipient.lines.map((l) => l.subject)),
          new Set(['Ana Field', 'Ben Shop']),
        );
      await withBypassContext(() =>
        db.execute(
          sql`update parties set subsidiary_id=null where id=${f.ben}`,
        ),
      );
      await assert.rejects(
        previewScheduleDistribution(
          f,
          f.boardId,
          dates.from,
          dates.through,
          audience,
        ),
        /crosses/,
      );
    }),
);

test(
  'explicit send uses real native Flow lineage and immutable outbox snapshots; replay queues nothing twice',
  enabled,
  () =>
    fixture(async (f) => {
      await f.flow();
      const p = await preview(f),
        key = randomUUID();
      const sent = await issue(f, p, key);
      assert.equal(sent.status, 'queued');
      assert.equal(sent.replayed, false);
      const evidence = await withOrgTransaction(f.orgId, async () => ({
        request: (
          await db.execute<{ flow_run_id: string; created_by: string }>(
            sql`select flow_run_id,created_by from schedule_distributions where id=${sent.id}`,
          )
        ).rows[0]!,
        outbox: (
          await db.execute<{
            subject_id: string;
            payload: {
              to: string[];
              html: string;
              meta: { distributionId: string; version: string };
            };
          }>(
            sql`select subject_id,payload from scheduler_outbox where kind='flow_email' order by id`,
          )
        ).rows,
        audits: (
          await db.execute(
            sql`select id from audit_log where table_name='schedule_distributions' and row_id=${sent.id}`,
          )
        ).rows,
      }));
      assert.equal(evidence.request.created_by, f.actorId);
      assert.equal(evidence.outbox.length, 2);
      assert.equal(evidence.audits.length, 2);
      for (const row of evidence.outbox) {
        assert.equal(row.subject_id, evidence.request.flow_run_id);
        assert.equal(row.payload.to.length, 1);
        assert.equal(row.payload.meta.distributionId, sent.id);
        assert.equal(row.payload.meta.version, p.version);
        assert.ok(!row.payload.html.includes('PRIVATE'));
      }
      await withBypassContext(() =>
        db.execute(
          sql`update parties set email='new-address@example.test' where id=${f.ana}`,
        ),
      );
      assert.deepEqual(await issue(f, p, key), { ...sent, replayed: true });
      assert.equal(sent.runId, evidence.request.flow_run_id);
      assert.ok(sent.flowId);
      assert.deepEqual(await counts(f.orgId), { requests: 1, outbox: 2 });
      await assert.rejects(
        withOrgTransaction(f.orgId, () =>
          db.execute(
            sql`update schedule_distribution_recipients set email='forged@example.test' where distribution_id=${sent.id}`,
          ),
        ),
        (e) =>
          JSON.stringify((e as { cause?: unknown }).cause ?? e).includes(
            '23514',
          ) || String(e).includes('immutable'),
      );
    }),
);

test(
  'missing contact/provider, changed version and absent authored Flow refuse without partial issuance',
  enabled,
  () =>
    fixture(async (f) => {
      const p = await preview(f);
      await assert.rejects(issue(f, p), /No enabled/);
      assert.deepEqual(await counts(f.orgId), { requests: 0, outbox: 0 });
      await f.flow();
      await withBypassContext(() =>
        db.execute(sql`update parties set email=null where id=${f.ben}`),
      );
      const missing = await preview(f);
      assert.ok(missing.refusals.some((s) => s.includes('Ben Shop')));
      await assert.rejects(issue(f, missing), /valid email/);
      await assert.rejects(issue(f, p), /changed after preview/);
      assert.deepEqual(await counts(f.orgId), { requests: 0, outbox: 0 });
      await withBypassContext(() =>
        db.execute(
          sql`update orgs set settings=jsonb_set(settings,'{email,enabled}','false'::jsonb) where id=${f.orgId}`,
        ),
      );
      assert.ok(
        (await preview(f)).refusals.some((s) => s.includes('provider')),
      );
    }),
);

test(
  'concurrent identical sends preserve one request and one delivery per recipient',
  enabled,
  () =>
    fixture(async (f) => {
      await f.flow();
      const p = await preview(f),
        key = randomUUID();
      const results = await Promise.allSettled([
        issue(f, p, key),
        issue(f, p, key),
      ]);
      assert.ok(results.some((r) => r.status === 'fulfilled'));
      for (const r of results)
        if (r.status === 'rejected')
          assert.match(String(r.reason), /changed|retry|Reload|serializ/i);
      assert.deepEqual(await counts(f.orgId), { requests: 1, outbox: 2 });
    }),
);

test(
  'an explicitly authored update Flow distributes saved bookings while a provider refusal leaves bookings saved',
  enabled,
  () =>
    fixture(async (f) => {
      await f.flow('on_update');
      await withBypassContext(() =>
        db.execute(
          sql`update orgs set settings=jsonb_set(settings,'{email,enabled}','false'::jsonb) where id=${f.orgId}`,
        ),
      );
      const result = await applyBoardChanges({
        ...f,
        changes: [
          {
            op: 'create',
            id: randomUUID(),
            workerPartyId: f.ben,
            onDate: '2026-10-13',
            target: null,
            span: { mode: 'day' },
          },
        ],
      });
      assert.equal(result.results[0]?.ok, true);
      assert.equal(result.distributionRefusals.length, 1);
      assert.deepEqual(await counts(f.orgId), { requests: 1, outbox: 0 });
      const failed = await withOrgTransaction(f.orgId, () =>
        db.execute<{ status: string }>(
          sql`select status from flow_runs where subject_kind='schedule_distribution'`,
        ),
      );
      assert.equal(failed.rows[0]?.status, 'failed');
    }),
);

test(
  'project-owned boards and task boards never enter the general picker but remain reachable by exact project',
  enabled,
  () =>
    fixture(async (f) => {
      const projectId = randomUUID(),
        id = randomUUID();
      await withBypassContext(async () => {
        await db.execute(
          sql`insert into projects(id,org_id,subsidiary_id,code,name,status,is_active) values(${projectId},${f.orgId},${f.subsidiaryId},'PLAN','Project','active',true)`,
        );
        await db.execute(
          sql`insert into schedule_boards(id,org_id,code,name,row_kind,views,default_view,time_zone,project_id) values(${id},${f.orgId},'PROJECT','Project crew','people','{grid}','grid','America/Toronto',${projectId})`,
        );
      });
      assert.equal(
        (await listBoards(f, { generalOnly: true })).some((b) => b.id === id),
        false,
      );
      assert.deepEqual(
        (await listBoards(f, { projectId })).map((b) => b.id),
        [id],
      );
      assert.deepEqual(
        await listBoards({ ...f, actorId: f.readerId }, { projectId }),
        [],
      );
      await assert.rejects(
        loadBoardWindow({ ...f, actorId: f.readerId, boardId: id, ...dates }),
      );
    }),
);

test(
  'resource recipient associations use native contacts, revisions and audits without exposing unassociated resources',
  enabled,
  () =>
    fixture(async (f) => {
      const boardId = randomUUID(),
        locationId = randomUUID();
      await withBypassContext(async () => {
        await db.execute(
          sql`insert into locations(id,org_id,name,subsidiary_id,is_active) values(${locationId},${f.orgId},'Service bay',${f.subsidiaryId},true)`,
        );
        await db.execute(
          sql`insert into schedule_boards(id,org_id,code,name,row_kind,resource_kind,views,default_view,time_zone,subsidiary_id) values(${boardId},${f.orgId},'BAYS','Bays','resources','location','{grid}','grid','America/Toronto',${f.subsidiaryId})`,
        );
      });
      const booking = await applyBoardChanges({
        ...f,
        boardId,
        changes: [
          {
            op: 'create',
            id: randomUUID(),
            subject: { kind: 'location', id: locationId },
            onDate: dates.from,
            target: null,
            span: { mode: 'day' },
          },
        ],
      });
      assert.equal(booking.results[0]?.ok, true);
      const before = await previewScheduleDistribution(
        f,
        boardId,
        dates.from,
        dates.through,
        personal,
      );
      assert.equal(before.recipients.length, 0);
      assert.equal(before.refusals.length, 1);
      const input = {
        boardId,
        equipmentUnitId: null,
        resourceLocationId: locationId,
        partyId: f.ana,
        isActive: true,
        reason: 'Associate authoritative contact',
      };
      const saved = await saveResourceRecipient(f, input),
        revision = Number((saved.record as { revision: number }).revision);
      assert.equal(revision, 1);
      const p = await previewScheduleDistribution(
        f,
        boardId,
        dates.from,
        dates.through,
        personal,
      );
      assert.equal(p.refusals.length, 0);
      assert.equal(p.recipients[0]!.partyId, f.ana);
      assert.equal(p.recipients[0]!.lines[0]!.subject, 'Service bay');
      await assert.rejects(
        saveResourceRecipient(f, {
          ...input,
          id: saved.id,
          expectedRevision: 99,
          partyId: f.ben,
        }),
        /changed/,
      );
      await saveResourceRecipient(f, {
        ...input,
        id: saved.id,
        expectedRevision: 1,
        partyId: f.ben,
        reason: 'Change responsible native contact',
      });
      assert.equal(
        (
          await previewScheduleDistribution(
            f,
            boardId,
            dates.from,
            dates.through,
            personal,
          )
        ).recipients[0]!.partyId,
        f.ben,
      );
      const audits = await withOrgTransaction(f.orgId, () =>
        db.execute<{ n: number }>(
          sql`select count(*)::int n from audit_log where table_name='schedule_resource_recipients' and row_id=${saved.id}`,
        ),
      );
      assert.equal(audits.rows[0]!.n, 2);
      await assert.rejects(
        saveResourceRecipient(
          { ...f, actorId: f.readerId },
          { ...input, expectedRevision: 2, id: saved.id },
        ),
      );
    }),
);

async function extraContact(
  f: { orgId: string; subsidiaryId: string },
  name: string,
  email: string,
) {
  const id = randomUUID();
  await withBypassContext(() =>
    db.execute(
      sql`insert into parties(id,org_id,kind,display_name,email,subsidiary_id,is_active) values(${id},${f.orgId},'person',${name},${email},${f.subsidiaryId},true)`,
    ),
  );
  return id;
}

test(
  "contacts-only full report stores native recipients without manufacturing employee subjects or resolving an automatic roster",
  enabled,
  () =>
    fixture(async (f) => {
      const contact = await extraContact(
        f,
        "Additional coordinator",
        "coordinator@example.test",
      );
      await withBypassContext(() =>
        db.execute(
          sql`update schedule_boards set distribution_visibility='board' where id=${f.boardId}`,
        ),
      );
      const audience = {
        visibility: "board" as const,
        recipientMode: "selected" as const,
        everyone: false,
        subjectIds: [],
        additionalPartyIds: [contact],
        includePdf: true,
      };
      const p = await previewScheduleDistribution(
        f,
        f.boardId,
        dates.from,
        dates.through,
        audience,
      );
      assert.equal(p.recipients.length, 1);
      assert.deepEqual(p.recipients[0]!.subjects, []);
      assert.deepEqual(
        new Set(p.recipients[0]!.lines.map((line) => line.subject)),
        new Set(["Ana Field", "Ben Shop"]),
      );
      await f.flow();
      const key = randomUUID();
      const sent = await issue(f, p, key);
      const rows = await withOrgTransaction(f.orgId, () =>
        db.execute<{
          party_id: string;
          worker_party_id: string | null;
          equipment_unit_id: string | null;
          resource_location_id: string | null;
          report: { attachments: { content: string }[] };
        }>(
          sql`select party_id,worker_party_id,equipment_unit_id,resource_location_id,report from schedule_distribution_recipients where distribution_id=${sent.id}`,
        ),
      );
      assert.equal(rows.rows.length, 1);
      assert.equal(rows.rows[0]!.party_id, contact);
      assert.equal(rows.rows[0]!.worker_party_id, null);
      assert.equal(rows.rows[0]!.equipment_unit_id, null);
      assert.equal(rows.rows[0]!.resource_location_id, null);
      assert.ok(
        Buffer.from(rows.rows[0]!.report.attachments[0]!.content, "base64")
          .subarray(0, 5)
          .equals(Buffer.from("%PDF-")),
      );
      assert.equal(
        (
          await withOrgTransaction(f.orgId, () =>
            db.execute(
              sql`select id from employee_roles where party_id=${contact}`,
            ),
          )
        ).rows.length,
        0,
      );
      assert.equal((await issue(f, p, key)).replayed, true);
      assert.deepEqual(await counts(f.orgId), { requests: 1, outbox: 1 });
      await assert.rejects(
        previewScheduleDistribution(f, f.boardId, dates.from, dates.through, {
          ...audience,
          additionalPartyIds: [],
        }),
        /Choose between/,
      );
      await assert.rejects(
        previewScheduleDistribution(f, f.boardId, dates.from, dates.through, {
          ...audience,
          visibility: "personal",
        }),
        error => error instanceof Error && /audience or additional contacts/.test(error.message) && "remedy" in error && /whole-board/.test(String(error.remedy)),
      );
    }),
);

test(
  "automatic current membership excludes former employees from email but retains their historical full report; combined roles deduplicate native mailboxes",
  enabled,
  () =>
    fixture(async (f) => {
      const contact = await extraContact(
        f,
        "Native role contact",
        "BEN@EXAMPLE.TEST",
      );
      const user = await withBypassContext(() =>
        createScratchUser(f.orgId, "Delivery group", "schedule-notices"),
      );
      await withBypassContext(async () => {
        await db.execute(
          sql`update users set party_id=${contact} where id=${user}`,
        );
        await db.execute(
          sql`update schedule_boards set distribution_visibility='board' where id=${f.boardId}`,
        );
        await db.execute(
          sql`update employee_roles set is_active=false where party_id=${f.ana}`,
        );
      });
      const audience = {
        visibility: "board" as const,
        recipientMode: "automatic" as const,
        everyone: true,
        subjectIds: [],
        cohort: "scope" as const,
      };
      const automatic = await previewScheduleDistribution(
        f,
        f.boardId,
        dates.from,
        dates.through,
        audience,
      );
      assert.deepEqual(
        automatic.recipients.map((recipient) => recipient.partyId),
        [f.ben],
      );
      assert.ok(automatic.excludedHistoricalSubjects!.includes(f.ana));
      assert.ok(
        automatic.recipients[0]!.lines.some((line) => line.subjectId === f.ana),
      );
      const combined = await previewScheduleDistribution(
        f,
        f.boardId,
        dates.from,
        dates.through,
        {
          ...audience,
          recipientMode: "combined",
          additionalRoleKeys: ["schedule-notices"],
        },
      );
      assert.equal(combined.recipients.length, 1);
      assert.deepEqual(
        new Set(combined.recipients[0]!.contacts.map((contact) => contact.id)),
        new Set([f.ben, contact]),
      );
      await f.flow();
      await issue(f, combined);
      assert.deepEqual(await counts(f.orgId), { requests: 1, outbox: 1 });
      await withBypassContext(async () => {
        const replacementRole = randomUUID();
        await db.execute(sql`insert into app_roles(id,org_id,key,name,permissions) values(${replacementRole},${f.orgId},'unrelated-explicit-role','Unrelated explicit role','[]'::jsonb)`);
        await db.execute(sql`insert into role_assignments(org_id,user_id,role_id) values(${f.orgId},${user},${replacementRole})`);
        await db.execute(sql`delete from role_assignments where org_id=${f.orgId} and user_id=${user} and role_id in(select id from app_roles where org_id=${f.orgId} and key='schedule-notices')`);
      });
      await assert.rejects(
        previewScheduleDistribution(f, f.boardId, dates.from, dates.through, {
          ...audience,
          recipientMode: "combined",
          additionalRoleKeys: ["schedule-notices"],
        }),
        /no active recipients/,
      );
    }),
);

async function timer(
  f: { orgId: string; actorId: string; boardId: string },
  includePdf = true,
) {
  const policy = {
    operatorId: f.actorId,
    timeZone: "America/Toronto",
    days: 14,
    anchor: "week",
    weekStartsOn: 0,
    visibility: "board",
    recipientMode: "automatic",
    cohort: "scope",
    additionalPartyIds: [],
    includePdf,
    message: "Reviewed native schedule",
  };
  const id = randomUUID();
  await withBypassContext(async () => {
    await db.execute(
      sql`update orgs set env_kind='production' where id=${f.orgId}`,
    );
    await db.execute(
      sql`update schedule_boards set distribution_visibility='board',automatic_delivery_policy=${JSON.stringify(policy)}::jsonb,updated_by=${f.actorId} where id=${f.boardId}`,
    );
    await db.execute(
      sql`insert into flows(id,org_id,name,subject_kind,enabled,graph,created_at,created_by,updated_by) values(${id},${f.orgId},'Configured delivery','schedule_board',true,${JSON.stringify(scheduleBoardTimerGraph(f.boardId, "America/Toronto", true))}::jsonb,'2026-10-11T00:00:00Z',${f.actorId},${f.actorId})`,
    );
  });
  return id;
}

test(
  "two configured native clock occurrences deliver unchanged board versions twice, with actual lineage and recovery replay sending nothing twice",
  enabled,
  () =>
    fixture(async (f) => {
      const flowId = await timer(f);
      const result = await runDueScheduledFlows(
        new Date("2026-10-12T20:00:00Z"),
      );
      assert.equal(result.errors, 0);
      assert.equal(result.fired, 2);
      assert.deepEqual(await counts(f.orgId), { requests: 2, outbox: 4 });
      const rows = await withOrgTransaction(f.orgId, () =>
        db.execute<{
          occurred_at: string;
          status: string;
          created_by: string;
          trigger: string;
          subject_kind: string;
        }>(
          sql`select o.occurred_at::text,o.status,r.created_by,r.trigger,r.subject_kind from flow_scheduled_occurrences o join flow_runs r on r.org_id=o.org_id and r.flow_id=o.flow_id and r.context->'scheduledOccurrence'->>'occurredAt'=to_char(o.occurred_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') where o.flow_id=${flowId} order by o.occurred_at`,
        ),
      );
      assert.equal(rows.rows.length, 2);
      for (const row of rows.rows) {
        assert.equal(row.status, "fired");
        assert.equal(row.created_by, f.actorId);
        assert.equal(row.subject_kind, "schedule_board");
        assert.equal(row.trigger, "scheduled");
      }
      assert.ok(rows.rows[0]!.occurred_at.startsWith("2026-10-12 10:00"));
      assert.ok(rows.rows[1]!.occurred_at.startsWith("2026-10-12 18:30"));
      assert.equal(
        (await runDueScheduledFlows(new Date("2026-10-12T20:00:00Z"))).fired,
        0,
      );
      await withBypassContext(() =>
        db.execute(
          sql`update flow_scheduled_occurrences set status='firing',updated_at=now()-interval '1 day' where flow_id=${flowId}`,
        ),
      );
      await recoverLostScheduledFlows(
        new Date(Date.now() + FLOW_OCCURRENCE_STALE_MS + 60000),
      );
      assert.deepEqual(await counts(f.orgId), { requests: 2, outbox: 4 });
      const versions = await withOrgTransaction(f.orgId, () =>
        db.execute<{ n: number }>(
          sql`select count(distinct version)::int n from schedule_distributions`,
        ),
      );
      assert.equal(
        versions.rows[0]!.n,
        1,
        "deliberate occurrences may deliver the same reviewed board version",
      );
    }),
);

test(
  "inactive operators and fresh permission revocation produce native failed runs with no ghost-green delivery",
  enabled,
  () =>
    fixture(async (f) => {
      const flowId = await timer(f, false);
      await withBypassContext(() =>
        db.execute(sql`update users set is_active=false where id=${f.actorId}`),
      );
      const result = await runDueScheduledFlows(
        new Date("2026-10-12T10:01:00Z"),
      );
      assert.equal(result.errors, 1);
      assert.deepEqual(await counts(f.orgId), { requests: 0, outbox: 0 });
      const failed = await withOrgTransaction(f.orgId, () =>
        db.execute<{ status: string; error: string }>(
          sql`select status,error from flow_runs where flow_id=${flowId}`,
        ),
      );
      assert.equal(failed.rows[0]!.status, "failed");
      assert.match(failed.rows[0]!.error, /inactive|unavailable/);
      await withBypassContext(async () => {
        await db.execute(
          sql`update users set is_active=true where id=${f.actorId}`,
        );
        await db.execute(
          sql`update app_roles set permissions='["hrm.shifts.read","hrm.shifts.manage"]'::jsonb where org_id=${f.orgId} and key='scheduler'`,
        );
      });
      assert.equal(
        (await runDueScheduledFlows(new Date("2026-10-12T20:00:00Z"))).errors,
        1,
      );
      assert.deepEqual(await counts(f.orgId), { requests: 0, outbox: 0 });
    }),
);

test(
  "requested PDF rendering failure rolls back reviewed report snapshots and never queues a partial HTML-only send",
  enabled,
  () =>
    fixture(async (f) => {
      const payload = { id: 99, label: "X\n".repeat(450) };
      const batch = {
        sourceSystem: "LegacyPlanning",
        sourceDataset: "manpower",
        captureHash: sourceHistoryHash([payload]),
        rows: [
          {
            sourceKey: "99",
            sourceHash: sourceHistoryHash(payload),
            payload,
            disposition: "recorded" as const,
            boardId: f.boardId,
            workerPartyId: f.ben,
            onDate: dates.from,
            label: payload.label,
            result: null,
            notes: null,
            visibleInSource: true,
            linkedEntryId: null,
            reason: "Record literal source evidence",
            expectedPriorId: null,
          },
        ],
      };
      const actor = { orgId: f.orgId, actorId: f.actorId };
      await importSourceHistory(actor, batch, (await previewSourceHistory(actor, batch)).approvalHash);
      await f.flow();
      const p = await previewScheduleDistribution(
        f,
        f.boardId,
        dates.from,
        dates.through,
        {
          ...personal,
          includePdf: true,
          pdfLayout: {
            paperSize: "letter",
            orientation: "portrait",
            marginMm: 30,
            density: "standard",
            daysPerSection: 14,
            detail: "full",
          },
        },
      );
      await assert.rejects(
        issue(f, p),
        /native PDF renderer|no report evidence was truncated/,
      );
      assert.deepEqual(await counts(f.orgId), { requests: 0, outbox: 0 });
    }),
);

test('automatic board-scope membership includes current people with no assignment while the scheduled-only cohort excludes them', enabled, () => fixture(async f => {
  const member = await extraContact(f, 'Current unassigned employee', 'unassigned@example.test');
  await withBypassContext(async () => {
    await db.execute(sql`insert into employee_roles(org_id,party_id,is_active,hired_on) values(${f.orgId},${member},true,'2025-01-01')`);
    await db.execute(sql`update schedule_boards set distribution_visibility='board' where id=${f.boardId}`);
  });
  const audience = { visibility: 'board' as const, recipientMode: 'automatic' as const, everyone: true, subjectIds: [], cohort: 'scope' as const };
  const current = await previewScheduleDistribution(f, f.boardId, dates.from, dates.through, audience);
  assert.ok(current.recipients.some(recipient => recipient.partyId === member));
  const blank = current.recipients[0]!.lines.filter(line => line.subjectId === member);
  assert.equal(blank.length, 7);
  assert.ok(blank.every(line => line.status === 'No schedule evidence' && line.hours !== '0'));
  const scheduled = await previewScheduleDistribution(f, f.boardId, dates.from, dates.through, { ...audience, cohort: 'scheduled' });
  assert.equal(scheduled.recipients.some(recipient => recipient.partyId === member), false);
  await assert.rejects(previewScheduleDistribution(f, f.boardId, dates.from, dates.through, { ...audience, recipientMode: 'combined', additionalPartyIds: [member, member] }), /distinct native additional contacts/);
}));

test('revoking the scheduling feature after authoring leaves native failed timer runs and no partial report or email', enabled, () => fixture(async f => {
  await timer(f, false);
  await withBypassContext(() => db.execute(sql`update orgs set settings=jsonb_set(settings,'{features,hrmShiftPlanning}','false'::jsonb) where id=${f.orgId}`));
  await assert.rejects(previewScheduleDistribution(f, f.boardId, dates.from, dates.through, personal), error => error instanceof ScopeNotFoundError && error.message === 'not found');
  const result = await runDueScheduledFlows(new Date('2026-10-12T20:00:00Z'));
  assert.equal(result.errors, 2);
  assert.deepEqual(await counts(f.orgId), { requests: 0, outbox: 0 });
  const failures = await withOrgTransaction(f.orgId, () => db.execute<{status: string; error: string}>(sql`select status,error from flow_runs where subject_kind='schedule_board' order by created_at,id`));
  assert.equal(failures.rows.length, 2);
  assert.ok(failures.rows.every(run => run.status === 'failed' && run.error.includes('(not found)')), JSON.stringify(failures.rows));
}));

test('native PDF evidence binds ordered board rule colors for literal source observations and bookings without changing source identity', enabled, () => fixture(async f => {
  const actor = { orgId: f.orgId, actorId: f.actorId };
  const codeId = randomUUID();
  const rules = [
    { field: 'bookingLabel', match: 'startsWith', value: 'SHOP', color: '#fde68a' },
    { field: 'bookingLabel', match: 'contains', value: 'SHOP', color: '#1d4ed8' },
  ];
  await withBypassContext(async () => {
    const code = await db.execute(sql`insert into schedule_codes(id,org_id,code,label,category,color) values(${codeId},${f.orgId},'SHOP','Shop','work','#99f6e4') returning id`);
    assert.equal(code.rows.length, 1);
    const board = await db.execute(sql`update schedule_boards set cell_color_rules=${JSON.stringify(rules)}::jsonb where org_id=${f.orgId} and id=${f.boardId} returning id`);
    assert.equal(board.rows.length, 1);
  });
  const saved = await applyBoardChanges({ ...actor, boardId: f.boardId, changes: [{ op: 'create', id: randomUUID(), workerPartyId: f.ana, onDate: '2026-10-13', target: { kind: 'code', id: codeId }, span: { mode: 'day' } }] });
  assert.equal(saved.results[0]?.ok, true);
  const before = await preview(f);
  const evidenceBefore = (await loadBoardWindow(actor, f.boardId, dates.from, dates.through)).sourceRecords ?? [];
  const actualLines = before.recipients.flatMap(recipient => recipient.lines).filter(line => line.assignment.startsWith('SHOP'));
  assert.equal(actualLines.length, 2);
  assert.ok(actualLines.every(line => line.color === '#fde68a'));
  await withBypassContext(async () => {
    const cleared = await db.execute(sql`update schedule_boards set cell_color_rules='[]'::jsonb where org_id=${f.orgId} and id=${f.boardId} returning id`);
    assert.equal(cleared.rows.length, 1);
  });
  const fallback = await preview(f);
  assert.notEqual(fallback.version, before.version);
  assert.ok(fallback.recipients.flatMap(recipient => recipient.lines).filter(line => line.assignment.startsWith('SHOP')).every(line => line.color === '#99f6e4'));
  const evidenceAfter = (await loadBoardWindow(actor, f.boardId, dates.from, dates.through)).sourceRecords ?? [];
  assert.deepEqual(evidenceAfter.map(({ color, ...record }) => record), evidenceBefore.map(({ color, ...record }) => record));
}));

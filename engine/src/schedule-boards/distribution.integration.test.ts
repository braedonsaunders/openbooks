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
        ana.lines.map((l) => l.subject),
        ['Ana Field'],
      );
      assert.deepEqual(
        ben.lines.map((l) => l.subject),
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

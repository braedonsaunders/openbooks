import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgTransaction } from "@openbooks/engine/platform/db";
import {
  createScratchOrg,
  dropScratchOrgReporting,
  seedFlowActors,
} from "@openbooks/engine/testing/fixtures";
import {
  importSourceHistory,
  previewSourceHistory,
  sourceHistoryHash,
} from "@openbooks/engine/schedule-boards/source-history";
import { listBoards } from "@openbooks/engine/schedule-boards/boards";
import { createSetupRecord, deleteSetupRecord } from "./write";

const enabled = { skip: !process.env.OPENBOOKS_DB_URL };

test(
  "module board deletion archives the native board, retains source evidence and audits, and replays without another change",
  enabled,
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    const other = await withBypassContext(() => createScratchOrg());
    try {
      const actorId = await withBypassContext(async () => {
        const id = (await seedFlowActors(org.orgId)).adminId;
        const grants = await db.execute(
          sql`update app_roles set permissions='["admin.setup.manage","hrm.shifts.read","hrm.shifts.approve"]'::jsonb where org_id=${org.orgId} and key='admin' returning id`,
          "objects",
        );
        assert.equal(
          grants.length,
          1,
          "the native role receives the actual Setup and scheduling command grants",
        );
        await db.execute(
          sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"hrm":true,"hrmShiftPlanning":true,"multiSubsidiary":true}'::jsonb) where id=${org.orgId}`,
        );
        return id;
      });
      const actor = {
        orgId: org.orgId,
        id: actorId,
        permissions: ["admin.setup.manage"],
        allowedSubsidiaryIds: null,
      };
      const board = await withOrgTransaction(org.orgId, () =>
        createSetupRecord(
          actor,
          "schedule-boards",
          {
            code: "HISTORY",
            name: "Date history",
            rowKind: "people",
            views: ["grid"],
            defaultView: "grid",
            rangeDays: 14,
            timeZone: "America/Toronto",
            dayPolicyKnown: false,
          },
          { requestId: randomUUID() },
        ),
      );
      assert.equal(board.status, 200, JSON.stringify(board.body));
      const boardId = String(board.body.id);
      const workerId = randomUUID();
      await withBypassContext(async () => {
        await db.execute(
          sql`insert into parties(id,org_id,kind,display_name,subsidiary_id,is_active) values(${workerId},${org.orgId},'person','Historical person',${org.subsidiaryId},false)`,
        );
        await db.execute(
          sql`insert into employee_roles(org_id,party_id,is_active) values(${org.orgId},${workerId},false)`,
        );
      });
      const payload = { id: 7, label: "Literal source value" };
      const batch = {
        sourceSystem: "LegacyPlanning",
        sourceDataset: "dbo.manpower",
        captureHash: sourceHistoryHash([payload]),
        rows: [
          {
            sourceKey: "7",
            sourceHash: sourceHistoryHash(payload),
            payload,
            disposition: "recorded" as const,
            boardId,
            workerPartyId: workerId,
            onDate: "2025-01-03",
            label: payload.label,
            result: null,
            notes: null,
            visibleInSource: true,
            linkedEntryId: null,
            expectedPriorId: null,
            reason: "Adopt literal historical date",
          },
        ],
      };
      const nativeActor = { orgId: org.orgId, actorId };
      const preview = await previewSourceHistory(nativeActor, batch);
      const [created] = await importSourceHistory(nativeActor, batch, preview.approvalHash);
      assert.ok(created);
      const before = await withOrgTransaction(org.orgId, () =>
        db.execute(sql`select * from schedule_source_records where id=${created.id}`, "objects"),
      );
      const refused = await withOrgTransaction(other.orgId, () =>
        deleteSetupRecord({ ...actor, orgId: other.orgId }, "schedule-boards", boardId),
      );
      assert.equal(refused.status, 404);
      for (const auditReason of [null, 12, {}, "", "  ", "x".repeat(2001)]) {
        const refusedReason = await withOrgTransaction(org.orgId, () =>
          deleteSetupRecord(actor, "schedule-boards", boardId, {
            auditReason: auditReason as never,
          }),
        );
        assert.equal(refusedReason.status, 400);
      }
      const result = await withOrgTransaction(org.orgId, () =>
        deleteSetupRecord(actor, "schedule-boards", boardId, {
          auditReason: "  Retire the superseded board  ",
        }),
      );
      assert.equal(result.status, 200, JSON.stringify(result.body));
      const readback = await withOrgTransaction(org.orgId, async () => ({
        board: (
          await db.execute<{ is_active: boolean }>(
            sql`select is_active from schedule_boards where id=${boardId}`,
            "objects",
          )
        )[0],
        source: await db.execute(
          sql`select * from schedule_source_records where id=${created.id}`,
          "objects",
        ),
        audits: await db.execute<{
          actor_id: string;
          changes: { before: { is_active: boolean }; after: { is_active: boolean } };
        }>(
          sql`select actor_id,changes from audit_log where table_name='schedule_boards' and row_id=${boardId} and action='update'`,
          "objects",
        ),
      }));
      assert.equal(readback.board?.is_active, false);
      assert.deepEqual(readback.source, before);
      assert.equal(readback.audits.length, 1);
      assert.equal(readback.audits[0]!.actor_id, actorId);
      assert.equal(readback.audits[0]!.changes.before.is_active, true);
      assert.equal(readback.audits[0]!.changes.after.is_active, false);
      assert.equal(
        (readback.audits[0]!.changes as { reason?: string }).reason,
        "Retire the superseded board",
      );
      assert.equal(
        (await listBoards(nativeActor)).some((row) => row.id === boardId),
        false,
      );
      assert.equal(
        (await listBoards(nativeActor, { includeArchived: true })).some(
          (row) => row.id === boardId,
        ),
        true,
      );
      assert.equal(
        (
          await withOrgTransaction(org.orgId, () =>
            deleteSetupRecord(actor, "schedule-boards", boardId),
          )
        ).status,
        200,
      );
      const audits = await withOrgTransaction(org.orgId, () =>
        db.execute<{ n: number }>(
          sql`select count(*)::int n from audit_log where table_name='schedule_boards' and row_id=${boardId} and action='update'`,
          "objects",
        ),
      );
      assert.equal(audits[0]!.n, 1);
    } finally {
      await dropScratchOrgReporting(org.orgId);
      await dropScratchOrgReporting(other.orgId);
    }
  },
);

test(
  "saved hour-column and whole-board sharing settings reopen through the native board read and refuse ownerless sharing",
  enabled,
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const actorId = await withBypassContext(async () => {
        const id = (await seedFlowActors(org.orgId)).adminId;
        await db.execute(
          sql`update app_roles set permissions='["admin.setup.manage","hrm.shifts.read"]'::jsonb where org_id=${org.orgId} and key='admin'`,
        );
        await db.execute(
          sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"hrm":true,"hrmShiftPlanning":true,"multiSubsidiary":true}'::jsonb) where id=${org.orgId}`,
        );
        return id;
      });
      const actor = {
        orgId: org.orgId,
        id: actorId,
        permissions: ["admin.setup.manage"],
        allowedSubsidiaryIds: null,
      };
      const made = await withOrgTransaction(org.orgId, () =>
        createSetupRecord(
          actor,
          "schedule-boards",
          {
            code: "DISPLAY",
            name: "Display board",
            rowKind: "people",
            views: ["grid"],
            defaultView: "grid",
            rangeDays: 14,
            timeZone: "America/Toronto",
            dayPolicyKnown: false,
          },
          { requestId: randomUUID() },
        ),
      );
      assert.equal(made.status, 200, JSON.stringify(made.body));
      const id = String(made.body.id),
        { updateSetupRecord } = await import("./write");
      const refused = await withOrgTransaction(org.orgId, () =>
        updateSetupRecord(actor, "schedule-boards", { id, distributionVisibility: "board" }),
      );
      assert.equal(refused.status, 400);
      assert.match(String(refused.body.error), /legal entity/);
      const saved = await withOrgTransaction(org.orgId, () =>
        updateSetupRecord(actor, "schedule-boards", {
          id,
          subsidiaryId: org.subsidiaryId,
          showHoursColumn: false,
          showTotals: true,
          distributionVisibility: "board",
        }),
      );
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      const board = (await listBoards({ orgId: org.orgId, actorId })).find((b) => b.id === id)!;
      assert.equal(board.showHoursColumn, false);
      assert.equal(board.showTotals, true);
      assert.equal(board.distributionVisibility, "board");
      assert.equal(board.dayPolicyKnown, false);
      const evidence = await withOrgTransaction(org.orgId, () =>
        db.execute<{ actor_id: string; changes: { after: { show_hours_column: boolean } } }>(
          sql`select actor_id,changes from audit_log where table_name='schedule_boards' and row_id=${id} and action='update'`,
          "objects",
        ),
      );
      assert.equal(evidence.length, 1);
      assert.equal(evidence[0]!.actor_id, actorId);
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "board types come from the registry: governed publication needs a managed roster and a start date, and a board keeps its type",
  enabled,
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const actorId = await withBypassContext(async () => {
        const id = (await seedFlowActors(org.orgId)).adminId;
        await db.execute(
          sql`update app_roles set permissions='["admin.setup.manage","hrm.shifts.read"]'::jsonb where org_id=${org.orgId} and key='admin'`,
        );
        await db.execute(
          sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"hrm":true,"hrmShiftPlanning":true}'::jsonb) where id=${org.orgId}`,
        );
        return id;
      });
      const actor = {
        orgId: org.orgId,
        id: actorId,
        permissions: ["admin.setup.manage"],
        allowedSubsidiaryIds: null,
      };
      const base = {
        rowKind: "people",
        views: ["timeline", "grid"],
        defaultView: "timeline",
        grain: "timed",
        rangeDays: 14,
        timeZone: "America/Toronto",
        dayPolicyKnown: false,
      };
      const create = (values: Record<string, unknown>) =>
        withOrgTransaction(org.orgId, () =>
          createSetupRecord(
            actor,
            "schedule-boards",
            { ...base, ...values },
            { requestId: randomUUID() },
          ),
        );

      const peopleGoverned = await create({
        code: "CREW",
        name: "Crew",
        boardType: "people",
        publishPolicy: "governed",
        governedFrom: "2026-11-01",
      });
      assert.equal(
        peopleGoverned.status,
        400,
        "a people board offers only live and staged publishing",
      );
      assert.match(String(peopleGoverned.body.error), /publishPolicy/);
      const undated = await create({
        code: "ROSTER",
        name: "Roster",
        boardType: "shift_roster",
        publishPolicy: "governed",
      });
      assert.equal(undated.status, 400);
      const foreignView = await create({
        code: "ROSTER",
        name: "Roster",
        boardType: "shift_roster",
        views: ["gantt"],
        defaultView: "gantt",
      });
      assert.equal(foreignView.status, 400);

      const roster = await create({
        code: "ROSTER",
        name: "Roster",
        boardType: "shift_roster",
        publishPolicy: "staged",
      });
      assert.equal(roster.status, 200, JSON.stringify(roster.body));
      const plain = await create({ code: "PLAIN", name: "Plain people board" });
      assert.equal(plain.status, 200, JSON.stringify(plain.body));
      const boards = await listBoards({ orgId: org.orgId, actorId });
      const saved = boards.find((board) => board.id === String(roster.body.id))!;
      assert.deepEqual([saved.boardType, saved.publishPolicy], ["shift_roster", "staged"]);
      assert.equal(
        boards.find((board) => board.id === String(plain.body.id))!.boardType,
        "people",
        "a board created without a type takes its row kind's standard type",
      );

      const { updateSetupRecord } = await import("./write");
      // Setup never writes a field locked on edit, and the database refuses a changed type from any writer.
      const retyped = await withOrgTransaction(org.orgId, () =>
        updateSetupRecord(actor, "schedule-boards", {
          id: String(plain.body.id),
          name: "Renamed people board",
          boardType: "shift_roster",
        }),
      );
      assert.equal(retyped.status, 200, JSON.stringify(retyped.body));
      const reread = (await listBoards({ orgId: org.orgId, actorId })).find(
        (board) => board.id === String(plain.body.id),
      )!;
      assert.deepEqual([reread.name, reread.boardType], ["Renamed people board", "people"]);
      await assert.rejects(
        withOrgTransaction(org.orgId, () =>
          db.execute(
            sql`update schedule_boards set board_type = 'shift_roster' where org_id = ${org.orgId} and id = ${String(plain.body.id)}`,
          ),
        ),
      );
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

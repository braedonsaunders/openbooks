import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import {
  db,
  withBypassContext,
  withOrgContext,
  withOrgTransaction,
} from "@openbooks/engine/platform/db";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "@openbooks/engine/testing/fixtures";
import { readAuditEvent, readAuditPage } from "./audit-reader";
import {
  calculatedRun,
  seedAdoption,
} from "@openbooks/engine/testing/payroll/filing-test-fixtures";
import { calculatePayRun } from "@openbooks/engine/payroll/run-calculation";

test(
  "audit windows and exact facets preserve tenant, filter and snapshot semantics",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const first = await withBypassContext(() => createScratchOrg());
    const second = await withBypassContext(() => createScratchOrg());
    try {
      const actor = await withBypassContext(() =>
        createScratchUser(first.orgId, "Audit filter operator", "audit_reader"),
      );
      const ids = Array.from({ length: 7 }, () => randomUUID());
      const foreignEvent = randomUUID();
      const evidence = {
        before: { document: { kind: "customer_invoice", total: "9007199254740993.1234" } },
        after: null,
      };
      // PostgreSQL retains this numeric token exactly; decoding it through a
      // JavaScript number would corrupt the immutable financial evidence.
      const evidenceJson =
        '{"before":{"document":{"kind":"customer_invoice","total":9007199254740993.1234}},"after":null}';
      await withBypassContext(async () => {
        for (const [i, id] of ids.entries())
          await db.execute(sql`
        insert into audit_log (id, org_id, table_name, row_id, action, actor_id, at, changes)
        values (${id}, ${first.orgId}, ${i === 6 ? "documents" : "audit_window_example"}, ${randomUUID()},
          ${i === 6 ? "delete" : i % 2 ? "update" : "insert"}, ${i % 2 ? actor : null},
          '2026-09-01T12:00:00Z', ${i === 6 ? evidenceJson : JSON.stringify({ amount: ["1.0000", "2.0000"] })}::jsonb)
      `);
        await db.execute(sql`insert into audit_log (id, org_id, table_name, row_id, action)
        values (${foreignEvent}, ${second.orgId}, 'audit_window_example', ${randomUUID()}, 'update')`);
      });
      await withOrgContext(first.orgId, async () => {
        const opts = { page: 1, perPage: 5, rtype: "audit_window_example" };
        const firstPage = await readAuditPage(first.orgId, opts);
        const nextPage = await readAuditPage(first.orgId, { ...opts, page: 2 });
        assert.equal(firstPage.total, 6);
        assert.equal(firstPage.rows.length, 5);
        assert.equal(nextPage.rows.length, 1);
        assert.deepEqual(
          [...firstPage.rows, ...nextPage.rows].map((r) => r.id),
          ids.slice(0, 6).sort().reverse(),
        );
        assert.ok(firstPage.rows.every((r) => r.changeCount === 1 && r.summaryKind === "fields"));
        assert.equal((await readAuditPage(first.orgId, { ...opts, actor: "system" })).total, 3);
        assert.equal(
          (await readAuditPage(first.orgId, { ...opts, actor, action: "update" })).total,
          3,
        );
        assert.equal(
          (await readAuditPage(first.orgId, { ...opts, q: "filter operator" })).total,
          3,
        );
        assert.equal((await readAuditPage(first.orgId, { ...opts, to: "2026-08-31" })).total, 0);
        assert.equal(
          (await readAuditPage(first.orgId, { ...opts, from: "2026-09-01", to: "2026-09-01" }))
            .total,
          6,
        );
        assert.ok(
          firstPage.recordTypes.some((r) => r.rtype === "customer_invoice" && Number(r.n) === 1),
        );
        const deleted = await readAuditPage(first.orgId, { ...opts, rtype: "customer_invoice" });
        assert.equal(deleted.total, 1);
        assert.equal(deleted.rows[0]?.summaryKind, "snapshot");
        assert.deepEqual((await readAuditEvent(first.orgId, ids[6]!))?.changes, evidence);
        assert.equal(await readAuditEvent(first.orgId, foreignEvent), null);
        // The caller's explicit org argument cannot override connection-level RLS.
        assert.equal(await readAuditEvent(second.orgId, foreignEvent), null);
        const empty = await readAuditPage(first.orgId, { ...opts, rtype: "absent_audit_type" });
        assert.equal(empty.total, 0);
        assert.deepEqual(empty.rows, []);
        const actions = (rows: typeof empty.actions) => rows.map((r) => [r.action, r.n]);
        const actors = (rows: typeof empty.actors) =>
          rows.map((r) => [r.actor_id, r.actor_name, r.n]);
        assert.deepEqual(actions(empty.actions), actions(firstPage.actions));
        assert.deepEqual(actors(empty.actors), actors(firstPage.actors));
      });
    } finally {
      await dropScratchOrg(first.orgId);
      await dropScratchOrg(second.orgId);
    }
  },
);

test(
  "audit free text matches actor email, action, table label and reason",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    const other = await withBypassContext(() => createScratchOrg());
    try {
      const actorId = randomUUID();
      const actor = await withBypassContext(() =>
        createScratchUser(org.orgId, "Tom Becker", "audit_search", actorId),
      );
      const email = `u-${actorId.slice(0, 8)}@scratch.test`;
      const lockRow = randomUUID();
      const reopenRow = randomUUID();
      await withBypassContext(async () => {
        await db.execute(sql`
        insert into audit_log (id, org_id, table_name, row_id, action, actor_id, at, changes)
        values (${randomUUID()}, ${org.orgId}, 'period_locks', ${lockRow}, 'update', ${actor},
          '2026-09-02T12:00:00Z', ${JSON.stringify({ before: { state: "closed", reason: "year-end close complete" }, after: { state: "open", reason: "correcting a misposted entry" } })}::jsonb),
               (${randomUUID()}, ${org.orgId}, 'close_reopen_requests', ${reopenRow}, 'approve', ${actor},
          '2026-09-03T12:00:00Z', ${JSON.stringify({ before: { status: "requested" }, after: { status: "approved", reason: "board approved the restatement" } })}::jsonb)`);
        await db.execute(sql`insert into audit_log (id, org_id, table_name, row_id, action, at, changes)
        values (${randomUUID()}, ${other.orgId}, 'period_locks', ${randomUUID()}, 'update', '2026-09-02T12:00:00Z',
          ${JSON.stringify({ before: { reason: "correcting a misposted entry" }, after: {} })}::jsonb)`);
      });
      await withOrgContext(org.orgId, async () => {
        const base = { page: 1, perPage: 10 };
        assert.equal((await readAuditPage(org.orgId, { ...base, q: "Tom Becker" })).total, 2);
        assert.equal((await readAuditPage(org.orgId, { ...base, q: email })).total, 2);
        assert.equal((await readAuditPage(org.orgId, { ...base, q: "approve" })).total, 1);
        assert.equal((await readAuditPage(org.orgId, { ...base, q: "Period Locks" })).total, 1);
        assert.equal((await readAuditPage(org.orgId, { ...base, q: "misposted" })).total, 1);
        assert.equal((await readAuditPage(org.orgId, { ...base, q: "restatement" })).total, 1);
        assert.equal((await readAuditPage(org.orgId, { ...base, q: "reopen" })).total, 1);
        assert.equal((await readAuditPage(org.orgId, { ...base, q: "no-such-term" })).total, 0);
      });
      // The other tenant's matching reason stays invisible to this org, and
      // visible to its own readers: free text never crosses the org boundary.
      await withOrgContext(other.orgId, async () => {
        assert.equal(
          (await readAuditPage(other.orgId, { page: 1, perPage: 10, q: "misposted" })).total,
          1,
        );
      });
    } finally {
      await dropScratchOrg(org.orgId);
      await dropScratchOrg(other.orgId);
    }
  },
);

test(
  "audit facets combine record families without losing empty or retained document counts",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const base = { page: 1, perPage: 10 };
      await withOrgContext(org.orgId, async () => {
        const empty = await readAuditPage(org.orgId, base);
        assert.equal(empty.total, 0);
        assert.deepEqual(empty.rows, []);
        assert.deepEqual(empty.actions, []);
        assert.deepEqual(empty.actors, []);
        assert.deepEqual(empty.recordTypes, []);
      });
      const deletedDocument = randomUUID();
      const retainedKinds = ["customer_invoice", "vendor_bill", null] as const;
      await withBypassContext(async () => {
        for (const kind of retainedKinds) {
          const written = await db.execute(
            sql`
          insert into audit_log (id, org_id, table_name, row_id, action, at, changes)
          values (${randomUUID()}, ${org.orgId}, 'documents', ${deletedDocument}, 'delete',
            '2026-09-01T12:00:00Z', ${JSON.stringify(kind ? { before: { document: { kind } } } : {})}::jsonb)
          returning id
        `,
            "objects",
          );
          assert.equal(written.length, 1);
        }
        const written = await db.execute(
          sql`
        insert into audit_log (id, org_id, table_name, row_id, action, at, changes)
        values (${randomUUID()}, ${org.orgId}, 'customer_invoice', ${randomUUID()}, 'delete',
          '2026-09-02T00:00:00Z', '{"reason":"Duplicate invoice"}') returning id
      `,
          "objects",
        );
        assert.equal(written.length, 1);
      });
      await withOrgTransaction(org.orgId, async () => {
        await db.execute(sql`set local time zone 'UTC'`);
        const all = await readAuditPage(org.orgId, base);
        assert.equal(all.total, 4);
        assert.deepEqual(
          all.actions.map((row) => [row.action, Number(row.n)]),
          [["delete", 4]],
        );
        assert.deepEqual(
          all.actors.map((row) => [row.actor_id, Number(row.n)]),
          [[null, 4]],
        );
        assert.deepEqual(
          all.recordTypes.map((row) => [row.rtype, Number(row.n)]),
          [
            ["customer_invoice", 2],
            ["documents", 1],
            ["vendor_bill", 1],
          ],
        );
        for (const [filters, expected] of [
          [{ rtype: "customer_invoice" }, 2],
          [{ q: "Customer Invoice" }, 2],
          [{ from: "2026-09-02", actor: "system", action: "delete" }, 1],
          [{ to: "2026-09-01" }, 3],
          [{ q: "Duplicate invoice" }, 1],
          [{ rtype: "absent_type" }, 0],
        ] as const) {
          const filtered = await readAuditPage(org.orgId, { ...base, ...filters });
          assert.equal(filtered.total, expected);
          assert.equal(filtered.total, filtered.rows.length);
          assert.deepEqual(
            filtered.recordTypes.map((row) => [row.rtype, row.n]),
            all.recordTypes.map((row) => [row.rtype, row.n]),
          );
        }
      });
      await withOrgTransaction(org.orgId, async () => {
        await db.execute(sql`set local time zone 'America/Toronto'`);
        assert.equal((await readAuditPage(org.orgId, { ...base, to: "2026-09-01" })).total, 4);
        assert.equal((await readAuditPage(org.orgId, { ...base, from: "2026-09-02" })).total, 0);
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "native calculated and recalculated results resolve through the ordinary audit reader",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const fixture = await withBypassContext(() => seedAdoption());
    const other = await withBypassContext(() => createScratchOrg());
    try {
      const { input } = await withBypassContext(() => calculatedRun(fixture));
      await withBypassContext(() => calculatePayRun(input));
      const eventIds = await withBypassContext(() =>
        db.execute<{ id: string; recalculation: boolean }>(
          sql`
      select id, (changes->>'recalculation')::boolean as recalculation from audit_log
       where org_id=${fixture.orgId} and table_name='pay_runs' and row_id=${input.documentId}
         and changes->>'operation'='calculate_pay_run'
    `,
          "objects",
        ),
      );
      assert.equal(eventIds.length, 2);
      const recalculatedId = eventIds.find((row) => row.recalculation)!.id;
      await withOrgContext(fixture.orgId, async () => {
        const page = await readAuditPage(fixture.orgId, {
          page: 1,
          perPage: 10,
          rtype: "pay_runs",
          q: input.documentId,
          actor: fixture.actorId,
        });
        assert.equal(page.total, 2);
        assert.deepEqual(
          page.rows.map((row) => row.id).sort(),
          eventIds.map((row) => row.id).sort(),
        );
        assert.ok(
          page.rows.every(
            (row) => row.rowId === input.documentId && row.summaryKind === "snapshot",
          ),
        );
        const event = await readAuditEvent(fixture.orgId, recalculatedId);
        assert.equal(event?.recordType, "pay_runs");
        const evidence = event!.changes as {
          before: {
            run: { subsidiaryId: string };
            stubs: Array<{ stubId: string; gross: string }>;
          };
          after: { run: { subsidiaryId: string }; stubs: Array<{ stubId: string; gross: string }> };
        };
        assert.equal(evidence.before.run.subsidiaryId, fixture.subsidiaryId);
        assert.equal(evidence.after.run.subsidiaryId, fixture.subsidiaryId);
        assert.equal(evidence.before.stubs[0]!.gross, "240.0000");
        assert.equal(evidence.after.stubs[0]!.gross, "240.0000");
        assert.notEqual(evidence.before.stubs[0]!.stubId, evidence.after.stubs[0]!.stubId);
      });
      await withOrgContext(other.orgId, async () => {
        assert.equal(await readAuditEvent(other.orgId, recalculatedId), null);
        assert.equal(
          await readAuditEvent(fixture.orgId, recalculatedId),
          null,
          "explicit org cannot override RLS",
        );
        assert.equal(
          (
            await readAuditPage(other.orgId, {
              page: 1,
              perPage: 10,
              rtype: "pay_runs",
              q: input.documentId,
            })
          ).total,
          0,
        );
      });
    } finally {
      await dropScratchOrg(fixture.orgId);
      await dropScratchOrg(other.orgId);
    }
  },
);

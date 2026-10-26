import assert from "node:assert/strict";
import test from "node:test";
import { openingBalancesForYear, saveOpeningBalances } from "./opening-balances.ts";
import { dropScratchOrgReporting } from "../testing/fixtures.ts";
import { seedAdoption } from "./filing-test-fixtures.ts";

/**
 * F3-25: the adoption grid replayed full-row payloads from its stale loader
 * snapshot — a carry-in saved by someone else between load and Save was
 * silently overwritten with old numbers. The save now carries each row's
 * loader-served version and refuses a stale row by name, writing nothing.
 */
test(
  "a save carrying a stale row version refuses by name and writes nothing",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const fx = await seedAdoption();
    try {
      const first = await saveOpeningBalances({
        orgId: fx.orgId,
        actorId: fx.actorId,
        taxYear: 2026,
        rows: [
          {
            employeePartyId: fx.employeeId,
            amounts: { pensionableYtd: "60000.00", insurableYtd: "0", cppYtd: "3500.00" },
            components: {},
          },
        ],
      });
      assert.deepEqual(first.errors, []);

      // The version the grid holds from its loader snapshot.
      const loaded = await openingBalancesForYear(fx.orgId, 2026);
      const row = loaded.rows.find((r) => r.employeePartyId === fx.employeeId);
      assert.ok(row?.amounts, "the carry-in must be stored");
      const staleVersion = row.updatedAt;
      assert.ok(
        typeof staleVersion === "string" && staleVersion.length > 0,
        "the loader must serve a row version",
      );
      const concurrentValue = row.amounts!.pensionableYtd;

      // A concurrent edit lands after the grid loaded.
      const concurrent = await saveOpeningBalances({
        orgId: fx.orgId,
        actorId: fx.actorId,
        taxYear: 2026,
        rows: [
          {
            employeePartyId: fx.employeeId,
            amounts: { pensionableYtd: "70000.00", insurableYtd: "0", cppYtd: "4000.00" },
            components: {},
          },
        ],
      });
      assert.deepEqual(concurrent.errors, []);
      assert.notEqual(
        (await openingBalancesForYear(fx.orgId, 2026)).rows.find(
          (r) => r.employeePartyId === fx.employeeId,
        )?.amounts?.pensionableYtd,
        concurrentValue,
        "the concurrent edit must have moved the stored row",
      );

      // The stale save refuses by name instead of overwriting.
      await assert.rejects(
        saveOpeningBalances({
          orgId: fx.orgId,
          actorId: fx.actorId,
          taxYear: 2026,
          rows: [
            {
              employeePartyId: fx.employeeId,
              amounts: { pensionableYtd: "1.00", insurableYtd: "0" },
              components: {},
              updatedAt: staleVersion,
            },
          ],
        }),
        /changed since.*reload/i,
      );

      // Nothing was written: the concurrent values stand, not the stale ones.
      const after = (await openingBalancesForYear(fx.orgId, 2026)).rows.find(
        (r) => r.employeePartyId === fx.employeeId,
      );
      assert.equal(after?.amounts?.pensionableYtd, "70000.0000");
      assert.equal(after?.amounts?.cppYtd, "4000.0000");

      // A save carrying the CURRENT version succeeds.
      const current = (await openingBalancesForYear(fx.orgId, 2026)).rows.find(
        (r) => r.employeePartyId === fx.employeeId,
      )!.updatedAt;
      const ok = await saveOpeningBalances({
        orgId: fx.orgId,
        actorId: fx.actorId,
        taxYear: 2026,
        rows: [
          {
            employeePartyId: fx.employeeId,
            amounts: { pensionableYtd: "70000.00", insurableYtd: "0", cppYtd: "4000.00" },
            components: {},
            updatedAt: current,
          },
        ],
      });
      assert.deepEqual(ok.errors, []);
      assert.equal(ok.updated, 1);
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "claiming no version for a row that exists refuses as stale",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const fx = await seedAdoption();
    try {
      const first = await saveOpeningBalances({
        orgId: fx.orgId,
        actorId: fx.actorId,
        taxYear: 2026,
        rows: [
          {
            employeePartyId: fx.employeeId,
            amounts: { pensionableYtd: "60000.00", insurableYtd: "0" },
            components: {},
          },
        ],
      });
      assert.deepEqual(first.errors, []);

      // Explicit null means "my snapshot had no row" — but one exists now.
      await assert.rejects(
        saveOpeningBalances({
          orgId: fx.orgId,
          actorId: fx.actorId,
          taxYear: 2026,
          rows: [
            {
              employeePartyId: fx.employeeId,
              amounts: { pensionableYtd: "60000.00", insurableYtd: "0" },
              components: {},
              updatedAt: null,
            },
          ],
        }),
        /changed since.*reload/i,
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

test(
  "source-referenced opening replacement and clearing retain exact before/after evidence and roll back when audit is refused",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const { db } = await import("../platform/db.ts");
    const { sql } = await import("drizzle-orm");
    const { randomUUID } = await import("node:crypto");
    const fx = await seedAdoption();
    const fault = `opening_audit_${randomUUID().replaceAll("-", "")}`;
    const save = (amount: string, programs: Record<string, string> = { qpip: "120.25" }) =>
      saveOpeningBalances({
        orgId: fx.orgId,
        actorId: fx.actorId,
        taxYear: 2026,
        auditReason: "  Adopt the reviewed annual carry-in basis  ",
        sourceReference: "  source-register:annual-2026  ",
        rows: [
          {
            employeePartyId: fx.employeeId,
            amounts: { pensionableYtd: amount, insurableYtd: "0" },
            components: {},
            programs,
            suiStates: {},
            accountBases: [],
          },
        ],
      });
    const events = async () =>
      await db.execute<{
        action: string;
        actor_id: string;
        changes: {
          reason: string;
          sourceReference: string;
          beforeRecord: unknown;
          afterRecord: {
            balance: { pensionable_ytd: string };
            children: { programBases: { id: string; insurable_ytd: string }[] };
          };
          before: { pensionableYtd: string };
          after: unknown;
        };
      }>(
        sql`
    select action,actor_id,changes from audit_log where org_id=${fx.orgId} and table_name='payroll_opening_balances' order by id
  `,
        "objects",
      );
    try {
      await save("100.25");
      let audit = (await events()).at(-1)!;
      assert.equal(audit.action, "insert");
      assert.equal(audit.actor_id, fx.actorId);
      assert.equal(audit.changes.reason, "Adopt the reviewed annual carry-in basis");
      assert.equal(audit.changes.sourceReference, "source-register:annual-2026");
      assert.equal(audit.changes.beforeRecord, null);
      assert.equal(audit.changes.afterRecord.balance.pensionable_ytd, "100.2500");
      const programBase = audit.changes.afterRecord.children.programBases[0];
      assert.ok(programBase, "the audited opening retains its programme base");
      assert.equal(programBase.insurable_ytd, "120.2500");
      assert.ok(programBase.id);
      const original = audit.changes.afterRecord;
      const beforeCount = (await events()).length;
      await db.execute(
        sql.raw(
          `create function public.${fault}() returns trigger language plpgsql as $$ begin if new.org_id='${fx.orgId}'::uuid and new.table_name='payroll_opening_balances' then return null; end if; return new; end $$`,
        ),
      );
      await db.execute(
        sql.raw(
          `create trigger ${fault} before insert on public.audit_log for each row execute function public.${fault}()`,
        ),
      );
      try {
        await assert.rejects(save("200.50"), /audit did not persist/);
      } finally {
        await db.execute(sql.raw(`drop trigger ${fault} on public.audit_log`));
        await db.execute(sql.raw(`drop function public.${fault}()`));
      }
      assert.equal((await events()).length, beforeCount);
      const current = (await openingBalancesForYear(fx.orgId, 2026)).rows.find(
        (row) => row.employeePartyId === fx.employeeId,
      )!;
      assert.equal(current.amounts!.pensionableYtd, "100.2500");
      await save("200.50");
      audit = (await events()).at(-1)!;
      assert.equal(audit.action, "update");
      assert.deepEqual(audit.changes.beforeRecord, original);
      assert.equal(audit.changes.before.pensionableYtd, "100.2500");
      assert.equal(audit.changes.afterRecord.balance.pensionable_ytd, "200.5000");
      const lastStored = audit.changes.afterRecord;
      const cleared = await save("0", {});
      assert.equal(cleared.deleted, 1);
      audit = (await events()).at(-1)!;
      assert.equal(audit.action, "delete");
      assert.deepEqual(audit.changes.beforeRecord, lastStored);
      assert.equal(audit.changes.after, null);
      assert.equal(audit.changes.afterRecord, null);
      assert.equal(audit.changes.reason, "Adopt the reviewed annual carry-in basis");
      assert.equal(
        (
          await db.execute(
            sql`select id from payroll_opening_program_bases where org_id=${fx.orgId}`,
            "objects",
          )
        ).length,
        0,
      );
      await assert.rejects(
        saveOpeningBalances({
          orgId: fx.orgId,
          actorId: fx.actorId,
          taxYear: 2026,
          auditReason: " ",
          rows: [],
        }),
        /audit reason/,
      );
      await assert.rejects(
        saveOpeningBalances({
          orgId: fx.orgId,
          actorId: fx.actorId,
          taxYear: 2026,
          sourceReference: "source",
          rows: [],
        }),
        /requires an audit reason/,
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

import assert from "node:assert/strict";
import test from "node:test";
import {
  openingBalancesForYear,
  saveOpeningBalances,
} from "./opening-balances.ts";
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
        rows: [{
          employeePartyId: fx.employeeId,
          amounts: { pensionableYtd: "60000.00", cppYtd: "3500.00" },
          components: {},
        }],
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
        rows: [{
          employeePartyId: fx.employeeId,
          amounts: { pensionableYtd: "70000.00", cppYtd: "4000.00" },
          components: {},
        }],
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
          rows: [{
            employeePartyId: fx.employeeId,
            amounts: { pensionableYtd: "1.00" },
            components: {},
            updatedAt: staleVersion,
          }],
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
        rows: [{
          employeePartyId: fx.employeeId,
          amounts: { pensionableYtd: "70000.00", cppYtd: "4000.00" },
          components: {},
          updatedAt: current,
        }],
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
        rows: [{
          employeePartyId: fx.employeeId,
          amounts: { pensionableYtd: "60000.00" },
          components: {},
        }],
      });
      assert.deepEqual(first.errors, []);

      // Explicit null means "my snapshot had no row" — but one exists now.
      await assert.rejects(
        saveOpeningBalances({
          orgId: fx.orgId,
          actorId: fx.actorId,
          taxYear: 2026,
          rows: [{
            employeePartyId: fx.employeeId,
            amounts: { pensionableYtd: "60000.00" },
            components: {},
            updatedAt: null,
          }],
        }),
        /changed since.*reload/i,
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);

/**
 * Closed-period immutability probe truthfulness.
 *
 * The probe is the sim's only evidence that closed periods refuse postings —
 * so the probe itself must be honest. It once passed vacuously in a world
 * with no vendors (no subject, no posting, still green) and counted ANY
 * posting error as proof (a draft-lifecycle refusal or an RLS crash read as
 * "correctly rejected"). Both shapes stay green while closed-period
 * enforcement is broken.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "../../platform/db.ts";
import { setPeriodLockState } from "../../close/period-locks.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../../testing/fixtures.ts";
import { immutabilityProbe } from "./index.ts";
import type { SimOrg, SimPeriod, SimVendor } from "../world.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

function probeWorld(org: ScratchOrg, adminId: string, vendors: SimVendor[]): SimOrg {
  return {
    orgId: org.orgId,
    bookId: org.bookId,
    subsidiaryId: org.subsidiaryId,
    fiscalCalendarId: "probe-calendar",
    currency: "CAD",
    accounts: {
      materials: org.accounts.adjustment,
      ar: org.accounts.ar,
      ap: org.accounts.ap,
      bank: org.accounts.bank,
    },
    vendors,
    customers: [],
    actors: { apClerk: adminId, arClerk: adminId, controller: adminId, admin: adminId },
    periods: [],
    employees: [],
    timeTypeId: null,
    laborItemId: null,
    engagements: [],
    jobs: [],
    subscriptions: [],
  } as SimOrg;
}

function scratchPeriod(org: ScratchOrg, startsOn = "2026-07-01"): SimPeriod {
  return {
    id: org.periodId,
    fiscalYear: 2026,
    month: 7,
    name: "2026-07",
    startsOn,
    endsOn: "2026-07-31",
  };
}

async function setup(): Promise<{ org: ScratchOrg; adminId: string }> {
  const org = await withBypassContext(() => createScratchOrg());
  const adminId = await withBypassContext(() => createScratchUser(org.orgId, "Probe Admin", "admin"));
  return { org, adminId };
}

test(
  "a vendorless world is exercised, not vacuously green",
  { skip: !DB, timeout: 180_000 },
  async () => {
    const { org, adminId } = await setup();
    try {
      // The scratch period is OPEN: a real probe posts successfully, so the
      // only honest outcome is a failure naming the missing refusal. The old
      // probe returned pass here without posting anything.
      const result = await withBypassContext(() =>
        immutabilityProbe(probeWorld(org, adminId, []), scratchPeriod(org)),
      );
      assert.equal(result.pass, false);
      assert.match(result.failures[0]!.detail, /NOT rejected/);
    } finally {
      await withBypassContext(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "an unrelated posting error fails the probe instead of counting as proof",
  { skip: !DB, timeout: 180_000 },
  async () => {
    const { org, adminId } = await setup();
    try {
      const vendor: SimVendor = {
        id: org.vendorId,
        name: "Probe Vendor",
        termDays: 30,
        expenseCategories: [],
        billMin: 1,
        billMax: 10,
      };
      // No accounting period covers 1999-01-01, so the kernel refuses with
      // "no accounting period covers …" — a PostingError, but NOT the
      // closed-period refusal. The old probe counted it as correctly
      // rejected and passed.
      const result = await withBypassContext(() =>
        immutabilityProbe(probeWorld(org, adminId, [vendor]), scratchPeriod(org, "1999-01-01")),
      );
      assert.equal(result.pass, false);
      assert.match(result.failures[0]!.detail, /without reaching the closed-period gate/);
      assert.match(result.failures[0]!.detail, /no accounting period covers/);
    } finally {
      await withBypassContext(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "a closed AP period passes by asserting the named refusal",
  { skip: !DB, timeout: 180_000 },
  async () => {
    const { org, adminId } = await setup();
    try {
      await withBypassContext(() =>
        setPeriodLockState({
          orgId: org.orgId,
          periodId: org.periodId,
          bookId: org.bookId,
          module: "ap",
          state: "closed",
          actorId: adminId,
          reason: "immutability-probe regression: AP closed with the bill still approved",
        }),
      );
      const vendor: SimVendor = {
        id: org.vendorId,
        name: "Probe Vendor",
        termDays: 30,
        expenseCategories: [],
        billMin: 1,
        billMax: 10,
      };
      const result = await withBypassContext(() =>
        immutabilityProbe(probeWorld(org, adminId, [vendor]), scratchPeriod(org)),
      );
      assert.equal(result.pass, true, JSON.stringify(result.failures));
      // The probe cleans up after itself: no probe bill left behind.
      const leftovers = await withBypassContext(() =>
        db.execute<{ n: string }>(sql`
          select count(*)::text as n from documents
           where org_id = ${org.orgId} and document_number like 'PROBE-%'`),
      );
      assert.equal(leftovers.rows[0]!.n, "0");
    } finally {
      await withBypassContext(() => dropScratchOrg(org.orgId));
    }
  },
);

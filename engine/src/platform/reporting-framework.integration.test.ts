import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { orgReportingFramework } from "./reporting-framework.ts";
import { createScratchOrg, dropScratchOrgReporting } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test(
  "orgReportingFramework resolves the stored policy and defaults an unset policy, never a missing org",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      // A persisted row with no policy keeps the historical us_gaap default.
      assert.equal(await orgReportingFramework(org.orgId), "us_gaap");
      await db.execute(sql`
        update orgs set settings = jsonb_set(settings, '{reportingFramework}', '"ifrs"'::jsonb)
         where id = ${org.orgId}`);
      assert.equal(await orgReportingFramework(org.orgId), "ifrs");
      // A missing org row is a caller bug — refuse it by name instead of
      // defaulting a framework for an organization that does not exist.
      await assert.rejects(
        () => orgReportingFramework("00000000-0000-0000-0000-000000000000"),
        /not found/,
      );
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

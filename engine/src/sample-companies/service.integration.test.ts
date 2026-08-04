import assert from "node:assert/strict";
import test from "node:test";
import { createSampleCompany, SampleCompanyError } from "./service.ts";
import { withBypass } from "../db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "../test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test(
  "sample-company provisioning rejects a source tenant the member cannot access",
  { skip: !DB },
  async () => {
    const memberOrg = await withBypass(() => createScratchOrg());
    const foreignOrg = await withBypass(() => createScratchOrg());
    try {
      const memberUserId = await withBypass(() =>
        createScratchUser(memberOrg.orgId, "Sample requester", "admin"),
      );

      await assert.rejects(
        createSampleCompany({
          industryKey: "general_business",
          memberUserId,
          sourceOrgId: foreignOrg.orgId,
          memberName: "Sample requester",
          features: {},
        }),
        (error: unknown) => {
          assert.ok(error instanceof SampleCompanyError);
          assert.equal(
            error.message,
            "requesting member does not have access to the source organization",
          );
          return true;
        },
      );
    } finally {
      await withBypass(() => dropScratchOrg(foreignOrg.orgId));
      await withBypass(() => dropScratchOrg(memberOrg.orgId));
    }
  },
);

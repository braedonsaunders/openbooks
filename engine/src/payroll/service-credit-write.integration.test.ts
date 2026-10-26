import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { db } from "../platform/db.ts";
import { validateServiceCreditConfiguration } from "./service-credit.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedPayrollPerson,
  seedWorkerEmployment,
} from "../testing/fixtures.ts";

/**
 * Credited service written through Setup posts whole calendar months as text
 * (S3). The validator coerces a whole-month spelling to the pack's whole
 * months and refuses only truly invalid input with the convention remedy.
 */
async function employment(orgId: string, subsidiaryId: string): Promise<string> {
  const partyId = randomUUID();
  await seedPayrollPerson(orgId, partyId, "Service Credit Emp", { subsidiaryId });
  return seedWorkerEmployment(orgId, partyId, subsidiaryId);
}

function body(
  employmentId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    employmentId,
    convention: "calendar_months",
    asOfDate: "2018-04-02",
    creditedDays: "",
    creditedMonths: "89",
    effectiveFrom: "2018-04-02",
    reason: "Prior service recognition",
    ...overrides,
  };
}

test(
  "calendar months accept whole months posted as text from a mid-month start",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await createScratchOrg();
    try {
      const employmentId = await employment(org.orgId, org.subsidiaryId);
      await validateServiceCreditConfiguration(db, org.orgId, body(employmentId));
      await validateServiceCreditConfiguration(
        db,
        org.orgId,
        body(employmentId, { creditedMonths: 89 }),
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "calendar months refuse fractional months and carried days with the convention remedy",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await createScratchOrg();
    try {
      const employmentId = await employment(org.orgId, org.subsidiaryId);
      await assert.rejects(
        validateServiceCreditConfiguration(
          db,
          org.orgId,
          body(employmentId, { creditedMonths: "88.5" }),
        ),
        /whole months by anniversary/,
      );
      await assert.rejects(
        validateServiceCreditConfiguration(
          db,
          org.orgId,
          body(employmentId, { creditedDays: "0" }),
        ),
        /cannot carry credited days/,
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

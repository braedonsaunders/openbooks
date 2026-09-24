import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";
import { PayrollError } from "./error.ts";
import { payRunChanges, payRunFunding, payRunReadiness } from "./readiness.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

// A missing run is a named not-found regardless of scope. Funding with an
// unknown id and no scope used to return SUCCESS (zero net pay, every
// account sufficient, payDate today); changes returned a clean no-changes
// diff for a run that does not exist; readiness tallied zero blockers.

async function rejectsNotFound(work: () => Promise<unknown>): Promise<void> {
  await assert.rejects(work, (e: unknown) => {
    assert.ok(e instanceof PayrollError);
    assert.match(e.message, /pay run not found/);
    return true;
  });
}

for (const scopeName of ["no scope", "a subsidiary scope"] as const) {
  test(`funding refuses an unknown run with ${scopeName}`, { skip: !DB }, async () => {
    const org = await createScratchOrg();
    try {
      const scope = scopeName === "no scope" ? undefined : new Set([randomUUID()]);
      await rejectsNotFound(() => payRunFunding(org.orgId, randomUUID(), scope));
    } finally {
      await dropScratchOrg(org.orgId);
    }
  });

  test(`changes refuse an unknown run with ${scopeName}`, { skip: !DB }, async () => {
    const org = await createScratchOrg();
    try {
      const scope = scopeName === "no scope" ? undefined : new Set([randomUUID()]);
      await rejectsNotFound(() => payRunChanges(org.orgId, randomUUID(), scope));
    } finally {
      await dropScratchOrg(org.orgId);
    }
  });

  test(`readiness refuses an unknown run with ${scopeName}`, { skip: !DB }, async () => {
    const org = await createScratchOrg();
    try {
      const scope = scopeName === "no scope" ? undefined : new Set([randomUUID()]);
      await rejectsNotFound(() => payRunReadiness(org.orgId, randomUUID(), scope));
    } finally {
      await dropScratchOrg(org.orgId);
    }
  });
}

import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { defaultContinuousCloseDetectors } from "./continuous-close-config.ts";
import { db, withBypass } from "./db.ts";
import { payrollFindings } from "./agents/payroll.ts";
import {
  calculatedRun,
  markLegacy,
  seedAdoption,
} from "./payroll-filing-test-fixtures.ts";
import { commitPayRun } from "./payroll-run.ts";
import { createScratchOrg, dropScratchOrg } from "./test-fixtures.ts";

/**
 * Live-PostgreSQL proofs for the payroll-compliance pack (background agent
 * pack B): remittance due dates from the remittance summary, unknown
 * filing/liability accounts, missing statutory elections, and year-end gaps.
 *
 * Committed-run fixtures reuse the payroll filing kit (seedAdoption,
 * calculatedRun, commitPayRun, markLegacy) — the same builders the
 * remittance and filing suites use — called bare exactly like those suites.
 * The pack function is exercised directly (the same way the registry
 * dispatches it); control-plane persistence is covered by
 * continuous-close.integration.test.ts.
 */

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

async function scan(orgId: string, threshold = "1000.0000") {
  return payrollFindings(orgId, threshold, defaultContinuousCloseDetectors("payroll"));
}

function fingerprints(findings: Awaited<ReturnType<typeof scan>>): string[] {
  return findings.map((finding) => finding.fingerprint);
}

test(
  "a committed run produces dated remittance findings and no unknown-account noise",
  { skip: !DB },
  async () => {
    const fx = await seedAdoption();
    try {
      const { input } = await calculatedRun(fx);
      await commitPayRun(input);

      // The single-employee fixture run accrues tens of dollars: scan under
      // a small floor so the assertion exercises dating, not materiality
      // (the floor itself is covered by the threshold unit tests).
      const findings = await scan(fx.orgId, "1.0000");
      const due = findings.filter((finding) => finding.findingType === "payroll_remittance_due");
      assert.ok(due.length > 0, `committed withholding surfaces dated groups, got ${fingerprints(findings)}`);
      for (const finding of due) {
        assert.equal(finding.agentKey, "payroll");
        assert.ok(finding.summary.dueDate, "every group carries its schedule due date");
        assert.ok(finding.evidence.length >= 1, "every group carries evidence");
        assert.equal(finding.summary.href, "/payroll/remittances");
      }
      // Attributed stubs: the unknown-accounts detector stays silent.
      assert.ok(
        !fingerprints(findings).some((fingerprint) => fingerprint.startsWith("payroll-unknown-accounts:")),
        "attributed runs raise no unknown-account findings",
      );
      // Repeat scans are fingerprint-stable, so the run upsert surfaces only
      // genuinely new groups.
      const again = await scan(fx.orgId, "1.0000");
      assert.deepEqual(
        fingerprints(again).sort(),
        fingerprints(findings).sort(),
        "repeat scans are fingerprint-stable",
      );
    } finally {
      await dropScratchOrg(fx.orgId);
    }
  },
);

test(
  "legacy unattributed stubs surface per run without breaking the pack",
  { skip: !DB },
  async () => {
    const fx = await seedAdoption();
    try {
      const { input } = await calculatedRun(fx);
      await commitPayRun(input);
      await markLegacy(fx.orgId);

      const findings = await scan(fx.orgId);
      assert.ok(
        fingerprints(findings).includes(`payroll-unknown-accounts:${input.documentId}`),
        `the legacy run is flagged, got ${fingerprints(findings)}`,
      );
      const flagged = findings.find(
        (finding) => finding.fingerprint === `payroll-unknown-accounts:${input.documentId}`,
      )!;
      assert.equal(flagged.summary.href, "/payroll/remittances");
    } finally {
      await dropScratchOrg(fx.orgId);
    }
  },
);

test(
  "missing elections and missing SINs surface per country and clear on file",
  { skip: !DB },
  async () => {
    const fx = await seedAdoption();
    try {
      // Terry files with claim codes but no SIN: the slip gap fires, the
      // elections detector stays silent. The fixture org also leaves a
      // statutory rate unconfigured — a true year-end gap from the rates
      // surface's own computation.
      let findings = await scan(fx.orgId);
      assert.ok(
        fingerprints(findings).includes("payroll-yearend-no-sin:CA"),
        `missing SIN surfaces, got ${fingerprints(findings)}`,
      );
      assert.ok(
        fingerprints(findings).some((fingerprint) => fingerprint.startsWith("payroll-yearend-rate-gap:CA:")),
        `unconfigured statutory rates surface, got ${fingerprints(findings)}`,
      );
      assert.ok(
        !fingerprints(findings).some((fingerprint) => fingerprint.startsWith("payroll-missing-elections:")),
        "filed claim codes raise no elections finding",
      );

      // Terry's TD1 never arrived: elections fire with Terry as evidence.
      await db.execute(sql`
        update employee_payroll_profiles
           set federal_claim_code = null, provincial_claim_code = null
         where org_id = ${fx.orgId} and employee_party_id = ${fx.employeeId}`);
      findings = await scan(fx.orgId);
      assert.ok(
        fingerprints(findings).includes("payroll-missing-elections:CA"),
        `missing elections surface, got ${fingerprints(findings)}`,
      );
      const elections = findings.find(
        (finding) => finding.fingerprint === "payroll-missing-elections:CA",
      )!;
      assert.ok(
        elections.evidence.some((item) => item.sourceId === fx.employeeId),
        "Terry is the evidence",
      );

      // Filed: both clear.
      await db.execute(sql`
        update employee_payroll_profiles
           set federal_claim_code = 1, provincial_claim_code = 1, sin_encrypted = 'test-sin'
         where org_id = ${fx.orgId} and employee_party_id = ${fx.employeeId}`);
      findings = await scan(fx.orgId);
      assert.ok(
        !fingerprints(findings).some(
          (fingerprint) =>
            fingerprint.startsWith("payroll-missing-elections:") ||
            fingerprint.startsWith("payroll-yearend-no-sin:"),
        ),
        `filed elections and SIN clear, got ${fingerprints(findings)}`,
      );
    } finally {
      await dropScratchOrg(fx.orgId);
    }
  },
);

test(
  "payroll findings never leak across orgs",
  { skip: !DB },
  async () => {
    const clean = await withBypass(() => createScratchOrg());
    const fx = await seedAdoption();
    try {
      const { input } = await calculatedRun(fx);
      await commitPayRun(input);
      await markLegacy(fx.orgId);
      assert.ok((await scan(fx.orgId)).length > 0, "the payroll org flags its own runs");
      assert.deepEqual(await scan(clean.orgId), [], "an org with no payroll sees no payroll findings");
    } finally {
      await dropScratchOrg(fx.orgId);
      await withBypass(() => dropScratchOrg(clean.orgId));
    }
  },
);

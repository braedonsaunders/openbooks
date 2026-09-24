import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { businessToday } from "../platform/business-date.ts";
import { defaultContinuousCloseDetectors } from "../agents/continuous-close-config.ts";
import { db, withBypass, withBypassContext } from "../platform/db.ts";
import { forensicsFindings } from "../agents/forensics.ts";
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";

/**
 * Live-PostgreSQL proofs for the forensics pack (background agent pack B):
 * weekend postings, round-dollar spend, threshold-trap amounts, and duplicate
 * bills surface as evidence-backed finding drafts; org scoping holds; repeat
 * scans are deterministic so the run upsert surfaces only genuinely new
 * items.
 *
 * The pack function is exercised directly (the same way the registry
 * dispatches it). Control-plane persistence — the upsert, auto-resolve, and
 * scheduler claim — is covered by continuous-close.integration.test.ts and
 * needs no agent-key policy rows here.
 */

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

/** Most recent Saturday on or before the given ISO date. */
function lastSaturday(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`);
  const back = (date.getUTCDay() + 1) % 7;
  date.setUTCDate(date.getUTCDate() - back);
  return date.toISOString().slice(0, 10);
}

function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function insertSpendDoc(
  org: ScratchOrg,
  opts: { kind: string; number: string; date: string; total: string; partyId?: string | null },
): Promise<string> {
  const id = randomUUID();
  await withBypassContext(async () => {
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, posting_date, currency, fx_rate, subtotal, tax_total, total)
      values (${id}, ${org.orgId}, ${opts.kind}, 'draft', ${opts.number}, ${org.subsidiaryId},
              ${opts.partyId ?? null}, ${opts.date}, ${opts.date},
              'CAD', '1', ${opts.total}, '0.0000', ${opts.total})
    `);
  });
  return id;
}

async function scan(orgId: string) {
  return forensicsFindings(orgId, "1000.0000", defaultContinuousCloseDetectors("forensics"));
}

test(
  "the forensics pack flags weekend, round-dollar, trap, and duplicate spend with evidence",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      // The detectors window off the org business day, not the fixture date.
      const saturday = lastSaturday(await businessToday(org.orgId));
      const friday = addDays(saturday, -1);
      const thursday = addDays(saturday, -2);

      const weekendId = await insertSpendDoc(org, {
        kind: "vendor_bill", number: "FORENSIC-WKND", date: saturday, total: "1500.0000",
      });
      const roundId = await insertSpendDoc(org, {
        kind: "vendor_bill", number: "FORENSIC-ROUND", date: friday, total: "5000.0000",
      });
      const trapId = await insertSpendDoc(org, {
        kind: "vendor_bill", number: "FORENSIC-TRAP", date: friday, total: "1999.9900",
      });
      const dupA = await insertSpendDoc(org, {
        kind: "vendor_bill", number: "FORENSIC-DUP-A", date: thursday, total: "1200.0000", partyId: org.vendorId,
      });
      const dupB = await insertSpendDoc(org, {
        kind: "vendor_bill", number: "FORENSIC-DUP-B", date: friday, total: "1200.0000", partyId: org.vendorId,
      });
      // Controls: a weekday ordinary amount, and a weekend pittance below
      // the materiality floor — neither may flag.
      await insertSpendDoc(org, {
        kind: "vendor_bill", number: "FORENSIC-CLEAN", date: friday, total: "1234.5600",
      });
      await insertSpendDoc(org, {
        kind: "vendor_bill", number: "FORENSIC-TINY", date: saturday, total: "10.0000",
      });

      const findings = await scan(org.orgId);
      const types = findings.map((finding) => finding.findingType);
      assert.ok(types.includes("forensic_weekend_postings"), `weekend posting flagged, got ${types}`);
      assert.ok(types.includes("forensic_round_dollar"), `round-dollar spend flagged, got ${types}`);
      assert.ok(types.includes("forensic_threshold_trap"), `threshold trap flagged, got ${types}`);
      assert.ok(types.includes("forensic_duplicate_bills"), `duplicate bills flagged, got ${types}`);

      const fingerprints = findings.map((finding) => finding.fingerprint);
      assert.ok(fingerprints.includes(`forensic-weekend:${weekendId}`));
      assert.ok(fingerprints.includes(`forensic-round-dollar:${roundId}`));
      assert.ok(fingerprints.includes(`forensic-threshold-trap:${trapId}`));
      assert.ok(
        fingerprints.includes(`forensic-duplicate:${dupA}:${dupB}`) ||
          fingerprints.includes(`forensic-duplicate:${dupB}:${dupA}`),
        `duplicate pair fingerprinted, got ${fingerprints}`,
      );
      for (const finding of findings) {
        assert.equal(finding.agentKey, "forensics");
        assert.ok(finding.evidence.length >= 1, `${finding.fingerprint} carries evidence rows`);
      }
      // 1500.00 against the 1000.00 floor escalates only to warning; the
      // 5000.00 round-dollar item hits the 5x multiple and goes critical.
      const byFingerprint = new Map(findings.map((finding) => [finding.fingerprint, finding]));
      assert.equal(byFingerprint.get(`forensic-weekend:${weekendId}`)?.severity, "warning");
      assert.equal(byFingerprint.get(`forensic-round-dollar:${roundId}`)?.severity, "critical");

      // A second scan over unchanged books returns the same drafts: stable
      // fingerprints are what let the run upsert surface only new items.
      const again = await scan(org.orgId);
      assert.deepEqual(
        again.map((finding) => finding.fingerprint).sort(),
        fingerprints.sort(),
        "repeat scans are fingerprint-stable",
      );
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "the sentinel population spans all seven spend kinds and excludes voided documents",
  { skip: !DB },
  async () => {
    // The scheduled sentinel dashboard defines the spend population this
    // pack must watch: the same seven non-voided kinds. A weekend posting
    // in any of the seven flags; a voided one never does, even material.
    const org = await withBypass(() => createScratchOrg());
    try {
      const saturday = lastSaturday(await businessToday(org.orgId));
      const ids: string[] = [];
      for (const kind of [
        "vendor_bill",
        "vendor_credit",
        "vendor_payment",
        "check",
        "expense_report",
        "journal",
        "customer_credit",
      ]) {
        ids.push(
          await insertSpendDoc(org, {
            kind,
            number: `FORENSIC-POP-${kind}`,
            date: saturday,
            total: "2500.0000",
          }),
        );
      }
      const voidedId = await insertSpendDoc(org, {
        kind: "vendor_bill",
        number: "FORENSIC-POP-VOID",
        date: saturday,
        total: "2500.0000",
      });
      await withBypassContext(async () => {
        await db.execute(sql`update documents set voided_at = now() where id = ${voidedId}`);
      });

      const findings = await scan(org.orgId);
      const weekend = new Set(
        findings
          .filter((finding) => finding.findingType === "forensic_weekend_postings")
          .map((finding) => finding.fingerprint),
      );
      for (const id of ids) {
        assert.ok(weekend.has(`forensic-weekend:${id}`), `weekend ${id} flags`);
      }
      assert.ok(!weekend.has(`forensic-weekend:${voidedId}`), "the voided posting never flags");
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "forensic findings never leak across orgs",
  { skip: !DB },
  async () => {
    const orgA = await withBypass(() => createScratchOrg());
    const orgB = await withBypass(() => createScratchOrg());
    try {
      await insertSpendDoc(orgA, {
        kind: "vendor_bill", number: "FORENSIC-OTHER-ORG", date: lastSaturday(await businessToday(orgA.orgId)), total: "9000.0000",
      });
      assert.ok((await scan(orgA.orgId)).length > 0, "org A flags its own spend");
      assert.deepEqual(await scan(orgB.orgId), [], "org B sees none of org A's spend");
    } finally {
      await withBypass(() => dropScratchOrg(orgA.orgId));
      await withBypass(() => dropScratchOrg(orgB.orgId));
    }
  },
);

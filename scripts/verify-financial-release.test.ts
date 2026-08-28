import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  accountingReleaseStatus,
  loadAccountingBlockerManifest,
  parseAccountingBlockerManifest,
  unresolvedAccountingBlockers,
} from "./verify-financial-release.ts";

const REVIEWED_AT = "2026-08-28T12:00:00.000Z";

test("an unresolved reviewed accounting blocker prevents a ready certificate", () => {
  const manifest = parseAccountingBlockerManifest({
    reviewed: true,
    reviewedAt: REVIEWED_AT,
    reviewedBy: "finance-reviewer",
    blockers: [{ id: "fnd_new-accounting-gap", title: "Unreconciled posting" }],
  });

  assert.deepEqual(unresolvedAccountingBlockers(manifest), [
    {
      id: "fnd_new-accounting-gap",
      title: "Unreconciled posting",
      status: "open",
    },
  ]);
  assert.equal(accountingReleaseStatus(manifest), "release-blocked");
});

test("an explicitly reviewed empty manifest is the only zero-blocker path", () => {
  const manifest = parseAccountingBlockerManifest({
    reviewed: true,
    reviewedAt: REVIEWED_AT,
    reviewedBy: "finance-reviewer",
    blockers: [],
  });

  assert.deepEqual(unresolvedAccountingBlockers(manifest), []);
  assert.equal(accountingReleaseStatus(manifest), "release-candidate-ready");
});

test("loading a manifest preserves its reviewed evidence and rejects an unreviewed file", () => {
  const directory = mkdtempSync(join(tmpdir(), "financial-release-manifest-"));
  try {
    const reviewedPath = join(directory, "reviewed.json");
    const reviewedRaw = JSON.stringify({
      reviewed: true,
      reviewedAt: REVIEWED_AT,
      reviewedBy: "finance-reviewer",
      blockers: [
        { id: "acct-1", title: "Pending account tie-out", status: "resolved" },
      ],
    });
    writeFileSync(reviewedPath, reviewedRaw);
    const loaded = loadAccountingBlockerManifest(reviewedPath);
    assert.equal(loaded.raw, reviewedRaw);
    assert.equal(loaded.manifest.reviewedBy, "finance-reviewer");
    assert.deepEqual(unresolvedAccountingBlockers(loaded.manifest), []);

    const unreviewedPath = join(directory, "unreviewed.json");
    writeFileSync(
      unreviewedPath,
      JSON.stringify({
        reviewedAt: REVIEWED_AT,
        reviewedBy: "finance-reviewer",
        blockers: [],
      }),
    );
    assert.throws(
      () => loadAccountingBlockerManifest(unreviewedPath),
      /must set reviewed=true/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

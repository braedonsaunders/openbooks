import assert from "node:assert/strict";
import test from "node:test";
import {
  addMonthsUtc,
  monthsBetween,
  projectDerivedStatus,
} from "./shared.ts";

test("derived status: expiry day itself still counts (expiring, not expired)", () => {
  assert.equal(
    projectDerivedStatus({ stored: "valid", expiresOn: "2026-09-21", leadDays: 30, today: "2026-09-21" }),
    "expiring",
  );
  assert.equal(
    projectDerivedStatus({ stored: "valid", expiresOn: "2026-09-20", leadDays: 30, today: "2026-09-21" }),
    "expired",
  );
});

test("derived status: lead-day edge fires exactly at the boundary", () => {
  // 30-day lead: 30 days out is expiring, 31 is valid.
  assert.equal(
    projectDerivedStatus({ stored: "valid", expiresOn: "2026-10-21", leadDays: 30, today: "2026-09-21" }),
    "expiring",
  );
  assert.equal(
    projectDerivedStatus({ stored: "valid", expiresOn: "2026-10-22", leadDays: 30, today: "2026-09-21" }),
    "valid",
  );
  // Zero lead: only the expiry day and past project.
  assert.equal(
    projectDerivedStatus({ stored: "valid", expiresOn: "2026-09-21", leadDays: 0, today: "2026-09-21" }),
    "expiring",
  );
  assert.equal(
    projectDerivedStatus({ stored: "valid", expiresOn: "2026-09-22", leadDays: 0, today: "2026-09-21" }),
    "valid",
  );
});

test("derived status: stored states pass through or pin", () => {
  assert.equal(
    projectDerivedStatus({ stored: "revoked", expiresOn: "2026-09-20", leadDays: 30, today: "2026-09-21" }),
    "revoked",
  );
  // Pending never derives, even long past expiry: an unverified
  // credential is pending, not expired.
  assert.equal(
    projectDerivedStatus({ stored: "pending_verification", expiresOn: "2020-01-01", leadDays: 30, today: "2026-09-21" }),
    "pending_verification",
  );
  // No expiry stored means it does not expire.
  assert.equal(
    projectDerivedStatus({ stored: "valid", expiresOn: null, leadDays: 30, today: "2026-09-21" }),
    "valid",
  );
});

test("derived status: a verified future-dated credential is not yet effective", () => {
  // Issued tomorrow, verified today: valid storage must never project
  // valid (or expiring) before the issue date — the gate would dispatch
  // on it.
  assert.equal(
    projectDerivedStatus({ stored: "valid", expiresOn: "2027-09-21", leadDays: 30, today: "2026-09-21", issuedOn: "2026-09-22" }),
    "not_yet_effective",
  );
  // On the issue date itself it counts.
  assert.equal(
    projectDerivedStatus({ stored: "valid", expiresOn: "2027-09-21", leadDays: 30, today: "2026-09-22", issuedOn: "2026-09-22" }),
    "valid",
  );
  // Expiry-window position never rescues a future issue: even inside the
  // lead window the credential is not yet effective, not expiring.
  assert.equal(
    projectDerivedStatus({ stored: "valid", expiresOn: "2026-09-25", leadDays: 30, today: "2026-09-21", issuedOn: "2026-09-22" }),
    "not_yet_effective",
  );
  // Pending and revoked never derive through the issue date: pending
  // still needs verification first, revoked stays revoked.
  assert.equal(
    projectDerivedStatus({ stored: "pending_verification", expiresOn: "2027-09-21", leadDays: 30, today: "2026-09-21", issuedOn: "2026-09-22" }),
    "pending_verification",
  );
  assert.equal(
    projectDerivedStatus({ stored: "revoked", expiresOn: "2027-09-21", leadDays: 30, today: "2026-09-21", issuedOn: "2026-09-22" }),
    "revoked",
  );
  // Callers that do not know the issue date keep the old projection.
  assert.equal(
    projectDerivedStatus({ stored: "valid", expiresOn: "2027-09-21", leadDays: 30, today: "2026-09-21" }),
    "valid",
  );
});

test("month arithmetic clamps month-ends for validity defaults", () => {
  assert.equal(addMonthsUtc("2026-01-31", 1), "2026-02-28");
  assert.equal(addMonthsUtc("2024-01-31", 1), "2024-02-29");
  assert.equal(addMonthsUtc("2026-09-21", 12), "2027-09-21");
  assert.equal(monthsBetween("2026-09-21", "2027-09-21"), 12);
  assert.equal(monthsBetween("2026-09-22", "2027-09-21"), 11);
});

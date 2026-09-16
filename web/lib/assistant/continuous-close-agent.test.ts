import test from "node:test";
import assert from "node:assert/strict";
import {
  packMissionBrief,
  packNarrativeTitle,
  packSystemGuidance,
} from "./continuous-close-prompts.ts";

test("wave-2 packs get their own guidance while existing packs stay untouched", () => {
  assert.equal(packSystemGuidance("accounting"), "");
  assert.equal(packSystemGuidance("finance"), "");
  assert.equal(packSystemGuidance("forensics"), "", "future packs degrade to shared instructions");
  for (const agentKey of ["collections", "payables", "reconciliation", "hygiene"] as const) {
    assert.ok(packSystemGuidance(agentKey).length > 0, `${agentKey} registers system guidance`);
  }
  assert.match(packSystemGuidance("collections"), /AR aging/);
  assert.match(packSystemGuidance("payables"), /AP aging/);
  assert.match(packSystemGuidance("reconciliation"), /never mark anything matched/);
  assert.match(packSystemGuidance("hygiene"), /never guess/);
});

test("mission briefs name each pack's job with finance and default preserved", () => {
  const finance = packMissionBrief("finance", "2026-09-16");
  assert.match(finance, /management-ready financial summary/);
  assert.match(finance, /2026-09-16/);
  assert.match(
    packMissionBrief("accounting", "2026-09-16"),
    /concise close-readiness brief/,
    "accounting keeps the historic default verbatim",
  );
  assert.match(packMissionBrief("forensics", "2026-09-16"), /concise close-readiness brief/);
  assert.match(packMissionBrief("collections", "2026-09-16"), /collections action list/);
  assert.match(packMissionBrief("payables", "2026-09-16"), /pay run|payables review/);
  assert.match(packMissionBrief("reconciliation", "2026-09-16"), /reconciliation review/);
  assert.match(packMissionBrief("hygiene", "2026-09-16"), /data-hygiene review/);
});

test("narrative titles default per pack with finance preserved", () => {
  assert.equal(packNarrativeTitle("finance"), "Financial performance summary");
  assert.equal(packNarrativeTitle("accounting"), "Accounting close-readiness brief");
  assert.equal(packNarrativeTitle("forensics"), "Accounting close-readiness brief");
  assert.equal(packNarrativeTitle("collections"), "Collections action list");
  assert.equal(packNarrativeTitle("payables"), "Payables review");
  assert.equal(packNarrativeTitle("reconciliation"), "Reconciliation review");
  assert.equal(packNarrativeTitle("hygiene"), "Data hygiene review");
});

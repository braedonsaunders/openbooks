import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ContinuousCloseAgentKey } from "@openbooks/engine/src/continuous-close-config.ts";
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
  assert.match(packMissionBrief("forensics", "2026-09-16"), /spend document/);
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

const thisDir = import.meta.dirname;
// Known tool names: `name: "x"` definitions plus the router's module map
// (ledger primitives like find_documents live there, not in tools-*.ts).
const defined = readdirSync(thisDir)
  .filter((file) => /^tools(-.*)?\.ts$/.test(file) && !file.endsWith(".test.ts"))
  .flatMap((file) =>
    [...readFileSync(join(thisDir, file), "utf8").matchAll(/name: "([a-z_0-9]+)"/g)].map((m) => m[1]),
  );
const routed = [
  ...readFileSync(join(thisDir, "tool-router.ts"), "utf8").matchAll(/^  ([a-z_0-9]+): "[a-z]+",$/gm),
].map((m) => m[1]);
const knownTools = new Set([...defined, ...routed]);

/**
 * Pack-B investigation briefs: every background agent pack directs the model
 * at governed tools that exist. The finance brief keeps its exact standing
 * text; packs without a brief share the generic close-readiness brief.
 */
test("every pack-B agent has an investigation brief naming real tools", () => {
  const expected: Record<string, string[]> = {
    finance: [],
    forensics: ["find_documents", "get_document", "find_journal_entries"],
    tax: ["tax_return", "list_tax_return_forms", "documents_missing_tax_code"],
    payroll: ["list_pay_runs", "payroll_remittances", "list_payroll_employees", "payroll_year_end"],
    projects: ["rank_projects", "project_profitability"],
    cash: ["list_open_items", "aging", "cash_flow"],
  };
  for (const [pack, tools] of Object.entries(expected)) {
    const brief = packMissionBrief(pack as ContinuousCloseAgentKey, "2026-09-16");
    for (const tool of tools) {
      assert.ok(brief.includes(tool), `${pack} brief names ${tool}`);
      assert.ok(knownTools.has(tool), `${tool} exists in the assistant tool registry`);
    }
  }
  assert.match(
    packMissionBrief("finance", "2026-09-16"),
    /management-ready financial summary/,
    "finance keeps its exact standing text",
  );
  assert.match(
    packMissionBrief("accounting", "2026-09-16"),
    /concise close-readiness brief/,
    "packs without a brief keep the generic close-readiness brief",
  );
});

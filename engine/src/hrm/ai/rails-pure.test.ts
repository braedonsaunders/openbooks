import assert from "node:assert/strict";
import test from "node:test";
import { diffStubLines } from "./explain-pay.ts";
import {
  AiRailsError,
  autonomyRaiseRefused,
  finalizeBlockedRefusal,
  unknownCapability,
} from "./errors.ts";
import { digest } from "./governance.ts";
import {
  baselineBreaches,
  renderExplanation,
  suppressionKey,
  zDistance,
  SEVERITY_BY_KIND,
} from "./anomalies.ts";
import { flagBiasTerms } from "./drafting.ts";
import { validateNlDefinition, type NlCatalogEntity } from "./nl-reports.ts";
import {
  AI_AUTONOMY_LADDER,
  AI_CAPABILITIES,
  assertAutonomyAtOrBelowMax,
  autonomyRank,
  requireCapability,
} from "./registry.ts";

/**
 * HRM AI rails (HR-21) pure unit tests — no database. The deterministic
 * core (autonomy ladder, explanations, baseline math, diffs, bias flags,
 * definition validation) is asserted here; DB-owned behavior lives in
 * rails.integration.test.ts for the gating box.
 */

test("registry holds six capabilities with prompt lines and notice texts", () => {
  assert.equal(AI_CAPABILITIES.size, 6);
  for (const def of AI_CAPABILITIES.values()) {
    assert.ok(def.promptLine.length > 0, `${def.key} needs a prompt line`);
    if (def.noticeRequired) assert.ok(def.noticeText.length > 0, `${def.key} needs notice text`);
  }
});

test("autonomy ladder orders read_only below act_with_confirmation", () => {
  assert.deepEqual([...AI_AUTONOMY_LADDER], ["read_only", "draft", "propose", "act_with_confirmation"]);
  assert.ok(autonomyRank("read_only") < autonomyRank("draft"));
  assert.ok(autonomyRank("draft") < autonomyRank("propose"));
  assert.ok(autonomyRank("propose") < autonomyRank("act_with_confirmation"));
  assert.equal(autonomyRank("autonomous"), -1);
});

test("unknown capability refuses with the remedy", () => {
  assert.throws(() => requireCapability("hrmTimeTravel"), (e: unknown) =>
    e instanceof AiRailsError && /Company Settings → Features/.test(e.message));
  assert.match(unknownCapability("x").message, /\/admin\/ai/);
});

test("autonomy may move down but never above the code maximum", () => {
  assertAutonomyAtOrBelowMax("hrmExplainPay", "read_only");
  assertAutonomyAtOrBelowMax("hrmPayrollAnomalies", "read_only");
  assert.throws(() => assertAutonomyAtOrBelowMax("hrmExplainPay", "draft"), (e: unknown) =>
    e instanceof AiRailsError && /cannot be raised above "read_only"/.test(e.message));
  assert.throws(() => assertAutonomyAtOrBelowMax("hrmDrafting", "act_with_confirmation"), /cannot be raised above "draft"/);
  assert.match(autonomyRaiseRefused("k", "draft").message, /may only lower it/);
});

test("every anomaly kind has a severity and blockers are the finalize gate", () => {
  assert.equal(Object.keys(SEVERITY_BY_KIND).length, 17);
  for (const kind of ["terminated_with_pay", "duplicate_bank", "missing_rate", "negative_balance"] as const) {
    assert.equal(SEVERITY_BY_KIND[kind], "block");
  }
  assert.equal(SEVERITY_BY_KIND.retro_spike, "warn");
  assert.throws(() => { throw finalizeBlockedRefusal(2, "2026-09-01", "2026-09-30"); },
    /2 blocking payroll check\(s\) are open.*\/payroll\/anomalies/);
});

test("explanations render with the numbers, naming what/expected/actual", () => {
  const text = renderExplanation("net_pay_spike", {
    actual: "9200", z: "4.2", cohort: "sub-1", mean: "5000", stddev: "1000",
  });
  assert.ok(text.includes("9200") && text.includes("4.2") && text.includes("5000"));
  const dup = renderExplanation("duplicate_entry", { entryCount: "3" });
  assert.ok(dup.includes("3 time entries"));
  const custom = renderExplanation("custom", { text: "operator note" });
  assert.equal(custom, "operator note");
});

test("baseline breach math: z threshold with zero-spread fail-closed", () => {
  assert.equal(baselineBreaches(5000, 1000, 9200, 3), true);
  assert.equal(baselineBreaches(5000, 1000, 5000, 3), false);
  assert.equal(baselineBreaches(5000, 1000, 7999, 3), false);
  assert.equal(baselineBreaches(5000, 0, 5000, 3), false);
  assert.equal(baselineBreaches(5000, 0, 5001, 3), true);
  assert.equal(zDistance(5000, 1000, 9200), "4.2");
  assert.equal(zDistance(5000, 0, 5000), "0.0");
});

test("suppression identity is stable per kind and detail key", () => {
  assert.equal(suppressionKey("duplicate_bank", "bank:abc"), suppressionKey("duplicate_bank", "bank:abc"));
  assert.notEqual(suppressionKey("duplicate_bank", "bank:abc"), suppressionKey("duplicate_bank", "bank:abd"));
  assert.notEqual(suppressionKey("duplicate_bank", "bank:abc"), suppressionKey("retro_spike", "bank:abc"));
});

test("stub diff names added, removed and changed lines with the input", () => {
  const prev = [
    { description: "Base salary", hours: "80", rate: "25", amount: "2000" },
    { description: "Old bonus", hours: null, rate: null, amount: "100" },
  ];
  const current = [
    { description: "Base salary", hours: "88", rate: "25", amount: "2200" },
    { description: "Overtime", hours: "4", rate: "37.5", amount: "150" },
  ];
  const changes = diffStubLines(prev, current);
  assert.equal(changes.length, 3);
  const salary = changes.find((c) => c.description === "Base salary");
  assert.equal(salary?.previousAmount, "2000");
  assert.equal(salary?.amount, "2200");
  assert.ok(salary?.input.includes("80") && salary?.input.includes("88"));
  const added = changes.find((c) => c.description === "Overtime");
  assert.equal(added?.previousAmount, null);
  assert.ok(added?.input.includes("4 hours × 37.5"));
  const removed = changes.find((c) => c.description === "Old bonus");
  assert.equal(removed?.amount, null);
});

test("bias flags use the org list only, whole-word, with excerpts", () => {
  assert.deepEqual(flagBiasTerms("a strong candidate", []), []);
  const flags = flagBiasTerms("We need a young energetic salesman for the team", ["young", "salesman", "cultural fit"]);
  assert.equal(flags.length, 2);
  assert.ok(flags.every((f) => f.excerpt.length > f.term.length));
  // Substring is not a hit: "youngster" must not flag "young".
  assert.deepEqual(flagBiasTerms("a youngster joined", ["young"]), []);
});

test("drafting writes nowhere except ai_decisions", async () => {
  const { draftFromEvidence } = await import("./drafting.ts");
  const writes: string[] = [];
  const textOf = (query: unknown): string => {
    const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
    // Drizzle literal chunks are StringChunk objects whose `.value` is a
    // string array; interpolated params surface as String objects.
    return chunks.map((c) => {
      if (typeof c === "string") return c;
      if (c instanceof String) return String(c);
      const value = (c as { value?: unknown })?.value;
      if (typeof value === "string") return value;
      if (Array.isArray(value)) return value.filter((v) => typeof v === "string").join("");
      return "";
    }).join(" ");
  };
  const fake = {
    execute: async (query: unknown) => {
      const text = textOf(query);
      const verb = text.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
      if (verb === "insert" && !text.includes("ai_decisions")) {
        throw new Error(`FORBIDDEN WRITE: ${text.slice(0, 80)}`);
      }
      if (verb === "update" || verb === "delete") {
        throw new Error(`FORBIDDEN WRITE: ${text.slice(0, 80)}`);
      }
      if (text.includes("ai_decisions")) {
        writes.push(text);
        return { rows: [{ id: "decision-1" }] };
      }
      if (text.includes("hrm_requisitions")) {
        return { rows: [{
          id: "req-1", title: "Support Engineer", employmentKind: "full_time",
          compensationMin: "90000", compensationMax: "110000",
          compensationCurrency: "CAD", compensationBasis: "annual",
          description: "Own the queue", positionId: null,
        }] };
      }
      if (text.includes("from orgs")) {
        return { rows: [{ features: { hrm: true, hrmAiAssist: true, hrmDrafting: true } }] };
      }
      if (text.includes("from users")) return { rows: [{ isSuperAdmin: false, isActive: true }] };
      if (text.includes("app_role") || text.includes("role.permissions")) {
        return { rows: [{ permissions: ["hrm.recruiting.read"] }] };
      }
      if (text.includes("ai_rails_settings")) return { rows: [] };
      return { rows: [] };
    },
  };
  const draft = await draftFromEvidence(fake as never, {
    orgId: "org-1", actorId: "actor-1", kind: "job_description", subjectId: "req-1",
  });
  assert.equal(draft.sources.length, 1);
  assert.ok(draft.text.includes("Support Engineer"));
  assert.equal(draft.decisionId, "decision-1");
  assert.equal(writes.length, 1, "exactly one write: the ai_decisions row");
});

test("digests are stable hashes, never the text", () => {
  assert.equal(digest("hello"), digest("hello"));
  assert.notEqual(digest("hello"), digest("hello "));
  assert.equal(digest("hello").length, 64);
  assert.ok(!digest("hello").includes("hello"));
});

const CATALOG: NlCatalogEntity[] = [
  { key: "payroll_stubs", columns: ["net_pay", "gross", "pay_date"], requiredPermission: null },
  { key: "payroll_wages", columns: ["net_pay"], requiredPermission: "payroll.manage" },
];

test("nl validation accepts a well-formed definition", () => {
  const def = validateNlDefinition({
    entity: "payroll_stubs",
    mode: "summarize",
    columns: ["net_pay"],
    breakouts: [{ column: "pay_date", bin: "month" }],
    measures: [{ fn: "sum", column: "net_pay", label: "Total" }],
    filters: { combinator: "and", rules: [{ field: "gross", op: "gte", value: 0 }] },
    sorts: [{ column: "net_pay", direction: "desc" }],
    limit: 100,
  }, CATALOG, ["reports.read"]);
  assert.equal(def.entity, "payroll_stubs");
  assert.equal(def.mode, "summarize");
  assert.equal(def.limit, 100);
});

test("nl validation refuses unknown entities, columns, fns and gated entities by name", () => {
  assert.throws(() => validateNlDefinition({ entity: "payroll_stubs", columns: [] }, CATALOG, []),
    /at least one column/);
  assert.throws(() => validateNlDefinition({ entity: "nope", columns: ["x"] }, CATALOG, []),
    /unknown report entity "nope" — visible to you: payroll_stubs, payroll_wages/);
  // A REALISTIC collision: the message must tell two entities apart, not
  // name the country twice. Here the caller sees one entity; the gated
  // one is refused by its permission, never listed as available.
  assert.throws(
    () => validateNlDefinition({ entity: "payroll_wages", columns: ["net_pay"] }, CATALOG, ["reports.read"]),
    /needs payroll\.manage/,
  );
  assert.throws(() => validateNlDefinition({ entity: "payroll_stubs", columns: ["ssn"] }, CATALOG, []),
    /"ssn" is not a column of entity "payroll_stubs"/);
  assert.throws(() => validateNlDefinition({
    entity: "payroll_stubs", columns: ["net_pay"], measures: [{ fn: "median", column: "net_pay" }],
  }, CATALOG, []), /measure fn "median" is unknown/);
  assert.throws(() => validateNlDefinition({
    entity: "payroll_stubs", columns: ["net_pay"], sorts: [{ column: "net_pay", direction: "sideways" }],
  }, CATALOG, []), /must be "asc" or "desc"/);
  assert.throws(() => validateNlDefinition({
    entity: "payroll_stubs", columns: ["net_pay"], frobnicate: true,
  }, CATALOG, []), /unknown definition key "frobnicate"/);
  assert.throws(() => validateNlDefinition({
    entity: "payroll_stubs", columns: ["net_pay"],
    filters: { combinator: "and", rules: [{ field: "net_pay", op: "approx", value: 1 }] },
  }, CATALOG, []), /operator "approx".*is unknown/);
  assert.throws(() => validateNlDefinition({
    entity: "payroll_stubs", columns: ["net_pay"], limit: 20000,
  }, CATALOG, []), /limit must be an integer from 1 to 10000/);
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { preflightNeedsRecordedGuardTransition, type PreflightTransitionEvidence } from "./migration-preflight-transitions.ts";

const current = "generated/0692_journal_instruction_modes.sql";
const next = "generated/0699_financial_history_native_clone_guards.sql";
const consumer = "generated/0700_typed_currency_adjustment_fx_residual_guards.sql";
const read = (file: string) => readFileSync(new URL(`../schema/migrations/${file}`, import.meta.url), "utf8");
const published = new Map([current, next, consumer].map(filename => [filename, read(filename)]));
const hash = (content: string) => createHash("sha256").update(content).digest("hex");
const currentBody = published.get(current)!.split("FUNCTION public.journal_instruction_line_guard()")[1]!.split("AS $$")[1]!.split("$$;")[0]!;
const evidence: PreflightTransitionEvidence = {
  migration: consumer,
  consumerSql: read("preflight/0700_typed_currency_adjustment_fx_residual_guards.sql"),
  findings: [{ migration: consumer, code: "0700.instruction_guard_definition", severity: "refuse",
    subject: "public.journal_instruction_line_guard", detail: "strict guard differs", remedy: "reconcile publisher" }],
  published, recorded: new Map([[current, hash(published.get(current)!)]]) ,
  pendingBeforeConsumer: new Set([next]), currentBody,
};

test("only an exact recorded instruction publisher may defer to the exact earlier pending publisher", () => {
  assert.equal(preflightNeedsRecordedGuardTransition(evidence), true);
  for (const changed of [
    { recorded: new Map() },
    { recorded: new Map([[current, "0".repeat(64)]]) },
    { recorded: new Map([...evidence.recorded, [next, hash(published.get(next)!)]]) },
    { pendingBeforeConsumer: new Set<string>() },
    { currentBody: null },
    { currentBody: currentBody + "\n" },
    { migration: "generated/0701_another_consumer.sql" },
    { consumerSql: evidence.consumerSql + "\n" },
    { findings: [] },
    { findings: [...evidence.findings, { ...evidence.findings[0]!, code: "0700.guard_definition", subject: "public.journal_lines_check_fx_residual_entries(uuid[],boolean)" }] },
  ]) assert.equal(preflightNeedsRecordedGuardTransition({ ...evidence, ...changed }), false);
});

test("source, overload, publisher and prerequisite drift retain their refusal", () => {
  for (const filename of [current, next, consumer]) {
    const changed = new Map(published); changed.set(filename, changed.get(filename)! + "\n");
    assert.equal(preflightNeedsRecordedGuardTransition({ ...evidence, published: changed }), false);
  }
  const future = "generated/0701_guard_update.sql";
  const unexpected = published.get(current)!;
  assert.equal(preflightNeedsRecordedGuardTransition({ ...evidence,
    published: new Map([...published, [future, unexpected]]),
    recorded: new Map([...evidence.recorded, [future, hash(unexpected)]]) }), false);
  assert.equal(preflightNeedsRecordedGuardTransition({ ...evidence, findings: [{ ...evidence.findings[0]!, subject: "public.other_guard" }] }), false);
});

test("currency-binding consumer defers only its pinned pending publisher and revalidation query", () => {
  const binding = "generated/0702_journal_instruction_currency_binding.sql";
  const files = new Map([...published, [binding, read(binding)]]);
  const bindingEvidence: PreflightTransitionEvidence = {
    ...evidence, migration: binding, published: files,
    consumerSql: read("preflight/0702_journal_instruction_currency_binding.sql"),
    findings: [{ ...evidence.findings[0]!, migration: binding,
      code: "0702.instruction_guard_definition", subject: "public.journal_instruction_line_guard()" }],
  };
  assert.equal(preflightNeedsRecordedGuardTransition(bindingEvidence), true);
  for (const changed of [
    { recorded: new Map() },
    { recorded: new Map([[current, "0".repeat(64)]]) },
    { recorded: new Map([...evidence.recorded, [next, hash(files.get(next)!)]]) },
    { pendingBeforeConsumer: new Set<string>() },
    { currentBody: null },
    { currentBody: currentBody + "\n" },
    { consumerSql: bindingEvidence.consumerSql + "\n" },
    { consumerSql: evidence.consumerSql },
    { findings: evidence.findings },
    { findings: [...bindingEvidence.findings, { ...bindingEvidence.findings[0]!, code: "0702.other_drift" }] },
  ]) assert.equal(preflightNeedsRecordedGuardTransition({ ...bindingEvidence, ...changed }), false);
  for (const filename of [current, next, binding]) {
    const changed = new Map(files); changed.set(filename, changed.get(filename)! + "\n");
    assert.equal(preflightNeedsRecordedGuardTransition({ ...bindingEvidence, published: changed }), false);
  }
});

test("measurement consumer defers only the complete pinned instruction publisher chain", () => {
  const binding = "generated/0702_journal_instruction_currency_binding.sql";
  const measurement = "generated/0703_journal_measurement_and_instruction_guards.sql";
  const files = new Map([...published, [binding, read(binding)], [measurement, read(measurement)]]);
  const body = (filename: string) => files.get(filename)!
    .split("FUNCTION public.journal_instruction_line_guard()")[1]!
    .split("AS $$")[1]!.split("$$;")[0]!;
  const measurementEvidence: PreflightTransitionEvidence = {
    ...evidence, migration: measurement, published: files,
    consumerSql: read("preflight/0703_journal_measurement_and_instruction_guards.sql"),
    findings: [{ ...evidence.findings[0]!, migration: measurement,
      code: "0703.instruction_guard_definition", subject: "public.journal_instruction_line_guard()" }],
    pendingBeforeConsumer: new Set([next, binding]),
  };
  assert.equal(preflightNeedsRecordedGuardTransition(measurementEvidence), true);
  const fromClone: PreflightTransitionEvidence = {
    ...measurementEvidence,
    recorded: new Map([...evidence.recorded, [next, hash(files.get(next)!)] ]),
    currentBody: body(next), pendingBeforeConsumer: new Set([binding]),
  };
  assert.equal(preflightNeedsRecordedGuardTransition(fromClone), true);
  for (const changed of [
    { recorded: new Map() },
    { recorded: new Map([[current, "0".repeat(64)]]) },
    { pendingBeforeConsumer: new Set([binding]) },
    { pendingBeforeConsumer: new Set([next]) },
    { currentBody: body(next) },
    { currentBody: null },
    { currentBody: currentBody + "\n" },
    { consumerSql: measurementEvidence.consumerSql + "\n" },
    { findings: [{ ...measurementEvidence.findings[0]!, code: "0703.nonzero_constraint_definition" }] },
    { findings: [...measurementEvidence.findings, { ...measurementEvidence.findings[0]!, code: "0703.measurement_guard_presence" }] },
  ]) assert.equal(preflightNeedsRecordedGuardTransition({ ...measurementEvidence, ...changed }), false);
  assert.equal(preflightNeedsRecordedGuardTransition({ ...fromClone, pendingBeforeConsumer: new Set() }), false);
  assert.equal(preflightNeedsRecordedGuardTransition({ ...fromClone,
    recorded: new Map([...fromClone.recorded, [binding, hash(files.get(binding)!)] ]), currentBody: body(binding) }), false);
  for (const filename of [current, next, binding, measurement]) {
    const changed = new Map(files); changed.set(filename, changed.get(filename)! + "\n");
    assert.equal(preflightNeedsRecordedGuardTransition({ ...measurementEvidence, published: changed }), false);
  }
  const unexpected = "generated/0702_unknown_instruction_guard.sql";
  assert.equal(preflightNeedsRecordedGuardTransition({ ...fromClone,
    published: new Map([...files, [unexpected, files.get(next)!]]),
    recorded: new Map([...fromClone.recorded, [unexpected, hash(files.get(next)!)]]) }), false);
});

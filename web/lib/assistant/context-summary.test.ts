import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSummaryPrompt,
  buildSummarySection,
  collectPinnedEntities,
  mergeResolvedEntities,
  parseSummaryModelOutput,
  shouldRefreshSummary,
  SUMMARY_EVERY_TURNS,
  type ConversationSummary,
} from "./context-summary";

function summary(overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    text: "Discussed overdue bills for Customer A.",
    entities: [{ kind: "party", id: "11111111-1111-4111-8111-111111111111", label: "Customer A" }],
    turnsCovered: 8,
    updatedAt: "2026-09-16T00:00:00.000Z",
    ...overrides,
  };
}

test("summary refreshes after every K turns, not before", () => {
  assert.equal(shouldRefreshSummary(0, null), false);
  assert.equal(shouldRefreshSummary(SUMMARY_EVERY_TURNS - 1, null), false);
  assert.equal(shouldRefreshSummary(SUMMARY_EVERY_TURNS, null), true);
  assert.equal(shouldRefreshSummary(15, summary()), false);
  assert.equal(shouldRefreshSummary(16, summary()), true);
});

test("mergeResolvedEntities dedupes by kind+id with incoming first and caps", () => {
  const existing = [
    { kind: "party" as const, id: "p1", label: "Old name" },
    { kind: "document" as const, id: "d1", label: "BILL-1" },
  ];
  const incoming = [
    { kind: "party" as const, id: "p1", label: "New name" },
    { kind: "project" as const, id: "j1", label: "Job X" },
  ];
  const merged = mergeResolvedEntities(existing, incoming, 10);
  assert.deepEqual(merged, [
    { kind: "party", id: "p1", label: "New name" },
    { kind: "project", id: "j1", label: "Job X" },
    { kind: "document", id: "d1", label: "BILL-1" },
  ]);
  const many = Array.from({ length: 30 }, (_, i) => ({ kind: "party" as const, id: `p${i}`, label: `P${i}` }));
  assert.equal(mergeResolvedEntities([], many, 20).length, 20);
});

test("collectPinnedEntities flattens pins in kind order", () => {
  const entities = collectPinnedEntities({
    document: { id: "d1", label: "BILL-0871" },
    party: { id: "p1", label: "Customer A" },
  });
  assert.deepEqual(entities, [
    { kind: "party", id: "p1", label: "Customer A" },
    { kind: "document", id: "d1", label: "BILL-0871" },
  ]);
  assert.deepEqual(collectPinnedEntities({}), []);
});

test("buildSummarySection renders nothing without a summary", () => {
  assert.equal(buildSummarySection(null), "");
  assert.equal(buildSummarySection(summary({ text: "  " })), "");
});

test("buildSummarySection renders summary plus resolved entities as data", () => {
  const section = buildSummarySection(summary());
  assert.match(section, /Conversation summary/);
  assert.match(section, /overdue bills/);
  assert.match(section, /party: Customer A/);
  assert.match(section, /11111111-1111-4111-8111-111111111111/);
  assert.match(section, /untrusted data/);
});

test("buildSummaryPrompt carries the transcript and the previous summary", () => {
  const prompt = buildSummaryPrompt("user: what is overdue?\nassistant: three bills", summary());
  assert.match(prompt, /what is overdue/);
  assert.match(prompt, /overdue bills for Customer A/);
  assert.match(prompt, /JSON/);
  assert.match(prompt, /entities/);
});

test("parseSummaryModelOutput accepts raw and fenced JSON", () => {
  const raw = JSON.stringify({
    text: "Reviewed cash and AR.",
    entities: [{ kind: "account", id: "a1", label: "Operating" }],
  });
  assert.deepEqual(parseSummaryModelOutput(raw), {
    text: "Reviewed cash and AR.",
    entities: [{ kind: "account", id: "a1", label: "Operating" }],
  });
  assert.deepEqual(parseSummaryModelOutput(`\`\`\`json\n${raw}\n\`\`\``), {
    text: "Reviewed cash and AR.",
    entities: [{ kind: "account", id: "a1", label: "Operating" }],
  });
});

test("parseSummaryModelOutput drops malformed entities and caps", () => {
  const parsed = parseSummaryModelOutput(
    JSON.stringify({
      text: "Hi",
      entities: [
        { kind: "party", id: "p1", label: "Ok" },
        { kind: "vendor", id: "v1", label: "bad kind" },
        { kind: "party", id: "", label: "empty id" },
        { kind: "party", id: "p2", label: "" },
        "not an object",
      ],
    }),
  );
  assert.deepEqual(parsed.entities, [{ kind: "party", id: "p1", label: "Ok" }]);
});

test("parseSummaryModelOutput falls back to prose when the model ignores the schema", () => {
  const parsed = parseSummaryModelOutput("The user asked about payroll and we checked two pay runs.");
  assert.match(parsed.text, /payroll/);
  assert.deepEqual(parsed.entities, []);
});

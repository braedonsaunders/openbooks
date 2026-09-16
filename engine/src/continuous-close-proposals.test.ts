import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { findingSummaryWithProposal } from "./continuous-close.ts";

// A pack's proposed command travels inside the persisted summary so the Agent
// Workbench can render the governed review card. The control plane merges it
// at persist time; packs never touch storage.
test("proposal merges into the summary under proposedCommand", () => {
  const summary = { count: 3 };
  const merged = findingSummaryWithProposal(summary, {
    tool: "match_bank_line",
    input: { bankTransactionId: "a", entryId: "b" },
    label: "Match to entry",
  });
  assert.deepEqual(merged, {
    count: 3,
    proposedCommand: {
      tool: "match_bank_line",
      input: { bankTransactionId: "a", entryId: "b" },
      label: "Match to entry",
    },
  });
  // The input summary is not mutated — re-runs must not accumulate carriers.
  assert.deepEqual(summary, { count: 3 });
});

test("absent proposal leaves the summary identical", () => {
  const summary = { count: 3 };
  assert.equal(findingSummaryWithProposal(summary, null), summary);
  assert.equal(findingSummaryWithProposal(summary, undefined), summary);
});

test("persistFinding stores the merged summary", () => {
  const source = readFileSync(new URL("./continuous-close.ts", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("async function persistFinding"));
  assert.match(body, /findingSummaryWithProposal\(finding\.summary, finding\.proposal\)/);
  assert.match(body, /\$\{JSON\.stringify\(summary\)\}::jsonb/);
});

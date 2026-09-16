import assert from "node:assert/strict";
import test from "node:test";
import {
  foldPartsIntoPins,
  hasAnaphor,
  renderPinsSection,
  updatePinsFromToolOutput,
  type EntityPins,
} from "./context-pins";

const BILL_ID = "11111111-1111-4111-8111-111111111111";
const PARTY_ID = "22222222-2222-4222-8222-222222222222";

function billOutput(n = 1) {
  return {
    ok: true,
    data: {
      total: n,
      items: Array.from({ length: n }, (_, i) => ({
        id: BILL_ID,
        kind: "bill",
        documentNumber: `BILL-087${i}`,
      })),
    },
  };
}

test("a single get_document result pins the document", () => {
  const pins = updatePinsFromToolOutput({}, "get_document", {
    ok: true,
    data: { id: BILL_ID, kind: "bill", documentNumber: "BILL-0871" },
  });
  assert.deepEqual(pins.document, { id: BILL_ID, label: "bill BILL-0871" });
});

test("ambiguous multi-result lists do not move the pin", () => {
  const before: EntityPins = { document: { id: BILL_ID, label: "bill BILL-0871" } };
  const after = updatePinsFromToolOutput(before, "find_documents", billOutput(3));
  assert.deepEqual(after, before);
});

test("a single find_documents hit pins it; parties pin the same way", () => {
  const docPins = updatePinsFromToolOutput({}, "find_documents", billOutput(1));
  assert.deepEqual(docPins.document, { id: BILL_ID, label: "bill BILL-0870" });
  const partyPins = updatePinsFromToolOutput({}, "find_parties", {
    ok: true,
    data: { items: [{ id: PARTY_ID, displayName: "Customer A" }] },
  });
  assert.deepEqual(partyPins.party, { id: PARTY_ID, label: "Customer A" });
});

test("accounts and projects pin from their single-result shapes", () => {
  const accountPins = updatePinsFromToolOutput({}, "find_accounts", {
    ok: true,
    data: { total: 1, items: [{ id: "a1", number: "1000", name: "Operating" }] },
  });
  assert.deepEqual(accountPins.account, { id: "a1", label: "1000 Operating" });
  const projectPins = updatePinsFromToolOutput({}, "project_profitability", {
    ok: true,
    data: { project: { id: "p1", name: "Job X" } },
  });
  assert.deepEqual(projectPins.project, { id: "p1", label: "Job X" });
});

test("failures and unknown tools leave pins untouched and unmutated", () => {
  const before: EntityPins = { party: { id: PARTY_ID, label: "Customer A" } };
  const snapshot = JSON.stringify(before);
  assert.deepEqual(updatePinsFromToolOutput(before, "get_document", { ok: false, error: "forbidden" }), before);
  assert.deepEqual(updatePinsFromToolOutput(before, "no_such_tool", { ok: true, data: {} }), before);
  assert.equal(JSON.stringify(before), snapshot);
});

test("hasAnaphor spots pronouns and demonstrative noun phrases", () => {
  for (const message of [
    "email them the statement",
    "what is that invoice for?",
    "close the project",
    "is it overdue?",
    "pay this bill today",
  ]) {
    assert.equal(hasAnaphor(message), true, message);
  }
  for (const message of [
    "show me bill BILL-0871",
    "what is our cash position right now?",
    "list all vendors",
  ]) {
    assert.equal(hasAnaphor(message), false, message);
  }
});

test("renderPinsSection exposes pins as data, empty when none", () => {
  assert.equal(renderPinsSection({}), "");
  const section = renderPinsSection({
    party: { id: PARTY_ID, label: "Customer A" },
    document: { id: BILL_ID, label: "bill BILL-0871" },
  });
  assert.match(section, /pinned_entities/);
  assert.match(section, /Customer A/);
  assert.match(section, /BILL-0871/);
  assert.match(section, /untrusted data|before searching/);
});

test("foldPartsIntoPins folds a turn and skips non-tool parts", () => {
  const pins = foldPartsIntoPins({}, [
    { type: "text", text: "here are your bills" },
    {
      type: "tool-find_documents",
      toolCallId: "c1",
      state: "output-available",
      input: {},
      output: billOutput(1),
    },
    { type: "dynamic-tool", toolName: "get_document", output: { ok: false, error: "gone" } },
    { type: "reasoning", text: "thinking" },
  ]);
  assert.deepEqual(pins.document, { id: BILL_ID, label: "bill BILL-0870" });
  assert.equal(pins.party, undefined);
});

test("renderPinsSection flags the just-used reference when asked", () => {
  const section = renderPinsSection({ document: { id: BILL_ID, label: "bill BILL-0871" } }, true);
  assert.match(section, /just referred to/i);
});

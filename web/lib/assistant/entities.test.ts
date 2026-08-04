import assert from "node:assert/strict";
import test from "node:test";
import {
  assistantDocumentByLabel,
  assistantEntitiesFromToolOutput,
  assistantEntityIndex,
} from "./entities";
import { assistantSystemPrompt } from "./system-prompt";

const birlaSearch = {
  ok: true,
  data: {
    total: 2,
    items: [
      {
        id: "019fbdba-eaa9-763d-b371-51c5a85b4ab5",
        kind: "customer_invoice",
        documentNumber: "INV4221",
        referenceNumber: "3100026674",
        documentDate: "2026-07-31",
        dueDate: "2026-09-14",
        status: "posted",
        currency: "CAD",
        total: 4313.16,
        party: "Birla Carbon Canada Ltd",
      },
      {
        id: "019fbdba-ea36-7429-8785-31d2a058d8c5",
        kind: "customer_invoice",
        documentNumber: "INV4220",
        documentDate: "2026-07-31",
        status: "posted",
        currency: "CAD",
        total: 3637.91,
        party: "Birla Carbon Canada Ltd",
      },
    ],
  },
};

test("historic document tool results become native record entities", () => {
  const entities = assistantEntitiesFromToolOutput(
    "find_documents",
    birlaSearch,
  );
  assert.equal(entities.documents.length, 2);
  assert.deepEqual(entities.documents[0], {
    id: "019fbdba-eaa9-763d-b371-51c5a85b4ab5",
    kind: "customer_invoice",
    documentNumber: "INV4221",
    referenceNumber: "3100026674",
    documentDate: "2026-07-31",
    dueDate: "2026-09-14",
    status: "posted",
    currency: "CAD",
    total: 4313.16,
    party: "Birla Carbon Canada Ltd",
    partyId: undefined,
    postedEntryId: undefined,
    memo: undefined,
  });
});

test("markdown document labels resolve case-insensitively from saved tool parts", () => {
  const index = assistantEntityIndex([
    {
      type: "tool-find_documents",
      state: "output-available",
      output: birlaSearch,
    },
    {
      type: "tool-get_document",
      state: "output-available",
      output: {
        ok: true,
        data: {
          id: "019fbdba-eaa9-763d-b371-51c5a85b4ab5",
          kind: "customer_invoice",
          documentNumber: "INV4221",
          party: "Birla Carbon Canada Ltd",
          partyId: "019f6c30-b667-7599-9062-2a8807c08601",
          postedEntryId: "019fbdba-eb64-73fd-820c-572040a5df21",
        },
      },
    },
    { type: "text", text: "[INV4221](/ar)" },
  ]);

  const invoice = assistantDocumentByLabel(index, "inv4221");
  assert.equal(invoice?.id, "019fbdba-eaa9-763d-b371-51c5a85b4ab5");
  assert.equal(invoice?.partyId, "019f6c30-b667-7599-9062-2a8807c08601");
  assert.equal(invoice?.postedEntryId, "019fbdba-eb64-73fd-820c-572040a5df21");
});

test("malformed tool records cannot create arbitrary drawer targets", () => {
  const entities = assistantEntitiesFromToolOutput("get_document", {
    ok: true,
    data: { id: "not-a-uuid", kind: "../admin", documentNumber: "INV4221" },
  });
  assert.deepEqual(entities.documents, []);
});

test("assistant prompt relies on native record cards instead of generic module links", () => {
  const prompt = assistantSystemPrompt({
    orgName: "Example Organization",
    baseCurrency: "CAD",
    userName: "Braedon",
    today: "2026-08-04",
    canWrite: true,
  });
  assert.match(prompt, /native, interactive record cards/);
  assert.match(
    prompt,
    /do not invent generic module links such as \/ar or \/ap/,
  );
  assert.doesNotMatch(prompt, /invoices at \/ar/);
});

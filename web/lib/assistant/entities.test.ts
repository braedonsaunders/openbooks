import assert from "node:assert/strict";
import test from "node:test";
import {
  assistantDocumentByLabel,
  assistantEntitiesFromToolOutput,
  assistantEntityIndex,
} from "./entities";
import { assistantSystemPrompt } from "./system-prompt";

const documentSearch = {
  ok: true,
  data: {
    total: 2,
    items: [
      {
        id: "01900000-0001-7000-8000-000000000001",
        kind: "customer_invoice",
        documentNumber: "INV-1002",
        referenceNumber: "PO-EXAMPLE-42",
        documentDate: "2026-01-31",
        dueDate: "2026-03-02",
        status: "posted",
        currency: "USD",
        total: 1250.75,
        party: "Example Customer",
      },
      {
        id: "01900000-0002-7000-8000-000000000002",
        kind: "customer_invoice",
        documentNumber: "INV-1001",
        documentDate: "2026-01-15",
        status: "posted",
        currency: "USD",
        total: 845.25,
        party: "Example Customer",
      },
    ],
  },
};

test("saved document tool results become native record entities", () => {
  const entities = assistantEntitiesFromToolOutput(
    "find_documents",
    documentSearch,
  );
  assert.equal(entities.documents.length, 2);
  assert.deepEqual(entities.documents[0], {
    id: "01900000-0001-7000-8000-000000000001",
    kind: "customer_invoice",
    documentNumber: "INV-1002",
    referenceNumber: "PO-EXAMPLE-42",
    documentDate: "2026-01-31",
    dueDate: "2026-03-02",
    status: "posted",
    currency: "USD",
    total: 1250.75,
    party: "Example Customer",
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
      output: documentSearch,
    },
    {
      type: "tool-get_document",
      state: "output-available",
      output: {
        ok: true,
        data: {
          id: "01900000-0001-7000-8000-000000000001",
          kind: "customer_invoice",
          documentNumber: "INV-1002",
          party: "Example Customer",
          partyId: "01900000-0003-7000-8000-000000000003",
          postedEntryId: "01900000-0004-7000-8000-000000000004",
        },
      },
    },
    { type: "text", text: "[INV-1002](/ar)" },
  ]);

  const invoice = assistantDocumentByLabel(index, "inv-1002");
  assert.equal(invoice?.id, "01900000-0001-7000-8000-000000000001");
  assert.equal(invoice?.partyId, "01900000-0003-7000-8000-000000000003");
  assert.equal(invoice?.postedEntryId, "01900000-0004-7000-8000-000000000004");
});

test("malformed tool records cannot create arbitrary drawer targets", () => {
  const entities = assistantEntitiesFromToolOutput("get_document", {
    ok: true,
    data: { id: "not-a-uuid", kind: "../admin", documentNumber: "INV-1002" },
  });
  assert.deepEqual(entities.documents, []);
});

test("assistant prompt relies on native record cards instead of generic module links", () => {
  const prompt = assistantSystemPrompt({
    orgName: "Example Organization",
    baseCurrency: "USD",
    userName: "Example User",
    today: "2026-01-31",
    canWrite: true,
  });
  assert.match(prompt, /native, interactive record cards/);
  assert.match(
    prompt,
    /do not invent generic module links such as \/ar or \/ap/,
  );
  assert.doesNotMatch(prompt, /invoices at \/ar/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { buildDuplicateSeed } from "./cash-sales-duplicate.ts";

test("a batch seeds lines and tender shape without close-out facts", () => {
  const seed = buildDuplicateSeed({
    partyId: "123e4567-e89b-12d3-a456-426614174000",
    lines: [
      {
        account_id: "223e4567-e89b-12d3-a456-426614174000",
        item_id: null,
        quantity: "1",
        unit_price: "100.0000",
        amount: "100.0000",
        description: "Day sales",
        tax_code_id: "323e4567-e89b-12d3-a456-426614174000",
        tax_group_id: null,
      },
    ],
    tenders: [
      {
        kind: "cash",
        method_label: null,
        account_id: "423e4567-e89b-12d3-a456-426614174000",
        stored_value_account_id: null,
        amount: "60.0000",
        reference: null,
      },
      {
        kind: "card",
        method_label: "Visa",
        account_id: "523e4567-e89b-12d3-a456-426614174000",
        stored_value_account_id: null,
        amount: "40.0000",
        reference: "AUTH-1",
      },
    ],
  });
  assert.deepEqual(seed, {
    partyId: "123e4567-e89b-12d3-a456-426614174000",
    lines: [
      {
        accountId: "223e4567-e89b-12d3-a456-426614174000",
        quantity: "1",
        unitPrice: "100.0000",
        amount: "100.0000",
        description: "Day sales",
        taxCodeId: "323e4567-e89b-12d3-a456-426614174000",
      },
    ],
    tenders: [
      { kind: "cash", accountId: "423e4567-e89b-12d3-a456-426614174000", amount: "60.0000" },
      {
        kind: "card",
        methodLabel: "Visa",
        accountId: "523e4567-e89b-12d3-a456-426614174000",
        amount: "40.0000",
        reference: "AUTH-1",
      },
    ],
  });
});

test("unseedable lines drop and an empty batch seeds nothing", () => {
  assert.equal(
    buildDuplicateSeed({
      partyId: null,
      lines: [
        {
          account_id: null,
          item_id: null,
          quantity: null,
          unit_price: null,
          amount: null,
          description: null,
          tax_code_id: null,
          tax_group_id: null,
        },
      ],
      tenders: [],
    }),
    null,
  );
});

test("a non-uuid party pools instead of naming garbage", () => {
  const seed = buildDuplicateSeed({
    partyId: "not-a-party",
    lines: [
      {
        account_id: "223e4567-e89b-12d3-a456-426614174000",
        item_id: null,
        quantity: null,
        unit_price: null,
        amount: "5.0000",
        description: null,
        tax_code_id: null,
        tax_group_id: null,
      },
    ],
    tenders: [],
  });
  assert.equal(seed?.partyId, null);
  assert.equal(seed?.lines.length, 1);
  assert.deepEqual(seed?.tenders, []);
});

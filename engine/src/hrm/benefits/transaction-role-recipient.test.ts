import assert from "node:assert/strict";
import { test } from "node:test";
import {
  transactionRoleRecipient,
  type TransactionRoleEvidence,
} from "./transaction-role-recipient.ts";
const evidence: TransactionRoleEvidence = {
  ticket_reference: "ticket",
  ticket_id: "ticket",
  project_reference: "project",
  project_id: "project",
  ticket_foreman: "foreman",
  ticket_superintendent: null,
  project_foreman: "alternate",
  project_manager: "manager",
};
test("omitted and false context fallback retain empty-role fallback behavior", () => {
  for (const setting of [undefined, false])
    assert.equal(
      transactionRoleRecipient("field_ticket_superintendent", "project_manager", setting, evidence),
      "manager",
    );
});
test("a present ticket with an empty role never falls back under context-only policy", () => {
  assert.equal(
    transactionRoleRecipient("field_ticket_superintendent", "project_manager", true, evidence),
    null,
  );
  assert.equal(
    transactionRoleRecipient("field_ticket_foreman", "project_manager", true, evidence),
    "foreman",
  );
});
test("an absent ticket selects its available project fallback and an absent fallback remains unassigned", () => {
  const absent = { ...evidence, ticket_reference: null, ticket_id: null, ticket_foreman: null };
  assert.equal(
    transactionRoleRecipient("field_ticket_foreman", "project_manager", true, absent),
    "manager",
  );
  assert.equal(
    transactionRoleRecipient("field_ticket_foreman", "project_manager", true, {
      ...absent,
      project_reference: null,
      project_id: null,
      project_manager: null,
    }),
    null,
  );
});
test("unknown selected or referenced source contexts refuse rather than become absence", () => {
  assert.throws(
    () => transactionRoleRecipient("field_ticket_foreman", "project_manager", true, undefined),
    /no retained recipient-source context/,
  );
  assert.throws(
    () =>
      transactionRoleRecipient("field_ticket_foreman", "project_manager", true, {
        ...evidence,
        ticket_id: null,
      }),
    /unavailable ticket or project/,
  );
  assert.throws(
    () =>
      transactionRoleRecipient("field_ticket_foreman", "project_manager", true, {
        ...evidence,
        ticket_reference: null,
        ticket_id: null,
        ticket_foreman: null,
        project_id: null,
      }),
    /unavailable ticket or project/,
  );
  assert.throws(
    () =>
      transactionRoleRecipient("project_manager", "field_ticket_foreman", true, {
        ...evidence,
        project_reference: null,
      }),
    /conflicting native identity/,
  );
  for (const holder of [undefined, 42]) {
    const malformed = { ...evidence, ticket_foreman: holder } as unknown as TransactionRoleEvidence;
    assert.throws(
      () => transactionRoleRecipient("field_ticket_foreman", "project_manager", true, malformed),
      /unknown recorded role evidence/,
    );
  }
});

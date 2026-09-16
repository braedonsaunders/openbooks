import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

// Proposal resolution (b06): a finding's carried { tool, input, label } must
// resolve to the chat's governed card shape with a viewer-bound token, and
// anything unresolvable must fail closed to null.
process.env.SESSION_SECRET ??= "b06-proposal-test-secret-must-be-32+chars!!";
const root = pathToFileURL(process.cwd() + "/").href;
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
  if (specifier.startsWith("@/")) {
    const path = root + "web/" + specifier.slice(2);
    for (const suffix of [".ts", ".tsx", "/index.ts", "/index.tsx"]) if (existsSync(new URL(path + suffix))) return next(path + suffix, context);
    return next(path, context);
  }
  return next(specifier, context);
} });
const { carriedProposal, findingProposalCommand } = await import("./proposals");
const { verifyApplicationCommand } = await import("../assistant/application-proposals");
const { applicationTool } = await import("../application/tool-catalog");
import type { Authz } from "../authz";

const UID = "11111111-2222-4333-8444-555555555555";
function authzWith(perms: string[]): Authz {
  return {
    user: {
      id: "99999999-0000-4000-8000-000000000001",
      email: "teller@scratch.test",
      name: "Teller",
      roles: [],
      orgId: "88888888-0000-4000-8000-000000000001",
      envKind: "production",
      productionOrgId: "88888888-0000-4000-8000-000000000001",
      isSuperAdmin: false,
      homeUserId: "99999999-0000-4000-8000-000000000001",
      homeOrgId: "88888888-0000-4000-8000-000000000001",
    },
    permissions: new Set(perms),
    allowedSubsidiaryIds: null,
  } as unknown as Authz;
}

const MATCH_INPUT = {
  reconciliationId: UID,
  statementLineId: UID,
  journalLineIds: [UID],
  idempotencyKey: "b06-test-key-01",
};

test("carried proposal resolves to a signed governed card", () => {
  const authz = authzWith(["assistant.use", "assistant.write", "banking.reconcile"]);
  const card = findingProposalCommand(authz, {
    proposedCommand: { tool: "match_bank_line", input: MATCH_INPUT, label: "Match to entry" },
  });
  assert.ok(card);
  assert.equal(card.toolName, "match_bank_line");
  assert.equal(card.title, "Match to entry");
  assert.equal(card.destructive, false);
  assert.deepEqual(card.input, MATCH_INPUT);
  assert.equal(
    verifyApplicationCommand(card.toolName, card.input, card.confirmToken, authz),
    true,
    "the minted token verifies for the same viewer and input",
  );
});

test("proposal resolution fails closed", () => {
  const authz = authzWith(["assistant.use", "assistant.write", "banking.reconcile"]);
  // No carrier.
  assert.equal(findingProposalCommand(authz, {}), null);
  assert.equal(findingProposalCommand(authz, { proposedCommand: { tool: "", input: {} } }), null);
  // Unknown tool (e.g. an assistant-side tool name packs may propose).
  assert.equal(
    findingProposalCommand(authz, { proposedCommand: { tool: "draft_journal_entry", input: {}, label: "Draft" } }),
    null,
  );
  // Read-only catalog tool.
  const readOnly = "get_vitals";
  assert.ok(applicationTool(readOnly)?.readOnly, "test premise: tool is read-only");
  assert.equal(
    findingProposalCommand(authz, { proposedCommand: { tool: readOnly, input: {}, label: "List" } }),
    null,
  );
  // Carried input that no longer validates.
  assert.equal(
    findingProposalCommand(authz, { proposedCommand: { tool: "match_bank_line", input: {}, label: "Match" } }),
    null,
  );
  // Viewer outside the tool's gate.
  const clerk = authzWith(["assistant.use"]);
  assert.equal(
    findingProposalCommand(clerk, { proposedCommand: { tool: "match_bank_line", input: MATCH_INPUT, label: "Match" } }),
    null,
  );
});

test("carrier shape validation", () => {
  assert.equal(carriedProposal({}), null);
  assert.equal(carriedProposal({ proposedCommand: null }), null);
  assert.equal(carriedProposal({ proposedCommand: { tool: "x", input: [] } }), null);
  const carrier = carriedProposal({ proposedCommand: { tool: "x", input: { a: 1 } } });
  assert.deepEqual(carrier, { tool: "x", input: { a: 1 }, label: undefined });
});

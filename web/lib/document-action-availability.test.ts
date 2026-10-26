import assert from "node:assert/strict";
import test from "node:test";
import { documentActionAvailable, type DocumentActionFacts } from "./document-action-availability";

const ALL_ACTIONS = ["submit", "post", "void", "delete", "returnToDraft", "withdraw"] as const;

function facts(overrides: Partial<DocumentActionFacts>): DocumentActionFacts {
  return {
    status: "draft",
    directPost: false,
    canCreate: true,
    canPost: true,
    submittedByViewer: false,
    ...overrides,
  };
}

function offered(input: DocumentActionFacts): string[] {
  return ALL_ACTIONS.filter((action) => documentActionAvailable(action, input));
}

test("a posted cash sale offers no Post or Delete, only a governed void", () => {
  const cashSale = facts({ status: "posted", directPost: true });
  assert.deepEqual(offered(cashSale), ["void"]);
  assert.equal(documentActionAvailable("post", cashSale), false);
  assert.equal(documentActionAvailable("delete", cashSale), false);
  assert.equal(documentActionAvailable("submit", cashSale), false);
});

test("a posted record offers void only to a holder of the post grant", () => {
  assert.equal(documentActionAvailable("void", facts({ status: "posted", canPost: false })), false);
  assert.equal(documentActionAvailable("void", facts({ status: "posted" })), true);
});

test("a posted approval-routed record never offers Post or Delete either", () => {
  const invoice = facts({ status: "posted", directPost: false });
  assert.deepEqual(offered(invoice), ["void"]);
});

test("a voided record offers no lifecycle action", () => {
  assert.deepEqual(offered(facts({ status: "voided", directPost: true })), []);
});

test("a draft direct-post cash sale posts and deletes but does not route for approval", () => {
  assert.deepEqual(offered(facts({ status: "draft", directPost: true })), ["post", "delete"]);
});

test("a draft approval-routed bill submits, and only deletes with create rights", () => {
  assert.deepEqual(offered(facts({ status: "draft", directPost: false })), ["submit", "delete"]);
  assert.deepEqual(offered(facts({ status: "draft", directPost: false, canCreate: false })), []);
});

test("an approved record posts and can return to draft or void with the post grant", () => {
  assert.deepEqual(offered(facts({ status: "approved", directPost: false })), [
    "post",
    "void",
    "returnToDraft",
  ]);
  assert.deepEqual(offered(facts({ status: "approved", directPost: false, canPost: false })), []);
});

test("withdraw is offered only while the submission is pending approval", () => {
  for (const status of ["draft", "approved", "posted", "voided"]) {
    assert.equal(
      documentActionAvailable("withdraw", facts({ status, submittedByViewer: true })),
      false,
      `${status} must not offer withdraw`,
    );
  }
  assert.equal(
    documentActionAvailable(
      "withdraw",
      facts({ status: "pending_approval", submittedByViewer: true }),
    ),
    true,
  );
});

test("the submitter of a pending estimate may withdraw with the create grant alone", () => {
  const estimate = facts({
    status: "pending_approval",
    submittedByViewer: true,
    canCreate: true,
    canPost: false,
  });
  assert.deepEqual(offered(estimate), ["withdraw"]);
});

test("the submitter may withdraw with the approve grant alone", () => {
  const submitterApprover = facts({
    status: "pending_approval",
    submittedByViewer: true,
    canCreate: false,
    canPost: true,
  });
  assert.equal(documentActionAvailable("withdraw", submitterApprover), true);
});

test("the submitter without any grant on the kind may not withdraw", () => {
  const stripped = facts({
    status: "pending_approval",
    submittedByViewer: true,
    canCreate: false,
    canPost: false,
  });
  assert.equal(documentActionAvailable("withdraw", stripped), false);
});

test("a non-submitter withdraws only with the approve grant, never with create alone", () => {
  assert.equal(
    documentActionAvailable(
      "withdraw",
      facts({ status: "pending_approval", canCreate: true, canPost: false }),
    ),
    false,
    "a create-only colleague must not see a withdraw the engine would refuse",
  );
  assert.equal(
    documentActionAvailable(
      "withdraw",
      facts({ status: "pending_approval", canCreate: false, canPost: true }),
    ),
    true,
    "an approver may withdraw a submission they did not make",
  );
});

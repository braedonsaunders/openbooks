import assert from "node:assert/strict";
import test from "node:test";

const { registerHooks } = await import("node:module");
const { stubModules } = await import("../../../../testing/stub-modules");
stubModules({
  navigation: "export function useRouter(){return {push(){},refresh(){},replace(){}}}",
  intl: true,
});
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "sonner") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const toast={success(){},error(){}}",
      };
    }
    return next(specifier, context);
  },
});

const React = await import("react");
Object.assign(globalThis, { React });
const { renderToStaticMarkup } = await import("react-dom/server");
const { NextIntlClientProvider } = await import("next-intl");
const { ChangeGateDecision } = await import("./ChangeGateDecision");

const GATE_ID = "55555555-5555-5555-8555-555555555555";

function render(decision: {
  canAct: boolean;
  awaitingAnother: boolean;
  signatureRequired?: boolean;
  canDelegate?: boolean;
}) {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale="en"
      messages={{
        common: {
          actions: { approve: "Approve", reject: "Reject" },
          approvalFlow: { awaitingAnother: "Awaiting another approver" },
        },
        approvals: {
          gates: { delegatePlaceholder: "Delegate to…" },
          decide: { decisionFailed: "Decision failed" },
        },
      }}
      timeZone="UTC"
    >
      <ChangeGateDecision
        gateId={GATE_ID}
        canAct={decision.canAct}
        awaitingAnother={decision.awaitingAnother}
        signatureRequired={decision.signatureRequired ?? false}
        canDelegate={decision.canDelegate ?? false}
        users={[]}
      />
    </NextIntlClientProvider>,
  );
}

test("the change drawer decides through the native gate path", () => {
  const markup = render({ canAct: true, awaitingAnother: false });
  assert.match(markup, /Approve/, "the approver sees Approve beside the proposal");
  assert.match(markup, /Reject/, "the approver sees Reject beside the proposal");
});

test("the change drawer names SoD instead of offering a refused decision", () => {
  const markup = render({ canAct: false, awaitingAnother: true });
  assert.match(markup, /Awaiting another approver/, "the submitter sees who must act");
  assert.doesNotMatch(markup, /Reject/, "no decision action is offered");
});

test("the change drawer stays quiet for a bystander", () => {
  assert.equal(render({ canAct: false, awaitingAnother: false }), "", "no gate block renders");
});

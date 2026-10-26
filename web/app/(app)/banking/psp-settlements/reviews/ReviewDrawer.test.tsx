import { recordApprovalState } from "../../../../../testing/record-approval-state";
import assert from "node:assert/strict";
import test from "node:test";
import { bootJsdomEnvironment } from "../../../../../testing/jsdom-env";
import { stubModules } from "../../../../../testing/stub-modules";

await bootJsdomEnvironment({ matchMediaMatches: false });
stubModules({ navigation: true });
const React = await import("react");
Object.assign(globalThis, { React });
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../../../messages/en")).default;
const { PromptRoot } = await import("../../../../../lib/prompt");
const { PspDisputeReviewDrawer } = await import("./ReviewDrawer");

const strings = {
  kindRow: "Kind",
  statusRow: "Status",
  amountRow: "Amount",
  eventRow: "Event",
  providerRefRow: "Provider reference",
  reasonGivenRow: "Reason",
  receiptRow: "Receipt",
  invoiceRow: "Invoice",
  historyTitle: "History",
  approveLabel: "Approve",
  rejectLabel: "Reject",
  reasonLabel: "Reason for rejection",
  reasonPlaceholder: "Enter at least five characters",
  decidedNote: "This review is resolved; the queue keeps it for the record.",
  approvedMessage: "Review approved and posted.",
  rejectedMessage: "The review could not be resolved.",
  closeLabel: "Close",
};

test("a successful rejection reports resolution instead of the failure fallback", async (t) => {
  const priorFetch = globalThis.fetch;
  let posted: Record<string, unknown> | null = null;
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith("/api/flows/record-state"))
      return Response.json(
        recordApprovalState({ status: "pending_review", gateId: "gate-1", canDecide: true }),
      );
    posted = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ ok: true });
  };
  t.after(() => {
    globalThis.fetch = priorFetch;
  });

  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <PromptRoot />
        <PspDisputeReviewDrawer
          review={{
            id: "dispute-1",
            providerLabel: "Card processor",
            kindLabel: "Dispute",
            statusLabel: "Pending",
            isPending: true,
            amount: "$80.00",
            providerEventId: "evt-1",
            providerRef: null,
            reason: null,
            receiptNumber: null,
            invoiceNumber: null,
            history: [],
            canDecide: true,
            closeHref: "/banking/psp-settlements/reviews",
            strings,
          }}
        />
      </NextIntlClientProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

  const reject = [...document.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "Reject",
  );
  assert.ok(reject);
  await act(async () => {
    reject.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(posted, null, "no decision precedes the reviewer reason");
  const prompt = document.querySelector('[aria-labelledby="prompt-title"]')!;
  const field = prompt.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
      field,
      "Evidence does not match",
    );
    field.dispatchEvent(new window.Event("input", { bubbles: true }));
    field.dispatchEvent(new window.FocusEvent("focusout", { bubbles: true }));
  });
  await act(async () => {
    prompt
      .querySelector("form")!
      .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.deepEqual(posted, {
    gateId: "gate-1",
    decision: "rejected",
    comment: "Evidence does not match",
  });
  assert.ok(document.body.textContent?.includes(messages.common.approvalFlow.decisionRecorded));
  assert.ok(!document.body.textContent?.includes(strings.rejectedMessage));
  assert.equal(document.querySelector('[role="alert"]'), null);
});

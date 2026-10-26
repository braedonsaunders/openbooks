import assert from "node:assert/strict";
import test from "node:test";
import { bootJsdomEnvironment } from "../../../../../testing/jsdom-env";
import { stubModules } from "../../../../../testing/stub-modules";

await bootJsdomEnvironment({ matchMediaMatches: false });
stubModules({
  navigation: true,
  extra: {
    sonner: "export const toast={success(){},error(){},warning(){}}",
    "@braedonsaunders/appkit-errors":
      'export class ActionError extends Error { constructor(value){super(value.serverMessage)} } export function classifiedError(){return {kind:"failure"}} export function kindForStatus(){return "failure"} export function readActionResult(){return {ok:true,value:{}}} export function transportError(message){return new Error(message)}',
    "@braedonsaunders/appkit-errors/react": "export function ActionAlert(){return null}",
    "@/lib/use-app-action":
      "export function useAppAction(){return {busy:false,refusal:null,execute:async()=>{}}}",
    "@/lib/confirm": "export async function confirmDialog(){return true}",
  },
});
const React = await import("react");
Object.assign(globalThis, { React });
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../../../messages/en")).default;
const { PayoutLineDrawer } = await import("./PayoutLineDrawer");

const strings = {
  kindRow: "Kind",
  amountRow: "Amount",
  referenceRow: "Reference",
  descriptionRow: "Description",
  batchRow: "Batch",
  settledRow: "Settled",
  proposalTitle: "Proposal",
  proposalLoading: "Loading proposal",
  proposalFailed: "Proposal could not load",
  evidenceTitle: "Evidence",
  applyLabel: "Apply",
  confirmTitle: "Confirm proposal",
};
const line = (id: string) => ({
  id,
  providerLabel: "Card processor",
  kindLabel: "Charge",
  amount: "$40.00",
  externalRef: null,
  description: `Line ${id}`,
  batchRef: "batch-1",
  settledDate: "2026-10-05",
  canDecide: false,
  strings,
});

test("switching payout lines clears a prior suggestion loading error", async (t) => {
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (String(input).includes("/line-a/"))
      return Response.json({ error: "Line A proposal failed" }, { status: 422 });
    return Response.json({
      suggestion: {
        lineId: "line-b",
        code: "proposal_found",
        candidates: [
          {
            rank: 0,
            kind: "manual",
            label: "Review line B",
            detail: "No automatic match is safe.",
            confidence: "low",
            evidence: ["The reference is incomplete."],
          },
        ],
        similarCount: 1,
        explanation: "Line B needs a manual review.",
      },
    });
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
  const render = (id: string) =>
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <PayoutLineDrawer line={line(id)} />
      </NextIntlClientProvider>,
    );
  await act(async () => {
    render("line-a");
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  assert.ok(document.body.textContent?.includes("Line A proposal failed"));

  await act(async () => {
    render("line-b");
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  assert.ok(document.body.textContent?.includes("Review line B"));
  assert.ok(!document.body.textContent?.includes("Line A proposal failed"));
  assert.ok(!document.body.textContent?.includes(strings.proposalFailed));
});

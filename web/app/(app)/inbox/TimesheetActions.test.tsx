import assert from "node:assert/strict";
import test from "node:test";

const { stubModules } = await import("../../../testing/stub-modules");
stubModules({ navigation: "export function useRouter(){return {push(){},refresh(){},replace(){}}}", intl: true });
const { registerHooks } = await import("node:module");
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
const { TimesheetActions } = await import("./TimesheetActions");

function render(): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale="en"
      messages={{
        common: { actions: { approve: "Approve" }, status: { approved: "Approved" } },
        approvals: { decide: { decisionFailed: "Decision failed" } },
      }}
      timeZone="UTC"
    >
      <TimesheetActions itemId="timesheet_approval:11111111-1111-1111-8111-111111111111" />
    </NextIntlClientProvider>,
  );
}

test("week rows offer Approve through the native direct-approval path", () => {
  const markup = render();
  assert.match(markup, /Approve/, "the approver sees Approve beside the week");
  assert.doesNotMatch(markup, /Reject/, "direct weeks carry no reject action");
});

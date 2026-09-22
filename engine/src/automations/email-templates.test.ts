import test from "node:test";
import assert from "node:assert/strict";
import { renderAutomationEmailTemplate } from "./email-templates.ts";
import { AutomationContractError } from "./triggers.ts";

test("automation_notice renders the automation name, never a placeholder", () => {
  const draft = renderAutomationEmailTemplate("automation_notice", {
    automationName: "Welcome tasks",
    subjectEntity: "employment",
  });
  assert.equal(draft.subject, "Automation: Welcome tasks");
  assert.match(draft.body, /Welcome tasks/);
  assert.match(draft.body, /employment/);
  assert.doesNotMatch(draft.body, /Template .* for automation run/);
});

test("manual runs without a subject still render", () => {
  const draft = renderAutomationEmailTemplate("automation_notice", {
    automationName: "Weekly nudge",
    subjectEntity: null,
  });
  assert.match(draft.body, /Weekly nudge/);
});

test("unknown template keys refuse with the valid keys named", () => {
  assert.throws(
    () => renderAutomationEmailTemplate("probe", { automationName: "x", subjectEntity: null }),
    (e: unknown) =>
      e instanceof AutomationContractError &&
      /unknown email template 'probe'/.test((e as Error).message) &&
      /automation_notice/.test((e as Error).message),
  );
});

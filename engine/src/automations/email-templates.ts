import { AUTOMATION_EMAIL_TEMPLATE_KEYS, AutomationContractError } from "./triggers.ts";

/**
 * Automation send_email templates (the templateKey registry).
 *
 * The send_email action names a template but carries no subject or body of
 * its own, so the key must resolve to a REAL shared template: each entry
 * renders a subject/body draft through the shared packages/emails shell
 * (flowNotificationEmail — the same builder flows/send_email uses), with
 * the automation's own context interpolated. Unknown keys refuse at
 * publish (triggers.ts checks AUTOMATION_EMAIL_TEMPLATE_KEYS) and here
 * at render for already-stored rows — never a literal placeholder body.
 */

export type AutomationEmailContext = {
  automationName: string;
  subjectEntity: string | null;
};

export type AutomationEmailDraft = {
  subject: string;
  body: string;
};

function noticeBody(ctx: AutomationEmailContext): string {
  const firedFor = ctx.subjectEntity ? ` fired for ${ctx.subjectEntity}` : " fired";
  return [
    `Automation \u201c${ctx.automationName}\u201d${firedFor}.`,
    "",
    "Review the automation and its recent runs in OpenBooks \u2192 Admin \u2192 Automations.",
  ].join("\n");
}

const TEMPLATES: Record<string, { describe: string; render: (ctx: AutomationEmailContext) => AutomationEmailDraft }> = {
  automation_notice: {
    describe: "Short notice that an automation fired, naming the automation and the entity it fired for.",
    render: (ctx) => ({
      subject: `Automation: ${ctx.automationName}`,
      body: noticeBody(ctx),
    }),
  },
};

export function renderAutomationEmailTemplate(
  templateKey: string,
  ctx: AutomationEmailContext,
): AutomationEmailDraft {
  const template = TEMPLATES[templateKey];
  if (!template) {
    throw new AutomationContractError(
      `unknown email template '${templateKey}' — use one of: ${AUTOMATION_EMAIL_TEMPLATE_KEYS.join(", ")} — fix the action and save again`,
    );
  }
  if (!ctx.automationName.trim()) {
    throw new AutomationContractError("email template needs the automation name it renders — reload the automation and try again");
  }
  return template.render(ctx);
}

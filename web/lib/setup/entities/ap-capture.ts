import type { SetupEntity, SetupEntityValidationHook, SetupOption } from "../types";

const providers: SetupOption[] = ["postmark", "mailgun", "sendgrid", "generic"].map((value) => ({
  value,
  labelKey: `apCapture.providers.${value}`,
}));

/** A limit stated without its currency could never be compared; refuse it at the form. */
const validateAutoPostPolicy: SetupEntityValidationHook = async ({ body }) => {
  const amount = body.maxAmount;
  const currency = body.maxAmountCurrency;
  const hasAmount = amount !== undefined && amount !== null && String(amount).trim() !== "";
  const hasCurrency = currency !== undefined && currency !== null && String(currency).trim() !== "";
  if (hasAmount !== hasCurrency)
    return "Enter the maximum amount together with its currency, or leave both empty.";
  return null;
};

/**
 * AP capture intake and its posting policy. Inbound addresses save through
 * their domain endpoint (the token is generated and the signing secret
 * sealed there); the auto-post policy is an immutable, effective-dated
 * version like every other financial policy.
 */
export const AP_CAPTURE_ENTITIES: SetupEntity[] = [
  {
    key: "ap-capture-mailboxes",
    table: "ap_capture_mailboxes",
    groupKey: "billing",
    iconKey: "upload",
    orgScoped: true,
    actorCols: true,
    hasActive: true,
    allowDelete: false,
    orderBy: "label",
    importVia: "none",
    docSlug: "ap-email-inbox",
    mutationPath: "/api/ap-capture/mailboxes",
    mutationCreateKeys: [
      "subsidiaryId",
      "label",
      "emailAddress",
      "provider",
      "allowedSenders",
      "isActive",
      "signingSecret",
    ],
    mutationUpdateKeys: [
      "label",
      "emailAddress",
      "provider",
      "allowedSenders",
      "isActive",
      "signingSecret",
      "clearSigningSecret",
      "rotateToken",
    ],
    formDescriptionKey: "apCapture.mailboxHelp",
    columns: [
      { key: "label", kind: "text", labelKey: "apCapture.fields.label" },
      { key: "subsidiaryId", kind: "ref", ref: "subsidiaries" },
      { key: "emailAddress", kind: "text", labelKey: "apCapture.fields.emailAddress" },
      { key: "provider", kind: "badge", options: providers, labelKey: "apCapture.fields.provider" },
      { key: "token", kind: "code", labelKey: "apCapture.fields.token" },
      { key: "isActive", kind: "badge-active" },
    ],
    fields: [
      {
        key: "subsidiaryId",
        kind: "ref",
        ref: "subsidiaries",
        required: true,
        lockedOnEdit: true,
        legalEntity: true,
        helpTextKey: "apCapture.help.subsidiaryId",
      },
      { key: "label", kind: "text", required: true, labelKey: "apCapture.fields.label" },
      {
        key: "emailAddress",
        kind: "text",
        labelKey: "apCapture.fields.emailAddress",
        helpTextKey: "apCapture.help.emailAddress",
      },
      {
        key: "provider",
        kind: "select",
        required: true,
        options: providers,
        defaultValue: "postmark",
        labelKey: "apCapture.fields.provider",
        helpTextKey: "apCapture.help.provider",
      },
      {
        key: "allowedSenders",
        kind: "stringArray",
        fullWidth: true,
        labelKey: "apCapture.fields.allowedSenders",
        helpTextKey: "apCapture.help.allowedSenders",
      },
      { key: "isActive", kind: "boolean", defaultValue: true },
      {
        key: "signingSecret",
        kind: "text",
        inputOnly: true,
        labelKey: "apCapture.fields.signingSecret",
        helpTextKey: "apCapture.help.signingSecret",
      },
      {
        key: "clearSigningSecret",
        kind: "boolean",
        inputOnly: true,
        defaultValue: false,
        labelKey: "apCapture.fields.clearSigningSecret",
        helpTextKey: "apCapture.help.clearSigningSecret",
      },
      {
        key: "rotateToken",
        kind: "boolean",
        inputOnly: true,
        defaultValue: false,
        labelKey: "apCapture.fields.rotateToken",
        helpTextKey: "apCapture.help.rotateToken",
      },
    ],
  },
  {
    key: "ap-capture-autopost-policies",
    table: "ap_capture_autopost_policies",
    groupKey: "billing",
    iconKey: "book-open",
    orgScoped: true,
    actorCols: true,
    hasActive: false,
    allowUpdate: false,
    allowDelete: false,
    orderBy: "effective_from desc",
    docSlug: "ap-email-inbox",
    // Turning on automatic posting delegates posting authority, so only
    // someone who may post bills can record a version.
    writePermission: "ap.post",
    formDescriptionKey: "apCapture.policyHelp",
    validateWrite: validateAutoPostPolicy,
    columns: [
      { key: "effectiveFrom", kind: "date" },
      { key: "enabled", kind: "boolean", labelKey: "apCapture.fields.enabled" },
      { key: "cleanStreak", kind: "number", labelKey: "apCapture.fields.cleanStreak" },
      { key: "maxAmount", kind: "number", labelKey: "apCapture.fields.maxAmount" },
      { key: "maxAmountCurrency", kind: "text", labelKey: "apCapture.fields.maxAmountCurrency" },
    ],
    fields: [
      { key: "effectiveFrom", kind: "date", required: true },
      {
        key: "enabled",
        kind: "boolean",
        defaultValue: false,
        labelKey: "apCapture.fields.enabled",
        helpTextKey: "apCapture.help.enabled",
      },
      {
        key: "cleanStreak",
        kind: "integer",
        required: true,
        min: 2,
        max: 20,
        defaultValue: 3,
        labelKey: "apCapture.fields.cleanStreak",
        helpTextKey: "apCapture.help.cleanStreak",
      },
      {
        key: "maxAmount",
        kind: "decimal",
        decimalScale: 4,
        labelKey: "apCapture.fields.maxAmount",
        helpTextKey: "apCapture.help.maxAmount",
      },
      {
        key: "maxAmountCurrency",
        kind: "ref",
        ref: "currencies",
        labelKey: "apCapture.fields.maxAmountCurrency",
        showWhen: { field: "maxAmount", present: true },
        clearWhenHidden: true,
      },
      { key: "reason", kind: "textarea", required: true },
    ],
  },
];

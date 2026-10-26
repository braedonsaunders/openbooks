import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { SECURITY_EVENT_KINDS } from "@openbooks/engine/equity";
import { auditActionLabel, auditActionLabelKey } from "./audit-action-label";

const LOCALES = ["en", "de", "es", "fr", "ja", "pt-BR", "zh"] as const;

function translator(locale: string) {
  const actions = (
    JSON.parse(
      readFileSync(new URL(`../messages/${locale}/admin.json`, import.meta.url), "utf8"),
    ) as { audit: { actions: Record<string, string> } }
  ).audit.actions;
  const lookup = (key: string) => actions[key.replace(/^actions\./, "")];
  const t = ((key: string) => lookup(key) ?? key) as unknown as {
    (key: never): string;
    has(key: never): boolean;
  };
  t.has = ((key: string) => lookup(key) !== undefined) as never;
  return t;
}

test("every security event an equity command records, and its posting, reads with a label in every locale", () => {
  for (const locale of LOCALES) {
    const t = translator(locale);
    for (const kind of SECURITY_EVENT_KINDS) {
      for (const action of [`equity.event.${kind}`, `equity.${kind}`]) {
        const label = auditActionLabel(t, action, () => "");
        assert.ok(
          label !== "" && !label.includes("equity"),
          `${locale}: ${action} reads as "${label}"`,
        );
      }
    }
  }
});

test("an audit action keys its label with dots as underscores and falls back to the caller for an unlabelled action", () => {
  assert.equal(auditActionLabelKey("equity.round.amend"), "actions.equity_round_amend");
  const t = translator("en");
  assert.equal(
    auditActionLabel(t, "equity.event.forfeit", (code) => code),
    "Forfeiture recorded",
  );
  assert.equal(
    auditActionLabel(t, "post", (code) => code),
    "post",
  );
  assert.equal(
    auditActionLabel(t, "inventory.count.close", (code) => code.toUpperCase()),
    "INVENTORY.COUNT.CLOSE",
  );
});

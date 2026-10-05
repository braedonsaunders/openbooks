import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createTranslator } from "next-intl";
import type { CatalogMessageFn } from "./catalog-strings";
import { customerStrings } from "./customer-strings";
import { healthStrings } from "./health-strings";
import { auditEventArgs, sentinelStrings } from "./sentinel-strings";
import { spendVelocityStrings } from "./spend-velocity-strings";
import { trueCostStrings } from "./true-cost-strings";
import { utilizationStrings } from "./utilization-strings";
import { vendorStrings } from "./vendor-strings";

function catalogTranslator(locale: string): CatalogMessageFn {
  const analytics = JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "..", "messages", locale, "analytics.json"), "utf8"),
  );
  const translate = createTranslator({ locale, messages: { analytics }, namespace: "analytics" });
  return (key, values) => translate(key, values as Record<string, string | number | Date> | undefined);
}

type BundleProbe = { name: string; render: (t: CatalogMessageFn, locale: string) => string; french: string };

const probes: BundleProbe[] = [
  { name: "customer", render: (t, locale) => customerStrings(t, locale).churnSingle, french: "Client à transaction unique" },
  { name: "health", render: (t, locale) => healthStrings(t, locale).noInterestExpense, french: "Aucune charge d'intérêts" },
  { name: "sentinel", render: (t, locale) => sentinelStrings(t, locale).weekendReason(false), french: "Comptabilisé un samedi" },
  { name: "spend velocity", render: (t, locale) => spendVelocityStrings(t, locale).anomalies(1).message, french: "1 anomalie critique nécessite une investigation" },
  { name: "true cost", render: (t, locale) => trueCostStrings(t, locale).formulaError, french: "Résultat de formule invalide" },
  { name: "utilization", render: (t, locale) => utilizationStrings(t, locale).displayEmployeeTitle("No Title"), french: "Sans titre" },
  { name: "vendor", render: (t, locale) => vendorStrings(t, locale).displayVendorName("Unknown"), french: "Inconnu" },
];

test("analytics string bundles resolve through each request locale catalog", () => {
  const english = catalogTranslator("en");
  const french = catalogTranslator("fr");
  for (const probe of probes) {
    assert.equal(probe.render(french, "fr"), probe.french, `${probe.name} French catalog copy`);
    const englishValue = probe.render(english, "en");
    for (const locale of ["es", "de", "pt-BR", "ja", "zh"]) {
      assert.notEqual(probe.render(catalogTranslator(locale), locale), englishValue, `${locale} ${probe.name} copy`);
    }
  }
});

test("audit summaries retain stable action and field data", () => {
  assert.deepEqual(
    auditEventArgs("update", "a1b2c3d4-ffff", "parties", "9f8e7d6c-ffff", '{"email":"a@b.c","phone":"1"}'),
    { verb: "updated", action: "update", actor: "a1b2c3d4", table: "parties", row: "9f8e7d6c", fields: "email, phone" },
  );
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

interface Catalog {
  [key: string]: string | Catalog;
}
function leaves(catalog: Catalog, prefix = ""): Record<string, string> {
  return Object.fromEntries(
    Object.entries(catalog).flatMap(([key, value]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      return typeof value === "string" ? [[path, value]] : Object.entries(leaves(value, path));
    }),
  );
}
async function catalog(locale: string): Promise<Catalog> {
  const file = new URL(`../../../../messages/${locale}/payroll.json`, import.meta.url);
  const payroll = JSON.parse(await readFile(file, "utf8"));
  assert.ok(
    payroll.openingBalances?.levySource,
    `${locale} exposes the native opening source namespace`,
  );
  return payroll.openingBalances.levySource;
}
const english = leaves(await catalog("en"));
for (const locale of ["en", "fr", "de", "es", "pt-BR", "ja", "zh"]) {
  test(`${locale} supplies all opening levy source labels, refusals and evidence limits`, async () => {
    const translated = leaves(await catalog(locale));
    assert.deepEqual(Object.keys(translated).sort(), Object.keys(english).sort());
    for (const [key, value] of Object.entries(translated))
      assert.ok(value.trim(), `${locale}.${key} is nonempty`);
    if (locale !== "en") {
      for (const key of [
        "help",
        "evidenceLimits",
        "sealed",
        "staleDraft",
        "restoreEin",
        "loadFailed",
        "saveFailed",
      ]) {
        assert.notEqual(translated[key], english[key], `${locale}.${key} is translated`);
      }
    }
  });
}

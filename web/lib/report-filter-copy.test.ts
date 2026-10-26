import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PERIOD_PRESETS, PERIOD_PRESET_GROUP_LABELS } from "@openbooks/reports";
import { DEFAULT_SEGMENT_ALL_KEY, isDefaultSegmentName } from "./segment-labels.ts";

/**
 * Period preset names and their group headings come from one catalog, the
 * `periodLabels` namespace, in every locale: the filter bar, the custom
 * report filter, the close package picker and every presented report window
 * read them by stable preset id. Default built-in segment names resolve to
 * the fully-translated All-X keys while a tenant-renamed segment keeps its
 * verbatim name.
 */
const LOCALES = ["en", "es", "fr", "de", "ja", "pt-BR", "zh"] as const;

type FilterBarCatalog = {
  filterBar?: {
    payPeriods?: unknown;
  };
};

type PeriodLabelsCatalog = { presets?: Record<string, unknown>; groups?: Record<string, unknown> };

function filterBar(locale: string): NonNullable<FilterBarCatalog["filterBar"]> {
  const catalog = JSON.parse(
    readFileSync(new URL(`../messages/${locale}/reports.json`, import.meta.url), "utf8"),
  ) as FilterBarCatalog;
  assert.ok(catalog.filterBar, `${locale} is missing the reports.filterBar block`);
  return catalog.filterBar;
}

function periodLabels(locale: string): PeriodLabelsCatalog {
  return JSON.parse(
    readFileSync(new URL(`../messages/${locale}/periodLabels.json`, import.meta.url), "utf8"),
  ) as PeriodLabelsCatalog;
}

test("every period preset has a translated label in every locale", () => {
  assert.ok(PERIOD_PRESETS.length > 0, "no period presets were loaded — the import broke");
  const missing: string[] = [];
  for (const locale of LOCALES) {
    const presets = periodLabels(locale).presets ?? {};
    for (const preset of PERIOD_PRESETS) {
      if (typeof presets[preset.id] !== "string" || !(presets[preset.id] as string).trim()) {
        missing.push(`${locale}:periodLabels.presets.${preset.id}`);
      }
    }
  }
  assert.deepEqual(missing, [], `presets with no label:\n${missing.join("\n")}`);
});

test("every preset group has a translated heading in every locale", () => {
  const missing: string[] = [];
  for (const locale of LOCALES) {
    const groups = periodLabels(locale).groups ?? {};
    for (const group of Object.keys(PERIOD_PRESET_GROUP_LABELS)) {
      if (typeof groups[group] !== "string" || !(groups[group] as string).trim()) {
        missing.push(`${locale}:periodLabels.groups.${group}`);
      }
    }
  }
  assert.deepEqual(missing, [], `preset groups with no heading:\n${missing.join("\n")}`);
});

test("no non-English locale ships an English preset name or group heading", () => {
  const english = periodLabels("en");
  const leaks: string[] = [];
  for (const locale of LOCALES.filter((code) => code !== "en")) {
    const catalog = periodLabels(locale);
    for (const preset of PERIOD_PRESETS) {
      if (
        catalog.presets?.[preset.id] === english.presets?.[preset.id] ||
        catalog.presets?.[preset.id] === preset.label
      )
        leaks.push(`${locale}:presets.${preset.id}`);
    }
    for (const [group, heading] of Object.entries(PERIOD_PRESET_GROUP_LABELS)) {
      if (
        catalog.groups?.[group] === english.groups?.[group] ||
        catalog.groups?.[group] === heading
      )
        leaks.push(`${locale}:groups.${group}`);
    }
  }
  assert.deepEqual(leaks, [], `English preset copy in a translated catalog:\n${leaks.join("\n")}`);
});

test("the pay-periods optgroup label exists in every locale", () => {
  for (const locale of LOCALES) {
    const value = filterBar(locale).payPeriods;
    assert.ok(
      typeof value === "string" && value.trim(),
      `${locale} is missing filterBar.payPeriods`,
    );
  }
});

test("default built-in segment names are recognized; renames are not", () => {
  assert.equal(
    isDefaultSegmentName({ key: "project", name: "Project", pluralName: "Projects" }),
    true,
  );
  assert.equal(
    isDefaultSegmentName({ key: "project", name: "Projet", pluralName: "Projets" }),
    false,
  );
  assert.equal(
    isDefaultSegmentName({ key: "project", name: "Project", pluralName: "Projets" }),
    false,
  );
  assert.equal(
    isDefaultSegmentName({ key: "region", name: "Region", pluralName: "Regions" }),
    false,
  );
  assert.equal(isDefaultSegmentName(undefined), false);
});

test("every default built-in segment maps to a fully-translated All-X key", () => {
  for (const key of ["department", "project", "location", "class"]) {
    const allKey = (DEFAULT_SEGMENT_ALL_KEY as Record<string, string>)[key];
    assert.ok(typeof allKey === "string" && allKey.length > 0, `no All-X key for ${key}`);
    for (const locale of LOCALES) {
      const catalog = JSON.parse(
        readFileSync(new URL(`../messages/${locale}/reports.json`, import.meta.url), "utf8"),
      ) as FilterBarCatalog;
      const value: unknown = (catalog.filterBar as Record<string, unknown> | undefined)?.[allKey];
      assert.ok(
        typeof value === "string" && value.trim(),
        `${locale} is missing filterBar.${allKey}`,
      );
    }
  }
});

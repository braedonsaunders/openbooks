import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { NextIntlClientProvider, type AbstractIntlMessages } from "next-intl";
import enMessages from "../../../messages/en/index";
import frMessages from "../../../messages/fr/index";
import { PropertiesTable } from "./PropertiesTable";
import type { PropertyWorkspace } from "./types";
import type { ListViewConfig } from "@openbooks/customization";

// F-t09-017: the property buildings table rendered hardcoded English
// headers (PROPERTY/CODE/ENTITY/LOCATION/TYPE/OCCUPANCY/STATUS) and raw
// enum cells (Residential/active) under fr. Render the table under the fr
// catalog and prove every chrome string resolves to French.
const view = {
  schemaVersion: 1,
  recordType: "property",
  columns: [
    "name",
    "code",
    "subsidiary",
    "location",
    "property_type",
    "occupancy",
    "currency",
    "status",
  ].map((key) => ({ key, visible: true })),
  filters: [],
} as unknown as ListViewConfig;

const data = {
  properties: [
    {
      id: "prop-fr",
      code: "IM-001",
      name: "Centre Ville",
      propertyType: "residential",
      status: "active",
      currency: "EUR",
      address: null,
      custom: null,
      subsidiaryId: "sub-1",
      subsidiaryName: "Filiale Paris",
      locationId: null,
      locationName: null,
      fixedAssetId: null,
      rentIncomeAccountId: null,
      camIncomeAccountId: null,
      depositLiabilityAccountId: null,
      defaultBankAccountId: null,
      unitCount: 10,
      occupiedUnits: 7,
    },
  ],
  units: [],
  leases: [],
  charges: [],
  escalations: [],
  schedules: [],
  deposits: [],
  camPools: [],
  camAllocations: [],
} as unknown as PropertyWorkspace;

/**
 * The app deep-merges each locale over English (web/i18n/request.ts), so a
 * key omitted into the declared fallback manifest renders English. Mirror
 * that merge here so the render matches production exactly.
 */
function merge(base: unknown, overlay: unknown): unknown {
  if (
    base !== null &&
    overlay !== null &&
    typeof base === "object" &&
    typeof overlay === "object" &&
    !Array.isArray(base) &&
    !Array.isArray(overlay)
  ) {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [key, value] of Object.entries(overlay as Record<string, unknown>)) {
      out[key] = key in out ? merge(out[key], value) : value;
    }
    return out;
  }
  return overlay;
}

const messagesFr = merge(enMessages, frMessages) as AbstractIntlMessages;

function renderFrTable(tableData: PropertyWorkspace): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="fr" messages={messagesFr} timeZone="UTC">
      <PropertiesTable
        data={tableData}
        view={view}
        fieldDefs={[]}
        onOpen={() => {}}
      />
    </NextIntlClientProvider>,
  );
}

function renderFr(): string {
  return renderFrTable(data);
}

test("property buildings table headers render French, never English (F-t09-017)", () => {
  const html = renderFr();
  for (const header of [
    "Immeuble",
    "Entité",
    "Emplacement",
    "Occupation",
    "Devise",
    "Statut",
  ]) {
    assert.ok(html.includes(header), `fr render is missing header ${header}`);
  }
  for (const english of [
    ">Property<",
    ">Entity<",
    ">Location<",
    ">Occupancy<",
    ">Currency<",
    ">Status<",
  ]) {
    assert.ok(
      !html.includes(english),
      `fr render leaks English header ${english}`,
    );
  }
  // Cognates omitted into the declared fallback manifest render English by
  // design — as translated copy, never as raw key paths.
  assert.ok(html.includes(">Code<"), "fallback Code header must render");
  assert.ok(!html.includes("list.columns"), "no raw key path may leak");
});

test("property type and status cells resolve through the catalog (F-t09-017)", () => {
  const html = renderFr();
  // F-v4-001: each row describes a building (un immeuble, masculine — the
  // "Immeuble"/"Type"/"Statut" headers), so the type/status adjectives agree
  // masculine. The catalog previously carried the feminine forms.
  assert.ok(
    html.includes(">Résidentiel<"),
    "fr render must translate the residential type",
  );
  assert.ok(
    html.includes(">Actif<"),
    "fr render must translate the active status",
  );
  for (const feminine of [
    "Résidentielle",
    "Commerciale",
    "Industrielle",
    "Vendue",
    ">Active<",
    ">Inactive<",
  ]) {
    assert.ok(!html.includes(feminine), `fr render must not use feminine ${feminine}`);
  }
  assert.ok(!html.includes("Residential"), "raw English type must not leak");
  assert.ok(!html.includes("Not mapped"), "English not-mapped must not leak");
  assert.ok(html.includes("Non associé"), "unmapped location needs French copy");
});

test("property buildings empty state renders French (F-t09-017)", () => {
  const html = renderFrTable({ ...data, properties: [] });
  assert.ok(
    html.includes("Aucun immeuble pour le moment"),
    "fr empty title must resolve",
  );
  assert.ok(
    !html.includes("No properties yet"),
    "English empty title must not leak",
  );
});

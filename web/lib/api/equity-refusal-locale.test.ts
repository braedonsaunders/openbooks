import assert from "node:assert/strict";
import test from "node:test";
import { createTranslator } from "next-intl";
import { stubModules } from "../../testing/stub-modules.ts";
import de from "../../messages/de/index.ts";
import en from "../../messages/en/index.ts";

// The reader's locale and catalogs the request carries: German, with English beneath it as the app serves it.
const stateKey = Symbol.for("openbooks.equity-refusal-locale-test");
(globalThis as Record<symbol, unknown>)[stateKey] = { de, en, createTranslator };
stubModules({
  navigation: false,
  intl: `const state = globalThis[Symbol.for('openbooks.equity-refusal-locale-test')];
const { createTranslator } = state;
const merge = (base, overlay) => { const out = { ...base }; for (const [k, v] of Object.entries(overlay)) out[k] = v && typeof v === 'object' && out[k] && typeof out[k] === 'object' ? merge(out[k], v) : v; return out; };
export async function getLocale() { return 'de' }
export async function getTranslations(namespace) { return createTranslator({ locale: 'de', messages: merge(state.en, state.de), namespace }) }`,
  authz: false,
  features: false,
});

const { EquityError } = await import("@openbooks/engine/equity");
const { apiErrorResponse } = await import("./error-response");

const germanDate = (iso: string) =>
  new Intl.DateTimeFormat("de", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${iso}T12:00:00Z`));

test("an equity refusal reaches the reader in the reader language, with its figures formatted and its contract fields kept", async () => {
  const error = new EquityError("exerciseExceedsVested", {
    field: "quantity",
    values: {
      ceiling: { kind: "shares", value: 12500n },
      event: { kind: "choice", value: "exercise" },
      date: { kind: "date", value: "2026-03-01" },
    },
  });
  const response = await apiErrorResponse(error);
  assert.equal(response.status, 409);
  const body = (await response.json()) as {
    code: string;
    field: string;
    error: string;
    remedy: string;
  };
  assert.deepEqual([body.code, body.field], ["equity_event_exceeds_vested", "quantity"]);
  assert.match(body.error, /12\.500/);
  assert.ok(body.error.includes(germanDate("2026-03-01")));
  assert.doesNotMatch(
    `${body.error} ${body.remedy}`,
    /\b(the|units|vested|record|no more than)\b/i,
    "no English sentence reaches a German reader",
  );
});

test("a remedy names a field with the label the form shows in the reader language", async () => {
  const response = await apiErrorResponse(
    new EquityError("preMoneyBasisTooShort", {
      field: "preMoneyBasisReason",
      values: {
        field: { kind: "term", key: "equity.fields.preMoneyBasisReason", text: "Pre-money basis" },
        min: { kind: "count", value: 5 },
        max: { kind: "count", value: 2000 },
      },
    }),
  );
  const body = (await response.json()) as { error: string; remedy: string };
  assert.equal(de.equity.fields.preMoneyBasisReason, "Grundlage der Pre-Money-Bewertung");
  assert.ok(body.remedy.includes("Grundlage der Pre-Money-Bewertung"), body.remedy);
  assert.ok(body.error.includes("2.000"), "the bound reads with German grouping");
});

test("a refusal whose catalog entry is missing keeps its own English text rather than a raw key", async () => {
  const error = new EquityError("featureOff");
  const missing = Object.assign(Object.create(Object.getPrototypeOf(error)), error, {
    catalogKey: "equity.notInTheCatalog",
    message: error.message,
    remedy: error.remedy,
  });
  const body = (await (await apiErrorResponse(missing)).json()) as {
    error: string;
    remedy: string;
  };
  assert.equal(body.error, error.message);
  assert.equal(body.remedy, error.remedy);
});

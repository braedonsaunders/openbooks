import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CASH_DETECTOR_KEYS } from "./agents/cash.ts";
import {
  defaultContinuousCloseDetectors,
  detectorSpecsForAgent,
  enabledDetectorKeys,
  normalizeContinuousCloseDetectors,
} from "./continuous-close-config.ts";

const source = readFileSync(new URL("./agents/cash.ts", import.meta.url), "utf8");

test("the cash-alerts pack owns three detectors, on by default", () => {
  assert.deepEqual([...CASH_DETECTOR_KEYS], [
    "cash_low_balance",
    "cash_bill_crunch",
    "cash_forecast_shortfall",
  ]);
  assert.deepEqual(
    detectorSpecsForAgent("cash").map((spec) => spec.detectorKey),
    [...CASH_DETECTOR_KEYS],
  );
  const defaults = defaultContinuousCloseDetectors("cash");
  for (const key of CASH_DETECTOR_KEYS) {
    assert.ok(
      enabledDetectorKeys(defaults).includes(key),
      `${key} defaults on`,
    );
  }
  assert.throws(
    () =>
      normalizeContinuousCloseDetectors("cash", {
        cash_forecast_shortfall: { parameters: { forecastWeeks: 0 } },
      }),
    /invalid detector parameter/,
  );
});

test("cash alerts reuse the cockpit's liquidity primitives, not copies", () => {
  // Starting cash is the inception-to-date bank read: whole months from the
  // summary, the as-of month from the lines, legs restricted to bank
  // accounts, translated at the closing spot — fail closed on missing rates.
  assert.match(source, /from gl_month_activity g/);
  assert.match(source, /sliver_entries as materialized/);
  assert.match(source, /type = 'asset_bank' and is_summary = false and is_active/);
  assert.match(source, /no spot rate for/);
  // Open items reconstruct what was collectible AS OF the date — gross line
  // minus applications dated on/before it — with credit memos netting on the
  // same control account, translated at the closing spot like the cockpit.
  assert.match(source, /x\.applied_on <= \$\{asOf\}/);
  assert.match(source, /jl\.is_open_item/);
  // The open-item population is the shared const, never a re-listed literal:
  // expense_report membership is decided once in open-item-kinds.ts.
  assert.match(source, /\.\.\/open-item-kinds\.ts/);
  assert.match(source, /AP_OPEN_ITEM_KINDS/);
  assert.match(source, /AR_OPEN_ITEM_KINDS/);
  // Settlement stats come from the maintained rollup (sufficient statistics
  // per party-day), weighted globally, 45-day default without history.
  assert.match(source, /from party_payment_stats/);
  assert.match(source, /settled_on >= \$\{asOf\}::date - 365/);
  assert.match(source, /: 45/);
  // Predicted dates follow the cockpit rule exactly: statistical or global
  // average from the transaction date, floored at the due date, overdue
  // pushed forward, weekends rolled — then bucketed into Sunday-start weeks.
  assert.match(source, /method = "Statistical"/);
  assert.match(source, /method = "Due date"/);
  assert.match(source, /method = "Overdue push"/);
  assert.match(source, /getUTCDay\(\)/);
  // The timeline pays AP oldest-due-first up to the week's capacity (the
  // board's weekly cap over the safe-cash bound) and defers the rest — the
  // alert fires on the timeline's own lowest point.
  assert.match(source, /Oldest due date first, then largest amount/);
  assert.match(source, /lowestCash/);
  assert.match(source, /openItemCashOnly: true/, "the category-recurrer boundary is declared on the finding");
  // Scheduling knobs are the board's own config, clamped like the surface.
  assert.match(source, /settings -> 'analytics' -> 'cashflow'/);
  assert.match(source, /weeklyApCap/);
  assert.match(source, /restrictToSafe/);
  assert.match(source, /agentKey: "cash"/, "findings belong to the cash pack");
  for (const fingerprint of [
    "cash-low-balance",
    "cash-bill-crunch",
    "cash-forecast-shortfall",
  ]) {
    assert.ok(source.includes(fingerprint), `fingerprint ${fingerprint} is stable`);
  }
});

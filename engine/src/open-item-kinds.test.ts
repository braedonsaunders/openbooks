import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { AP_OPEN_ITEM_KINDS, AR_OPEN_ITEM_KINDS } from "./open-item-kinds.ts";

/**
 * F-u1-P5.1 — every open-payables/open-receivables reader must name the same
 * kind population. The dashboard tiles and cockpits, the formal aging and
 * its detail, and the cash-alerts transcription each carried their own
 * literal list; `expense_report` was in the tile's list but absent from the
 * aging's, so an org with outstanding expense reports saw AP tile ≠ AP aging
 * detail/buckets. The population now lives exactly once, here.
 */
test("open-item kind membership is decided once", () => {
  assert.deepEqual([...AR_OPEN_ITEM_KINDS], ["customer_invoice", "customer_credit"]);
  // A posted out-of-pocket expense report is money the company owes a person:
  // an aging of what we owe that omits it is incomplete. Company-paid card
  // spend stays out through the posting invariant (card-liability control
  // lines are never stamped is_open_item), not through this list.
  assert.ok(
    (AP_OPEN_ITEM_KINDS as readonly string[]).includes("expense_report"),
    "AP open items include expense reports",
  );
  assert.deepEqual([...AP_OPEN_ITEM_KINDS].sort(), ["expense_report", "vendor_bill", "vendor_credit"]);
});

/**
 * Re-divergence is un-buildable: the three readers must reference the const,
 * and none may carry a literal open-balance kind list. A fourth literal list
 * anywhere in these files fails this test — add the kind here instead.
 */
const OPEN_ITEM_READERS = [
  "web/lib/cash/open-items.ts",
  "web/lib/reports/aging.ts",
  "engine/src/agents/cash.ts",
] as const;

test("open-item readers share the kinds const, never a literal list", () => {
  for (const file of OPEN_ITEM_READERS) {
    const source = readFileSync(resolve(process.cwd(), file), "utf8");
    assert.match(
      source,
      /AP_OPEN_ITEM_KINDS/,
      `${file} must read the shared AP population`,
    );
    assert.match(
      source,
      /AR_OPEN_ITEM_KINDS/,
      `${file} must read the shared AR population`,
    );
    assert.doesNotMatch(
      source,
      /d\.kind\s+in\s*\(\s*'/,
      `${file} carries a literal open-balance kind list instead of the const`,
    );
  }
});

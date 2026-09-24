import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { PAYMENT_FILE_STATUSES } from "@openbooks/engine/src/payments/file-statuses.ts";
import { paymentFiles } from "../../../../schema/src/payment-operations.ts";

/**
 * Every payment_files status the engine can write must render in the
 * RunDrawer in every locale. The drawer looks labels up as
 * runDrawer.fileStatus.<status> and a missing key throws MISSING_MESSAGE —
 * so an unlabeled state crashes the drawer instead of degrading. The
 * covered set is derived, never hand-listed: the engine's exported
 * PAYMENT_FILE_STATUSES plus the drizzle file-status enum it must cover.
 */
const statuses: readonly string[] = PAYMENT_FILE_STATUSES;

function localeDirs(): string[] {
  return readdirSync("web/messages", { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => {
      try {
        readFileSync(`web/messages/${name}/payments.json`, "utf8");
        return true;
      } catch {
        return false;
      }
    });
}

test("every engine file status has a RunDrawer label in every locale", () => {
  const locales = localeDirs();
  assert.ok(locales.length > 0, "expected locale directories under web/messages");
  for (const locale of locales) {
    const catalog = JSON.parse(readFileSync(`web/messages/${locale}/payments.json`, "utf8")) as {
      runDrawer?: { fileStatus?: Record<string, unknown> };
    };
    for (const status of statuses) {
      const label = catalog.runDrawer?.fileStatus?.[status];
      assert.equal(
        typeof label,
        "string",
        `${locale}/payments.json runDrawer.fileStatus.${status} is missing — the RunDrawer crashes on files in this state`,
      );
      assert.ok((label as string).trim().length > 0, `${locale} fileStatus.${status} must not be blank`);
    }
  }
});

test("the derived list covers every file state the drizzle model admits", () => {
  const engineStatuses = new Set(statuses);
  const modeled = (paymentFiles.status as unknown as { enumValues?: string[] }).enumValues ?? [];
  assert.ok(modeled.length > 0, "expected the drizzle file status enum to be introspectable");
  for (const status of modeled) {
    assert.ok(engineStatuses.has(status), `PAYMENT_FILE_STATUSES must cover the modeled file state '${status}'`);
  }
});

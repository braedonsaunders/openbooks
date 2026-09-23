import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { paymentFiles } from "../../../../schema/src/payment-operations.ts";

/**
 * Every payment_files status the engine can write must render in the
 * RunDrawer in every locale. The drawer looks labels up as
 * runDrawer.fileStatus.<status> and a missing key throws MISSING_MESSAGE —
 * so an unlabeled state crashes the drawer instead of degrading. The
 * covered set is derived, never hand-listed: the engine's own
 * PAYMENT_FILE_STATUSES export (parsed from its source) plus the drizzle
 * file-status enum it must cover.
 */

const engineSource = readFileSync("engine/src/payments/operations.ts", "utf8");

function engineFileStatuses(): string[] {
  const block = engineSource.match(/export const PAYMENT_FILE_STATUSES = \[([\s\S]*?)\] as const/);
  assert.ok(block, "the engine must keep publishing PAYMENT_FILE_STATUSES for this test to derive from");
  const statuses = [...block[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  assert.ok(statuses.length > 0, "PAYMENT_FILE_STATUSES must not be empty");
  assert.equal(new Set(statuses).size, statuses.length, "PAYMENT_FILE_STATUSES must not repeat a status");
  return statuses;
}

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
  const statuses = engineFileStatuses();
  const locales = localeDirs();
  assert.ok(locales.length > 0, "expected locale directories under web/messages");
  // The two delivery-claim states are the point of this test: fail loudly
  // with their names if the engine list ever drops them.
  assert.ok(statuses.includes("delivering"), "PAYMENT_FILE_STATUSES must include delivering");
  assert.ok(statuses.includes("delivery_uncertain"), "PAYMENT_FILE_STATUSES must include delivery_uncertain");
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
  const statuses = new Set(engineFileStatuses());
  const modeled = (paymentFiles.status as unknown as { enumValues?: string[] }).enumValues ?? [];
  assert.ok(modeled.length > 0, "expected the drizzle file status enum to be introspectable");
  for (const status of modeled) {
    assert.ok(statuses.has(status), `PAYMENT_FILE_STATUSES must cover the modeled file state '${status}'`);
  }
});

test("the derived list names states the engine actually writes", () => {
  // The list is a claim about code: each member must appear as a written
  // file state in the engine source, so the catalog cannot drift ahead of
  // — or silently drop — a state the lifecycle produces.
  for (const status of engineFileStatuses()) {
    assert.ok(
      engineSource.includes(`'${status}'`),
      `PAYMENT_FILE_STATUSES lists '${status}' but the engine source never writes that literal`,
    );
  }
});

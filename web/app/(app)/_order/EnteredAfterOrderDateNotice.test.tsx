import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import "../dashboard/_dashboard-render-harness";
import { mountDashboard } from "../dashboard/_dashboard-render-harness";

// Await-imports so the harness registers its module hooks first.
const { EnteredAfterOrderDateNotice } = await import("./EnteredAfterOrderDateNotice");

const dir = dirname(fileURLToPath(import.meta.url));
const MESSAGES = join(dir, "..", "..", "..", "messages");
const loadPurchaseOrders = (locale: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(MESSAGES, locale, "purchaseOrders.json"), "utf8")) as Record<
    string,
    unknown
  >;

test("a purchase order entered after its order date names the gap in days", async () => {
  const { host, unmount } = await mountDashboard(<EnteredAfterOrderDateNotice days={331} />, {
    purchaseOrders: loadPurchaseOrders("en"),
  });
  try {
    assert.equal(host.textContent, "Entered 331 days after its order date");
  } finally {
    await unmount();
  }
});

test("a purchase order without a notable gap renders nothing", async () => {
  const { host, unmount } = await mountDashboard(<EnteredAfterOrderDateNotice days={null} />, {
    purchaseOrders: loadPurchaseOrders("en"),
  });
  try {
    assert.equal(host.textContent, "");
  } finally {
    await unmount();
  }
});

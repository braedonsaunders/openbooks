import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  parseStoredRecents,
  recentStorageKey,
  rememberRecent,
  type StoredRecent,
} from "./search-recent.ts";
import { RECENT_LIMIT, SEARCH_RECORD_TYPES } from "./search-types.ts";

const LOCALES = ["en", "fr", "es", "de", "pt-BR", "zh", "ja"];

test("recents are scoped to one user in one organization", () => {
  assert.notEqual(recentStorageKey("org-a:user-1"), recentStorageKey("org-b:user-1"));
  assert.notEqual(recentStorageKey("org-a:user-1"), recentStorageKey("org-a:user-2"));
});

test("a reopened result moves to the front once, and the list stays bounded", () => {
  let list: StoredRecent[] = [];
  for (let index = 0; index < RECENT_LIMIT + 3; index++) {
    list = rememberRecent(list, { type: "contact", id: `party-${index}` });
  }
  assert.equal(list.length, RECENT_LIMIT);
  list = rememberRecent(list, { type: "contact", id: "party-5" });
  assert.deepEqual(list[0], { type: "contact", id: "party-5" });
  assert.equal(list.filter((entry) => entry.id === "party-5").length, 1);
  list = rememberRecent(list, { type: "page", id: "party-5" });
  assert.equal(list.filter((entry) => entry.id === "party-5").length, 2);
});

test("stored references carry only a type and an id, and anything else is dropped", () => {
  const raw = JSON.stringify([
    { type: "transaction", id: "doc-1" },
    { type: "page", id: "/journal" },
    { type: "unknown-kind", id: "x" },
    { type: "contact" },
    { type: "contact", id: "" },
    "not-an-object",
    null,
  ]);
  assert.deepEqual(parseStoredRecents(raw), [
    { type: "transaction", id: "doc-1" },
    { type: "page", id: "/journal" },
  ]);
  assert.deepEqual(parseStoredRecents("{not json"), []);
  assert.deepEqual(parseStoredRecents(JSON.stringify({ type: "contact", id: "a" })), []);
});

test("work orders are a searchable record type, and a stored work order reference survives a reload", () => {
  assert.ok((SEARCH_RECORD_TYPES as readonly string[]).includes("work_order"));
  assert.deepEqual(
    parseStoredRecents(
      JSON.stringify([{ type: "work_order", id: "00000000-0000-4000-8000-000000000005" }]),
    ),
    [{ type: "work_order", id: "00000000-0000-4000-8000-000000000005" }],
  );
});

for (const locale of LOCALES) {
  test(`${locale}: the work order search group has a translated label`, () => {
    const shell = JSON.parse(
      readFileSync(new URL(`../messages/${locale}/shell.json`, import.meta.url), "utf8"),
    ) as {
      globalSearch?: { groups?: Record<string, string> };
    };
    const label = shell.globalSearch?.groups?.workOrders;
    assert.ok(typeof label === "string", `${locale}: shell.globalSearch.groups.workOrders`);
    assert.notEqual(label.trim(), "");
  });
}

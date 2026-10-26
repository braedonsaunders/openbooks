import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { SETUP_ENTITIES, setupColumnHeader } from "./registry";
import { LOCALE_CODES } from "../../i18n/config";

// A Setup list header reads the column's own label, then its declared label
// key, then `fields.<key>` under admin.setup: the rule the shared Setup list
// applies. Every header of an entity listed there must resolve in every
// locale. Rehomed entities render on their owning module's surface, which
// labels its own columns.

function lookup(messages: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined,
      messages,
    );
}

for (const locale of LOCALE_CODES) {
  test(`every Setup list column header resolves in ${locale}`, () => {
    const admin = JSON.parse(
      readFileSync(join(process.cwd(), "web", "messages", locale, "admin.json"), "utf8"),
    ) as {
      setup: unknown;
    };
    const missing: string[] = [];
    for (const entity of SETUP_ENTITIES.filter((candidate) => !candidate.rehomed)) {
      for (const column of entity.columns ?? []) {
        setupColumnHeader(column, (key) => {
          if (typeof lookup(admin.setup, key) !== "string")
            missing.push(`${entity.key}.${column.key} → admin.setup.${key}`);
          return key;
        });
      }
    }
    assert.deepEqual(missing, []);
  });
}

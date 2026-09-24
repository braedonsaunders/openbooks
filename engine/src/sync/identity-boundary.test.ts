import assert from "node:assert/strict";
import test from "node:test";
import { loadEntities } from "./migrate.ts";
import type { MigrationSource } from "./source.ts";

function source(name: string, refKey: string): MigrationSource {
  return { name, refKey, baseCurrency: "CAD" } as MigrationSource;
}

test("connector source names and adapter keys refuse unstable identities before DB work", async () => {
  await assert.rejects(
    () => loadEntities(source("Quick Books", "qboId"), "00000000-0000-0000-0000-000000000001", null, undefined, undefined, []),
    /connector name must be a stable source namespace/,
  );
  await assert.rejects(
    () => loadEntities(source("qbo", "qbo id"), "00000000-0000-0000-0000-000000000001", null, undefined, undefined, []),
    /connector refKey must be a stable JSON object key/,
  );
});

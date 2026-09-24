import assert from "node:assert/strict";
import { test } from "node:test";
import { createSandbox } from "./lifecycle.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test("createSandbox names an unknown tier before looking up its production source", { skip: !DB }, async () => {
  await assert.rejects(
    createSandbox({
      productionOrgId: "00000000-0000-4000-8000-000000000000",
      name: "Invalid tier",
      tier: "unmasked-everything" as never,
    }),
    /invalid sandbox tier.*choose dev, masked, full, or as_of/,
  );
});

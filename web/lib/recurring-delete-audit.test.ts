import assert from "node:assert/strict";
import test from "node:test";

test("the delete-conflict message exists in en, es, and fr", async () => {
  // The collections client renders through the ar.collections namespace;
  // the key must exist (non-empty) wherever the client can run, without
  // pinning the exact copy.
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  for (const locale of ["en", "es", "fr"]) {
    const catalog = JSON.parse(readFileSync(join(process.cwd(), "web", "messages", locale, "ar.json"), "utf8")) as Record<
      string, unknown
    >;
    const collections = catalog["collections"] as Record<string, Record<string, unknown>>;
    const message = collections?.["recurring"]?.["generatedDocumentsDeleteConflict"];
    assert.equal(typeof message, "string", `${locale} must carry the delete-conflict message`);
    assert.ok((message as string).length > 0, `${locale} delete-conflict message must not be empty`);
  }
});

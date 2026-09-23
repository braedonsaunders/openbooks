import assert from "node:assert/strict";
import test from "node:test";
import { flowPdfTemplateMeta } from "./pdf-hook.ts";

// The flow-email outbox payload is the durable issuance record for an
// attached record PDF. Its meta carries string values only, so the template
// provenance flattens to string fields — id + revision + content hash for a
// saved template, hash alone for a starter render.

test("a templated attachment flattens to string meta fields", () => {
  assert.deepEqual(
    flowPdfTemplateMeta({ id: "template-1", revision: 3, hash: "abc123" }),
    { pdfTemplateId: "template-1", pdfTemplateRevision: "3", pdfTemplateHash: "abc123" },
  );
});

test("a starter attachment keeps only its content hash", () => {
  assert.deepEqual(flowPdfTemplateMeta({ id: null, revision: null, hash: "abc123" }), {
    pdfTemplateHash: "abc123",
  });
});

test("no attachment means no template meta", () => {
  assert.deepEqual(flowPdfTemplateMeta(undefined), {});
});

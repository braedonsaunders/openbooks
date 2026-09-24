import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { z } from "zod";
import { DOCUMENT_REVISION_PATTERN } from "../api/registry-data.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    return nextResolve(specifier, context);
  },
});

const { ApplicationError } = await import("./errors.ts");
const { applicationWriteValue, normalizeDocumentRecordRevisions } = await import("./records.ts");
const { applicationTool } = await import("./tool-catalog.ts");
const { domainFailure } = await import("./documents.ts");
const { DocumentEditError } = await import("../../../engine/src/records/document-edit-policy.ts");

const EXACT_REVISION = "2026-08-24T12:34:56.123456Z";
const ID = "00000000-0000-4000-8000-000000000001";
const IDEMPOTENCY_KEY = "document-occ-test-1";

test("generic document reads replace the lossy Date with the exact persisted revision", () => {
  const lossy = new Date("2026-08-24T12:34:56.123Z");
  const [record] = normalizeDocumentRecordRevisions("documents", [{
    id: ID,
    updated_at: lossy,
    __documentRevision: EXACT_REVISION,
  }]);
  assert.equal(record?.updated_at, EXACT_REVISION);
  assert.equal("__documentRevision" in (record ?? {}), false);
  assert.equal(new Date(EXACT_REVISION).getTime(), lossy.getTime(), "the fixture proves Date loses the suffix");

  const ordinary = [{ id: ID, updated_at: lossy }];
  assert.equal(normalizeDocumentRecordRevisions("parties", ordinary), ordinary);
  assert.throws(
    () => normalizeDocumentRecordRevisions("documents", [{ updated_at: lossy }]),
    /exact persisted revision/,
  );
});

test("document update and correction tool schemas require the exact persisted token", () => {
  const update = applicationTool("update_record")!;
  const updateInput = {
    typeKey: "bills",
    id: ID,
    body: { memo: "reviewed" },
    idempotencyKey: IDEMPOTENCY_KEY,
  };
  assert.equal(update.inputSchema.safeParse(updateInput).success, false);
  assert.equal(update.inputSchema.safeParse({
    ...updateInput,
    body: { ...updateInput.body, expectedUpdatedAt: null },
  }).success, false);
  assert.equal(update.inputSchema.safeParse({
    ...updateInput,
    body: { ...updateInput.body, expectedUpdatedAt: "2026-08-24T12:34:56.123Z" },
  }).success, false);
  const parsedUpdate = update.inputSchema.safeParse({
    ...updateInput,
    body: { ...updateInput.body, expectedUpdatedAt: EXACT_REVISION },
  });
  assert.equal(parsedUpdate.success, true);
  if (parsedUpdate.success) {
    const parsed = parsedUpdate.data as { body: { expectedUpdatedAt: string } };
    assert.equal(parsed.body.expectedUpdatedAt, EXACT_REVISION);
  }
  assert.equal(update.inputSchema.safeParse({ ...updateInput, typeKey: "parties" }).success, true);

  const advertised = z.toJSONSchema(update.inputSchema) as {
    type?: string;
    properties?: {
      body?: { properties?: { expectedUpdatedAt?: { pattern?: string } } };
    };
    allOf?: Array<{
      if?: { properties?: { typeKey?: { enum?: string[] } } };
      then?: { properties?: { body?: { required?: string[] } } };
    }>;
  };
  assert.equal(advertised.type, "object", "the MCP registrar can expose the conditional schema");
  assert.equal(
    advertised.properties?.body?.properties?.expectedUpdatedAt?.pattern,
    DOCUMENT_REVISION_PATTERN,
  );
  const documentRequirement = advertised.allOf?.[0];
  const advertisedDocumentTypes = documentRequirement?.if?.properties?.typeKey?.enum ?? [];
  assert.ok(advertisedDocumentTypes.includes("bills"));
  assert.ok(advertisedDocumentTypes.includes("invoices"));
  assert.ok(
    advertisedDocumentTypes.length > 2,
    "every document record type must appear in the update_record OCC enum",
  );
  assert.deepEqual(
    documentRequirement?.then?.properties?.body?.required,
    ["expectedUpdatedAt"],
    "the model-visible schema makes document revisions mandatory",
  );

  const correction = applicationTool("correct_document")!;
  const correctionInput = {
    documentId: ID,
    correction: { amendmentReason: "correct source evidence" },
    idempotencyKey: IDEMPOTENCY_KEY,
  };
  assert.equal(correction.inputSchema.safeParse(correctionInput).success, false);
  assert.equal(correction.inputSchema.safeParse({
    ...correctionInput,
    correction: { ...correctionInput.correction, expectedUpdatedAt: null },
  }).success, false);
  const parsedCorrection = correction.inputSchema.safeParse({
    ...correctionInput,
    correction: { ...correctionInput.correction, expectedUpdatedAt: EXACT_REVISION },
  });
  assert.equal(parsedCorrection.success, true);
  if (parsedCorrection.success) {
    const parsed = parsedCorrection.data as { correction: { expectedUpdatedAt: string } };
    assert.equal(parsed.correction.expectedUpdatedAt, EXACT_REVISION);
  }
});

test("stale generic and correction writes surface a 409 conflict", () => {
  for (const invoke of [
    () => applicationWriteValue({ status: 409, body: { error: "stale document revision" } }),
    () => domainFailure(new DocumentEditError(409, "stale document revision")),
  ]) {
    assert.throws(
      invoke,
      (error: unknown) => error instanceof ApplicationError
        && error.code === "conflict"
        && error.status === 409
        && error.message === "stale document revision",
    );
  }
});


// Run with:  node --import tsx --test web/lib/api/registry.test.ts   (from repo root)
//
// Guardrail: the API registry, the write engine's capabilities, and the
// generated OpenAPI spec must never drift. These are PURE checks (no db) over
// the registry data + the pure OpenAPI builder.

import { test } from "node:test";
import assert from "node:assert/strict";
import { API_RECORD_TYPES, type ApiRecordTypeSchema } from "./registry-data.ts";
import { buildOpenApiSpec } from "./openapi.ts";

test("every write op is backed by a write permission and a writing writer", () => {
  for (const rt of API_RECORD_TYPES) {
    const writes = rt.operations.filter((o) => o === "create" || o === "update" || o === "delete");
    if (writes.length > 0) {
      assert.ok(rt.writePermission, `${rt.key} advertises ${writes.join("/")} but has no writePermission`);
      assert.notEqual(rt.writer.kind, "readonly", `${rt.key} advertises writes but its writer is readonly`);
    }
  }
});

test("readonly writers advertise no write ops and no write permission", () => {
  for (const rt of API_RECORD_TYPES) {
    if (rt.writer.kind === "readonly") {
      assert.deepEqual(rt.operations, ["list", "get"], `${rt.key} is readonly but exposes ${rt.operations.join(",")}`);
      assert.equal(rt.writePermission, null, `${rt.key} is readonly but has a writePermission`);
    }
  }
});

test("document writers carry a docKind; entity writers carry a table", () => {
  for (const rt of API_RECORD_TYPES) {
    if (rt.writer.kind === "document") assert.ok(rt.writer.docKind, `${rt.key} document writer missing docKind`);
    if (rt.writer.kind === "entity") assert.ok(rt.writer.table, `${rt.key} entity writer missing table`);
    // Read is always available.
    assert.ok(rt.operations.includes("list") && rt.operations.includes("get"), `${rt.key} must expose list+get`);
  }
});

test("OpenAPI documents exactly the operations each type advertises", () => {
  // A synthetic schema exercising every op set + a custom (dynamic) type.
  const schema: ApiRecordTypeSchema[] = [
    {
      key: "widgets",
      label: "Widgets",
      description: "test",
      table: "widgets",
      searchColumn: "name",
      readPermission: "items.read",
      writePermission: "items.manage",
      operations: ["list", "get", "create", "update", "delete"],
      writer: { kind: "entity", table: "widgets" },
      dynamic: false,
      path: "/api/v1/records/widgets",
      fields: [
        { name: "id", type: "string (uuid)", required: false, writable: false, description: null, custom: false },
        { name: "name", type: "string", required: true, writable: true, description: null, custom: false },
        { name: "cf_color", type: "string", required: false, writable: true, description: "Color", custom: true },
      ],
    },
    {
      key: "ledger",
      label: "Ledger",
      description: "test",
      table: "journal_entries",
      searchColumn: "entry_number",
      readPermission: "gl.read",
      writePermission: null,
      operations: ["list", "get"],
      writer: { kind: "readonly" },
      dynamic: false,
      path: "/api/v1/records/ledger",
      fields: [],
    },
  ];

  const spec = buildOpenApiSpec(schema, "https://example.test");

  // Widgets: list+create on the collection path; get+update+delete on /{id}.
  const coll = spec.paths["/api/v1/records/widgets"];
  const item = spec.paths["/api/v1/records/widgets/{id}"];
  assert.ok(coll.get && coll.post, "widgets collection should document GET + POST");
  assert.ok(item.get && item.patch && item.delete, "widgets item should document GET + PATCH + DELETE");
  for (const operation of [coll.post, item.patch, item.delete]) {
    assert.ok(
      operation.parameters.some((parameter: { name?: string }) => parameter.name === "Idempotency-Key"),
      "every REST mutation must document Idempotency-Key",
    );
  }

  // Write bodies reference the *Write model (writable fields only).
  const writeRef = coll.post.requestBody.content["application/json"].schema.$ref;
  assert.match(writeRef, /WidgetsWrite$/);
  const writeModel = spec.components.schemas.WidgetsWrite;
  assert.ok(writeModel.properties.name, "write model keeps writable fields");
  assert.ok(writeModel.properties.cf_color, "write model keeps custom fields");
  assert.ok(!writeModel.properties.id, "write model drops read-only id");
  assert.deepEqual(writeModel.required, ["name"], "write model requires the required writable field");

  // Read model keeps everything, including read-only id.
  assert.ok(spec.components.schemas.Widgets.properties.id, "read model keeps id");

  // Ledger (readonly): only GET endpoints, no post/patch/delete anywhere.
  const ledgerColl = spec.paths["/api/v1/records/ledger"];
  const ledgerItem = spec.paths["/api/v1/records/ledger/{id}"];
  assert.ok(ledgerColl.get && !ledgerColl.post, "readonly type must not document POST");
  assert.ok(ledgerItem.get && !ledgerItem.patch && !ledgerItem.delete, "readonly type must not document writes");
});

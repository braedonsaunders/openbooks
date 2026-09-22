import { v1PrettyResourcePath, type ApiRecordTypeSchema } from "./registry-data";

interface OpenApiSchema {
  properties?: Record<string, OpenApiSchema>;
  required?: string[];
  [key: string]: unknown;
}
interface OpenApiOperation {
  parameters?: Array<Record<string, unknown>>;
  requestBody?: { content: { "application/json": { schema: OpenApiSchema } }; required?: boolean };
  responses?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}
interface OpenApiPathItem {
  get?: OpenApiOperation;
  post?: OpenApiOperation;
  patch?: OpenApiOperation;
  delete?: OpenApiOperation;
  [key: string]: unknown;
}

/**
 * Build a tenant-specific OpenAPI 3.0 spec from an already-loaded schema.
 * Pure (no db/server-only) so it is unit-testable; `generateOpenApiSpec`
 * (openapi-server.ts) loads the live schema and calls this. Unlike source platform
 * (one global spec per release), openbooks produces a spec that includes the
 * org's custom record types and custom fields — the schema is the source of
 * truth, so the docs are never stale.
 */

export interface OpenApiSpec {
  openapi: "3.0.3";
  info: {
    title: string;
    description: string;
    version: string;
  };
  servers: { url: string; description: string }[];
  paths: Record<string, OpenApiPathItem>;
  components: {
    securitySchemes: Record<string, Record<string, unknown>>;
    schemas: Record<string, OpenApiSchema>;
    responses: Record<string, Record<string, unknown>>;
  };
  security: Record<string, string[]>[];
}

export function buildOpenApiSpec(
  schema: ApiRecordTypeSchema[],
  baseUrl: string,
): OpenApiSpec {
  const paths: Record<string, OpenApiPathItem> = {};
  const schemas: Record<string, OpenApiSchema> = {};
  const idempotencyParameter = {
    name: "Idempotency-Key",
    in: "header",
    required: true,
    description: "Unique 8-200 character retry key for this exact mutation. Reuse only after an uncertain outcome with identical input.",
    schema: { type: "string", minLength: 8, maxLength: 200, pattern: "^[A-Za-z0-9._:-]+$" },
  };

  // Error response schema (shared).
  schemas.Error = {
    type: "object",
    properties: {
      error: { type: "string", description: "Error message" },
    },
    required: ["error"],
  };

  // Paginated list response wrapper.
  schemas.ListMeta = {
    type: "object",
    properties: {
      total: { type: "integer", description: "Total matching records" },
      page: { type: "integer" },
      perPage: { type: "integer" },
    },
    required: ["total", "page", "perPage"],
  };

  for (const rt of schema) {
    const capName = rt.key.replace(/-/g, "_");
    const modelKey = capName.charAt(0).toUpperCase() + capName.slice(1);

    // Build separate read, create, and update representations. Document OCC is
    // update-only: advertising its token on create would ask a caller to supply
    // a revision for a row that does not exist yet.
    const properties: Record<string, OpenApiSchema> = {};
    const createProps: Record<string, OpenApiSchema> = {};
    const updateProps: Record<string, OpenApiSchema> = {};
    const required: string[] = [];
    const createRequired: string[] = [];
    const updateRequired: string[] = [];
    for (const f of rt.fields) {
      const [rawType, format] = f.type.split(" (");
      const prop = {
        type: rawType ?? "string",
        ...(format ? { format: format.replace(")", "") } : {}),
        ...(f.description ? { description: f.description } : {}),
        ...(f.enum ? { enum: f.enum } : {}),
        ...(f.pattern ? { pattern: f.pattern } : {}),
        ...(f.writeOnly ? { writeOnly: true } : {}),
      };
      if (!f.writeOnly) {
        properties[f.name] = prop;
        if (f.requiredOnRead ?? f.required) required.push(f.name);
      }
      if (f.writable) {
        if (f.writableOnCreate !== false) {
          createProps[f.name] = prop;
          if (f.required) createRequired.push(f.name);
        }
        updateProps[f.name] = prop;
        if (f.requiredOnUpdate) updateRequired.push(f.name);
      }
    }
    schemas[modelKey] = {
      type: "object",
      description: rt.description,
      properties,
      ...(required.length > 0 ? { required } : {}),
    };
    const writeModelKey = `${modelKey}Write`;
    schemas[writeModelKey] = {
      type: "object",
      description: `Writable fields for ${rt.label}.`,
      properties: createProps,
      ...(createRequired.length > 0 ? { required: createRequired } : {}),
    };
    const updateModelKey = `${modelKey}Update`;
    schemas[updateModelKey] = {
      type: "object",
      description: `Fields accepted when updating ${rt.label}.`,
      properties: updateProps,
      ...(updateRequired.length > 0 ? { required: updateRequired } : {}),
    };

    // List endpoint
    if (rt.operations.includes("list")) {
      paths[rt.path] = {
        ...(paths[rt.path] ?? {}),
        get: {
          summary: `List ${rt.label}`,
          description: rt.description,
          tags: [rt.dynamic ? "Custom Records" : "Records"],
          security: [{ BearerAuth: [] }],
          parameters: [
            { name: "q", in: "query", schema: { type: "string" }, description: "Search query" },
            { name: "page", in: "query", schema: { type: "integer", default: 1, minimum: 1 } },
            { name: "perPage", in: "query", schema: { type: "integer", default: 25, minimum: 5, maximum: 100 } },
            { name: "subsidiaryId", in: "query", schema: { type: "string", format: "uuid" }, description: "Optional subsidiary filter; actor restrictions still apply." },
          ],
          responses: {
            "200": {
              description: `Paginated list of ${rt.label.toLowerCase()}`,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      records: { type: "array", items: { $ref: `#/components/schemas/${modelKey}` } },
                      total: { type: "integer" },
                      page: { type: "integer" },
                      perPage: { type: "integer" },
                    },
                  },
                },
              },
            },
            "401": { $ref: "#/components/responses/Unauthorized" },
            "403": { $ref: "#/components/responses/Forbidden" },
          },
        },
      };
    }

    // Get one
    if (rt.operations.includes("get")) {
      paths[`${rt.path}/{id}`] = {
        ...(paths[`${rt.path}/{id}`] ?? {}),
        get: {
          summary: `Get one ${rt.label}`,
          description: rt.description,
          tags: [rt.dynamic ? "Custom Records" : "Records"],
          security: [{ BearerAuth: [] }],
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          ],
          responses: {
            "200": {
              description: "The record",
              content: { "application/json": { schema: { $ref: `#/components/schemas/${modelKey}` } } },
            },
            "404": { description: "Not found" },
          },
        },
      };
    }

    // Create
    if (rt.operations.includes("create")) {
      paths[rt.path] = {
        ...(paths[rt.path] ?? {}),
        post: {
          summary: `Create a ${rt.label.replace(/s$/, "")}`,
          description: rt.description,
          tags: [rt.dynamic ? "Custom Records" : "Records"],
          security: [{ BearerAuth: [] }],
          parameters: [idempotencyParameter],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: `#/components/schemas/${writeModelKey}` } } },
          },
          responses: {
            "201": {
              description: "Created",
              content: { "application/json": { schema: { $ref: `#/components/schemas/${modelKey}` } } },
            },
            "403": { $ref: "#/components/responses/Forbidden" },
            "422": { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          },
        },
      };
    }

    // Update
    if (rt.operations.includes("update")) {
      paths[`${rt.path}/{id}`] = {
        ...(paths[`${rt.path}/{id}`] ?? {}),
        patch: {
          summary: `Update a ${rt.label.replace(/s$/, "")}`,
          tags: [rt.dynamic ? "Custom Records" : "Records"],
          security: [{ BearerAuth: [] }],
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
            idempotencyParameter,
          ],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: `#/components/schemas/${updateModelKey}` } } },
          },
          responses: {
            "200": {
              description: "Updated",
              content: { "application/json": { schema: { $ref: `#/components/schemas/${modelKey}` } } },
            },
            "404": { description: "Not found" },
            "409": { description: "Conflict — the record changed after it was read, or the expectedUpdatedAt precondition was missing or stale. Re-read the record and retry once with the fresh updated_at copied verbatim into expectedUpdatedAt.", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
            "422": { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          },
        },
      };
    }

    // Delete
    if (rt.operations.includes("delete")) {
      paths[`${rt.path}/{id}`] = {
        ...(paths[`${rt.path}/{id}`] ?? {}),
        delete: {
          summary: `Delete a ${rt.label.replace(/s$/, "")}`,
          tags: [rt.dynamic ? "Custom Records" : "Records"],
          security: [{ BearerAuth: [] }],
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
            idempotencyParameter,
          ],
          responses: {
            "200": {
              description: "Deleted",
              content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" } } } } },
            },
            "404": { description: "Not found" },
            "409": { description: "Blocked — referenced by other records" },
          },
        },
      };
    }

    const pretty = v1PrettyResourcePath(rt.key);
    if (pretty) {
      const collection = paths[rt.path];
      const item = paths[`${rt.path}/{id}`];
      if (collection) {
        const existing = paths[pretty] ?? {};
        paths[pretty] = {
          ...existing,
          ...(collection.get && !existing.get ? { get: { ...collection.get, tags: [rt.label] } } : {}),
          ...(collection.post && !existing.post ? { post: { ...collection.post, tags: [rt.label] } } : {}),
        };
      }
      if (item) {
        const existingItem = paths[`${pretty}/{id}`] ?? {};
        paths[`${pretty}/{id}`] = {
          ...existingItem,
          ...(item.get && !existingItem.get ? { get: { ...item.get, tags: [rt.label] } } : {}),
          ...(item.patch && !existingItem.patch ? { patch: { ...item.patch, tags: [rt.label] } } : {}),
          ...(item.delete && !existingItem.delete ? { delete: { ...item.delete, tags: [rt.label] } } : {}),
        };
      }
    }
  }

  const plainPost = (summary: string, description: string, tag: string): OpenApiOperation => ({
    summary,
    description,
    tags: [tag],
    security: [{ BearerAuth: [] }],
    requestBody: {
      required: true,
      content: { "application/json": { schema: { type: "object", additionalProperties: true } } },
    },
    responses: {
      "200": { description: "Application command result" },
      "201": { description: "Created" },
      "401": { $ref: "#/components/responses/Unauthorized" },
      "403": { $ref: "#/components/responses/Forbidden" },
      "422": { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
    },
  });

  const idempotentPost = (summary: string, description: string, tag: string): OpenApiOperation => ({
    summary,
    description,
    tags: [tag],
    security: [{ BearerAuth: [] }],
    parameters: [idempotencyParameter],
    requestBody: {
      required: true,
      content: { "application/json": { schema: { type: "object", additionalProperties: true } } },
    },
    responses: {
      "200": { description: "Application command result" },
      "401": { $ref: "#/components/responses/Unauthorized" },
      "403": { $ref: "#/components/responses/Forbidden" },
      "422": { description: "Validation error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
    },
  });

  paths["/api/v1/commands"] = {
    get: {
      summary: "List application commands",
      description: "The same application catalog MCP exposes, filtered to this API key's permissions and feature gates.",
      tags: ["Commands"],
      security: [{ BearerAuth: [] }],
      responses: { "200": { description: "Visible commands" } },
    },
  };
  paths["/api/v1/commands/{name}"] = {
    post: {
      ...idempotentPost(
        "Execute an application command",
        "Runs the named application-layer command. Mutations accept Idempotency-Key on the header when the body omitted idempotencyKey.",
        "Commands",
      ),
      parameters: [
        { name: "name", in: "path", required: true, schema: { type: "string" } },
        idempotencyParameter,
      ],
    },
  };
  paths["/api/v1/vitals"] = {
    get: {
      summary: "Organization vitals",
      description: "Cash, AR/AP aging, approvals, and close snapshot for the authenticated tenant.",
      tags: ["Vitals"],
      security: [{ BearerAuth: [] }],
      responses: { "200": { description: "Vitals snapshot" } },
    },
  };
  paths["/api/v1/approvals"] = {
    get: {
      summary: "List approvals",
      tags: ["Approvals"],
      security: [{ BearerAuth: [] }],
      responses: { "200": { description: "Current worklist" } },
    },
  };
  paths["/api/v1/approvals/decide"] = {
    post: idempotentPost("Decide an approval", "Approve or reject one visible pending subject.", "Approvals"),
  };
  paths["/api/v1/documents/{id}/{action}"] = {
    post: {
      ...idempotentPost(
        "Document lifecycle",
        "action is submit, post, void, or correct. Uses the same application commands as MCP.",
        "Documents",
      ),
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        { name: "action", in: "path", required: true, schema: { type: "string", enum: ["submit", "post", "void", "correct"] } },
        idempotencyParameter,
      ],
    },
  };
  paths["/api/v1/journals/{id}/post"] = {
    post: {
      ...idempotentPost("Post a journal", "Journals skip the generic document lifecycle.", "Documents"),
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        idempotencyParameter,
      ],
    },
  };
  paths["/api/v1/payments"] = {
    ...(paths["/api/v1/payments"] ?? {}),
    post: { ...idempotentPost("Create a payment draft", "Vendor payment or customer receipt.", "Payments"), responses: { ...idempotentPost("", "", "Payments").responses, "201": { description: "Created" } } },
  };
  paths["/api/v1/payments/{id}"] = {
    ...(paths["/api/v1/payments/{id}"] ?? {}),
    patch: {
      ...idempotentPost("Update a payment draft", "Header and exact open-item allocations.", "Payments"),
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        idempotencyParameter,
      ],
    },
  };
  paths["/api/v1/payments/{id}/post"] = {
    post: {
      ...idempotentPost("Post a payment", "Submit and post with open-item applications.", "Payments"),
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        idempotencyParameter,
      ],
    },
  };
  paths["/api/v1/close/runs"] = {
    get: {
      summary: "List close runs",
      tags: ["Close"],
      security: [{ BearerAuth: [] }],
      parameters: [
        { name: "status", in: "query", schema: { type: "string" } },
        { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } },
      ],
      responses: { "200": { description: "Close runs" } },
    },
    post: idempotentPost("Start a close run", "Start or resume the period-close checklist.", "Close"),
  };
  paths["/api/v1/close/runs/{id}"] = {
    get: {
      summary: "Get a close run",
      tags: ["Close"],
      security: [{ BearerAuth: [] }],
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
      responses: { "200": { description: "Close run" } },
    },
  };
  paths["/api/v1/close/runs/{id}/advance"] = {
    post: {
      ...idempotentPost("Advance a close run", "refresh, request_approval, attest, close, or publish.", "Close"),
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        idempotencyParameter,
      ],
    },
  };
  paths["/api/v1/close/reopen"] = {
    post: idempotentPost("Request a period reopen", "Hard-closed scopes only. Soft-close unlocks from Setup.", "Close"),
  };
  paths["/api/v1/close/reopen/{id}/decide"] = {
    post: {
      ...idempotentPost("Decide a reopen request", "Independent approval of a controlled reopen.", "Close"),
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        idempotencyParameter,
      ],
    },
  };
  paths["/api/v1/close/revaluation"] = {
    post: idempotentPost("Run FX revaluation", "Period FX revaluation through the close application command.", "Close"),
  };
  paths["/api/v1/setup"] = {
    get: {
      summary: "List setup entities",
      description: "Setup-registry catalog with this organization's feature gates applied.",
      tags: ["Setup"],
      security: [{ BearerAuth: [] }],
      responses: { "200": { description: "Setup entities" } },
    },
  };
  paths["/api/v1/setup/{entityKey}"] = {
    get: {
      summary: "List setup records",
      description: "Records of one Setup-registry entity. Archived rows are excluded where the entity supports is_active.",
      tags: ["Setup"],
      security: [{ BearerAuth: [] }],
      parameters: [
        { name: "entityKey", in: "path", required: true, schema: { type: "string" }, description: "Setup entity key, e.g. tax-codes, departments, payment-terms." },
        { name: "q", in: "query", schema: { type: "string" }, description: "Match across the entity's list columns" },
        { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200 }, description: "Page size (default 50, max 200)" },
      ],
      responses: { "200": { description: "Setup records" }, "404": { description: "Unknown or feature-disabled entity" } },
    },
    post: {
      ...idempotentPost(
        "Create a setup record",
        "Create one Setup-entity record via the validated, audited Setup command.",
        "Setup",
      ),
      parameters: [
        { name: "entityKey", in: "path", required: true, schema: { type: "string" }, description: "Setup entity key, e.g. tax-codes, departments, payment-terms." },
        idempotencyParameter,
      ],
    },
  };
  paths["/api/v1/setup/{entityKey}/{id}"] = {
    get: {
      summary: "Get a setup record",
      description: "One Setup-entity record by primary key. Does not scan a paged list.",
      tags: ["Setup"],
      security: [{ BearerAuth: [] }],
      parameters: [
        { name: "entityKey", in: "path", required: true, schema: { type: "string" } },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: { "200": { description: "Setup record" }, "404": { description: "Unknown entity or record" } },
    },
    patch: {
      ...idempotentPost(
        "Update a setup record",
        "Update one Setup-entity record by id (only changed fields).",
        "Setup",
      ),
      parameters: [
        { name: "entityKey", in: "path", required: true, schema: { type: "string" } },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
        idempotencyParameter,
      ],
    },
    delete: {
      summary: "Delete a setup record",
      description: "Delete (or archive, where the entity keeps history) one configuration record by id.",
      tags: ["Setup"],
      security: [{ BearerAuth: [] }],
      parameters: [
        { name: "entityKey", in: "path", required: true, schema: { type: "string" } },
        { name: "id", in: "path", required: true, schema: { type: "string" } },
        idempotencyParameter,
      ],
      responses: {
        "200": { description: "Deleted" },
        "404": { description: "Unknown entity or record" },
        "409": { description: "Blocked — referenced by postings or other configuration" },
      },
    },
  };
  paths["/api/v1/layouts"] = {
    get: {
      summary: "List page layouts",
      description: "The routes this org has customized, with the stored layout for each.",
      tags: ["Layouts"],
      security: [{ BearerAuth: [] }],
      responses: { "200": { description: "Customized routes" } },
    },
    put: {
      ...plainPost(
        "Set a page layout",
        "Replace what a route renders via { route, spec, note, scope }. A rejected layout returns stored:false with errors, never an exception.",
        "Layouts",
      ),
    },
    delete: {
      summary: "Clear a page layout",
      description: "Drop a layout for a route (?route=, optional ?scope=org|user) so the page returns to its built-in spec.",
      tags: ["Layouts"],
      security: [{ BearerAuth: [] }],
      parameters: [
        { name: "route", in: "query", required: true, schema: { type: "string" } },
        { name: "scope", in: "query", schema: { type: "string", enum: ["org", "user"] } },
      ],
      responses: { "200": { description: "Cleared" } },
    },
  };
  paths["/api/v1/layouts/vocabulary"] = {
    get: {
      summary: "Describe the layout vocabulary",
      description: "Block/cell/widget/frame names a page layout may use, from the live registries.",
      tags: ["Layouts"],
      security: [{ BearerAuth: [] }],
      responses: { "200": { description: "Layout vocabulary" } },
    },
  };
  paths["/api/v1/layouts/describe"] = {
    get: {
      summary: "Describe a page layout",
      description: "What a route renders today: built-in layout, org override, loader field paths.",
      tags: ["Layouts"],
      security: [{ BearerAuth: [] }],
      parameters: [
        { name: "route", in: "query", required: true, schema: { type: "string" }, description: "Next.js route pattern, e.g. /banking or /apps/[key]." },
        { name: "params", in: "query", schema: { type: "string" }, description: "Optional JSON object of dynamic-segment values." },
        { name: "searchParams", in: "query", schema: { type: "string" }, description: "Optional JSON object for the query string." },
      ],
      responses: { "200": { description: "Page description" } },
    },
  };
  paths["/api/v1/layouts/validate"] = {
    post: plainPost("Validate a page layout", "Check a draft layout via { spec } without storing it.", "Layouts"),
  };
  paths["/api/v1/layouts/preview"] = {
    post: plainPost("Preview a page layout", "Stage a draft layout via { route, spec, params } for a private expiring preview url.", "Layouts"),
  };
  paths["/api/v1/layouts/history"] = {
    get: {
      summary: "List layout history",
      description: "Every layout ever saved for a route (?route=), newest first.",
      tags: ["Layouts"],
      security: [{ BearerAuth: [] }],
      parameters: [
        { name: "route", in: "query", required: true, schema: { type: "string" } },
      ],
      responses: { "200": { description: "Layout versions" } },
    },
  };
  paths["/api/v1/layouts/restore"] = {
    post: plainPost("Restore a page layout", "Republish a past layout version via { route, versionId }.", "Layouts"),
  };
  paths["/api/v1/apps"] = {
    get: {
      summary: "List app packages",
      description: "This organization's app packages, their active versions, and status.",
      tags: ["Apps"],
      security: [{ BearerAuth: [] }],
      responses: { "200": { description: "Installed apps" } },
    },
  };
  paths["/api/v1/apps/vocabulary"] = {
    get: {
      summary: "Describe app capabilities",
      description: "The native screen and package contract plus the draft → preview → approve workflow.",
      tags: ["Apps"],
      security: [{ BearerAuth: [] }],
      responses: { "200": { description: "App vocabulary" } },
    },
  };
  paths["/api/v1/apps/drafts"] = {
    post: plainPost("Prepare an app draft", "Save an immutable unpublished app package via { bundle, reason }. Revisions are new drafts.", "Apps"),
  };
  paths["/api/v1/apps/drafts/{id}"] = {
    get: {
      summary: "Read an app draft",
      description: "This author's exact unpublished package, base version and hash.",
      tags: ["Apps"],
      security: [{ BearerAuth: [] }],
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
      responses: { "200": { description: "App draft" }, "404": { description: "Not found" } },
    },
  };
  paths["/api/v1/apps/drafts/{id}/activate"] = {
    post: {
      ...plainPost("Activate a reviewed app draft", "Activate the exact reviewed draft via { contentHash }. Refuses stale bases.", "Apps"),
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
      ],
    },
  };
  paths["/api/v1/apps/drafts/{id}/discard"] = {
    post: {
      ...plainPost("Discard an app draft", "Discard an unpublished draft via { contentHash }, preserving source and audit evidence.", "Apps"),
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
      ],
    },
  };
  paths["/api/v1/apps/{key}"] = {
    get: {
      summary: "Read an installed app package",
      description: "The installed package or one historical version (?versionId=).",
      tags: ["Apps"],
      security: [{ BearerAuth: [] }],
      parameters: [
        { name: "key", in: "path", required: true, schema: { type: "string" } },
        { name: "versionId", in: "query", schema: { type: "string", format: "uuid" } },
      ],
      responses: { "200": { description: "App package" }, "404": { description: "Not found" } },
    },
  };
  paths["/api/v1/banking/reconciliations"] = {
    post: idempotentPost("Start a bank reconciliation", "One open session per account; match lines then sign off.", "Banking"),
  };
  paths["/api/v1/banking/reconciliations/{id}/sign-off"] = {
    post: {
      ...idempotentPost("Sign off a reconciliation", "Zero-difference sessions only. Permanent.", "Banking"),
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        idempotencyParameter,
      ],
    },
  };
  paths["/api/v1/banking/lines/{id}/match"] = {
    post: {
      ...idempotentPost("Match a bank line", "Pair one unmatched statement line with posted journal lines.", "Banking"),
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        idempotencyParameter,
      ],
    },
  };
  paths["/api/v1/banking/lines/{id}/match-journal"] = {
    post: {
      ...idempotentPost("Match a bank line with a journal", "Create a categorizing journal and match it in-session.", "Banking"),
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        idempotencyParameter,
      ],
    },
  };
  paths["/api/v1/banking/lines/{id}/unmatch"] = {
    post: {
      ...idempotentPost("Unmatch a bank line", "Signed-off sessions refuse.", "Banking"),
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        idempotencyParameter,
      ],
    },
  };
  paths["/api/v1/budgets/{id}/cells"] = {
    post: {
      ...idempotentPost("Update budget cells", "Draft scenarios only. expectedRevision must match.", "Budgets"),
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        idempotencyParameter,
      ],
    },
  };
  paths["/api/v1/files"] = {
    post: idempotentPost("Upload a File Cabinet file", "Same storage and folder grants as the files screen. At most 1 MB.", "Files"),
  };
  paths["/api/v1/settings/company"] = {
    get: {
      summary: "Get company settings",
      tags: ["Settings"],
      security: [{ BearerAuth: [] }],
      responses: { "200": { description: "Company & accounting settings" } },
    },
    patch: idempotentPost("Update company settings", "Only passed keys change. Fiscal calendar and base currency refuse once postings exist.", "Settings"),
  };
  paths["/api/v1/settings/features"] = {
    get: {
      summary: "List feature gates",
      description: "The Company Settings → Features switchboard as this organization sees it.",
      tags: ["Settings"],
      security: [{ BearerAuth: [] }],
      responses: { "200": { description: "Feature gates" }, "403": { $ref: "#/components/responses/Forbidden" } },
    },
    post: idempotentPost("Update feature gates", "The Features switchboard write. Dependencies and load-bearing modules are enforced.", "Settings"),
  };
  paths["/api/v1/reports"] = {
    get: {
      summary: "List report definitions",
      description: "Saved report definitions this actor may run — the same catalog as the Reports hub.",
      tags: ["Reports"],
      security: [{ BearerAuth: [] }],
      parameters: [{ name: "q", in: "query", schema: { type: "string" }, description: "Match definition name" }],
      responses: { "200": { description: "Report definitions" } },
    },
  };
  paths["/api/v1/reports/{id}"] = {
    get: {
      summary: "Get a report definition",
      tags: ["Reports"],
      security: [{ BearerAuth: [] }],
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
      responses: { "200": { description: "Report definition" }, "404": { description: "Not found" } },
    },
  };
  paths["/api/v1/reports/{id}/run"] = {
    post: {
      summary: "Run a saved report",
      description: "Execute a definition through the same report engine as the Reports hub. Restricted subsidiary scopes are refused.",
      tags: ["Reports"],
      security: [{ BearerAuth: [] }],
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
      requestBody: {
        required: true,
        content: { "application/json": { schema: { type: "object", additionalProperties: true } } },
      },
      responses: {
        "200": { description: "Report export data" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { description: "Not found" },
      },
    },
  };

  // Meta endpoints
  paths["/api/v1/openapi"] = {
    get: {
      summary: "OpenAPI 3.0 spec",
      description: "This document — the full, tenant-specific API schema (including custom records and fields).",
      tags: ["Meta"],
      security: [{ BearerAuth: [] }],
      responses: { "200": { description: "OpenAPI 3.0 JSON document" } },
    },
  };
  paths["/api/v1/schema"] = {
    get: {
      summary: "Schema registry",
      description: "The record-type catalog with live field definitions from the database.",
      tags: ["Meta"],
      security: [{ BearerAuth: [] }],
      responses: { "200": { description: "Array of record type schemas" } },
    },
  };
  paths["/api/v1/health"] = {
    get: {
      summary: "Health check",
      description: "Liveness probe — no authentication required.",
      tags: ["Meta"],
      security: [],
      responses: { "200": { description: "OK" } },
    },
  };

  return {
    openapi: "3.0.3",
    info: {
      title: "openbooks REST API",
      description:
        "The versioned REST API for openbooks. Authenticate with a bearer token (Authorization: Bearer ob_live_…) or X-API-Key header. First-class resource paths (/api/v1/invoices, /api/v1/parties, …) are aliases of /api/v1/records/{typeKey} and use the same application writers. /api/v1/commands exposes the MCP catalog as RPC. Every mutation requires Idempotency-Key.",
      version: "1.0.0",
    },
    servers: [{ url: baseUrl, description: "This instance" }],
    paths,
    components: {
      securitySchemes: {
        BearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "ob_live_…",
          description: "An API key from Build → API Keys. Pass as: Authorization: Bearer ob_live_…",
        },
      },
      schemas,
      responses: {
        Unauthorized: { description: "Invalid or missing API key", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        Forbidden: { description: "Insufficient permissions", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
      },
    },
    security: [{ BearerAuth: [] }],
  };
}

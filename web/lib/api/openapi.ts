import type { ApiRecordTypeSchema } from "./registry-data";

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
  }

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
    post: { ...idempotentPost("Create a payment draft", "Vendor payment or customer receipt.", "Payments"), responses: { ...idempotentPost("", "", "Payments").responses, "201": { description: "Created" } } },
  };
  paths["/api/v1/payments/{id}"] = {
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
    post: idempotentPost("Update feature gates", "The Features switchboard write. Dependencies and load-bearing modules are enforced.", "Settings"),
  };
  paths["/api/v1/banking/reconciliations"] = {
    post: { ...idempotentPost("Start a reconciliation", "Start a bank reconciliation session for an account.", "Banking"), responses: { ...idempotentPost("", "", "Banking").responses, "201": { description: "Created" } } },
  };
  paths["/api/v1/banking/reconciliations/{id}/sign-off"] = {
    post: {
      ...idempotentPost("Sign off a reconciliation", "Sign off a zero-difference session.", "Banking"),
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        idempotencyParameter,
      ],
    },
  };
  paths["/api/v1/banking/lines/{id}/match"] = {
    post: {
      ...idempotentPost("Match a bank line", "Pair one unmatched bank line with posted journal lines.", "Banking"),
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        idempotencyParameter,
      ],
    },
  };
  paths["/api/v1/banking/lines/{id}/match-journal"] = {
    post: {
      ...idempotentPost("Match a bank line with a journal", "Create a categorizing journal from one unmatched bank line and match it.", "Banking"),
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        idempotencyParameter,
      ],
    },
  };
  paths["/api/v1/banking/lines/{id}/unmatch"] = {
    post: {
      ...idempotentPost("Unmatch a bank line", "Return a statement line to the unmatched queue.", "Banking"),
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        idempotencyParameter,
      ],
    },
  };
  paths["/api/v1/budgets/{id}/cells"] = {
    post: {
      ...idempotentPost("Update budget cells", "Write planning cells into a draft scenario (revision-checked).", "Budgets"),
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        idempotencyParameter,
      ],
    },
  };
  paths["/api/v1/files"] = {
    post: { ...idempotentPost("Upload a file", "Upload a small file to a File Cabinet folder.", "Files"), responses: { ...idempotentPost("", "", "Files").responses, "201": { description: "Created" } } },
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
        "The versioned REST API for openbooks. Authenticate with a bearer token (Authorization: Bearer ob_live_…) or X-API-Key header. API keys carry scoped permissions — a request is allowed only when both the key's scopes and the key owner's effective permissions cover the required permission. Every mutation requires Idempotency-Key and uses the same application command layer as MCP.",
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

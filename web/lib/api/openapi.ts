import "server-only";
import { loadApiSchema } from "./schema-registry";

/**
 * Generate a tenant-specific OpenAPI 3.0 spec. Unlike NetSuite (one global
 * spec per release), openbooks produces a spec that includes the org's
 * custom record types and custom fields — the schema is the source of truth,
 * so the docs are never stale.
 */

export interface OpenApiSpec {
  openapi: "3.0.3";
  info: {
    title: string;
    description: string;
    version: string;
  };
  servers: { url: string; description: string }[];
  paths: Record<string, any>;
  components: {
    securitySchemes: Record<string, any>;
    schemas: Record<string, any>;
    responses: Record<string, any>;
  };
  security: Record<string, any>[];
}

export async function generateOpenApiSpec(
  orgId: string,
  baseUrl: string,
): Promise<OpenApiSpec> {
  const schema = await loadApiSchema(orgId);

  const paths: Record<string, any> = {};
  const schemas: Record<string, any> = {};

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

    // Build the JSON schema for this record type's fields.
    const properties: Record<string, any> = {};
    const required: string[] = [];
    for (const f of rt.fields) {
      const [type, format] = f.type.split(" (");
      properties[f.name] = {
        type,
        ...(format ? { description: `${f.type}` } : {}),
        ...(f.description ? { description: f.description } : {}),
      };
      if (f.required) required.push(f.name);
    }
    schemas[modelKey] = {
      type: "object",
      description: rt.description,
      properties,
      ...(required.length > 0 ? { required } : {}),
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
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: `#/components/schemas/${modelKey}` } } },
          },
          responses: {
            "201": {
              description: "Created",
              content: { "application/json": { schema: { $ref: `#/components/schemas/${modelKey}` } } },
            },
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
          ],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: `#/components/schemas/${modelKey}` } } },
          },
          responses: {
            "200": {
              description: "Updated",
              content: { "application/json": { schema: { $ref: `#/components/schemas/${modelKey}` } } },
            },
          },
        },
      };
    }
  }

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
        "The versioned REST API for openbooks. Authenticate with a bearer token (Authorization: Bearer ob_live_…) or X-API-Key header. API keys carry scoped permissions — a request is allowed only when both the key's scopes and the key owner's effective permissions cover the required permission.",
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

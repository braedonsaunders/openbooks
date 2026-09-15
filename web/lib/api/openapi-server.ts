import "server-only";
import { loadApiSchema } from "./schema-registry";
import { buildOpenApiSpec, type OpenApiSpec } from "./openapi";

/**
 * Load the org's live API schema and render it as an OpenAPI 3.0 spec. Thin
 * server wrapper over the pure `buildOpenApiSpec` — keeps the builder testable
 * without a database.
 */
export async function generateOpenApiSpec(
  orgId: string,
  baseUrl: string,
  roleKeys: readonly string[] | null = null,
): Promise<OpenApiSpec> {
  const schema = await loadApiSchema(orgId, roleKeys);
  return buildOpenApiSpec(schema, baseUrl);
}

import "server-only";
import {
  handleStreamableHttpRequest,
  jsonRpcErrorResponse,
  mcpBoundaryResponse,
  mcpMethodNotAllowed,
  mcpPreflightResponse,
  resolveMcpRequestId,
} from "@appkit/mcp";
import {
  enforceRateLimit,
  guardApiKeyFeature,
  resolveApiKeyAuth,
} from "../api-auth";
import { insertApiKeyEvent, transportEvent } from "../application/api-key-audit";
import { createOpenBooksMcpServer } from "./server";

function configured(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function boundaryOptions() {
  return {
    allowedHosts: configured("OPENBOOKS_MCP_ALLOWED_HOSTS"),
    allowedOrigins: configured("OPENBOOKS_MCP_ALLOWED_ORIGINS"),
  };
}

export async function handleMcpPost(request: Request): Promise<Response> {
  const rejected = mcpBoundaryResponse(request, boundaryOptions());
  if (rejected) return rejected;

  const auth = await resolveApiKeyAuth(request);
  if (!auth) {
    const response = jsonRpcErrorResponse(401, -32001, "Invalid or missing bearer token");
    response.headers.set("www-authenticate", 'Bearer realm="OpenBooks MCP"');
    return response;
  }
  const featureGate = await guardApiKeyFeature(auth, "mcpAccess");
  if (featureGate) return featureGate;
  const limited = await enforceRateLimit(auth);
  if (limited) return limited;

  const requestId = resolveMcpRequestId(request);
  const server = createOpenBooksMcpServer({ auth, request, requestId });

  let transportError: unknown;
  const response = await handleStreamableHttpRequest(request, {
    server,
    requestId,
    authInfo: {
      token: auth.keyId,
      clientId: `openbooks-api-key:${auth.keyId}`,
      scopes: [...auth.permissions],
    },
    onError: (error) => {
      transportError = error;
      console.warn("[mcp] transport failure", error);
    },
  });
  // Required evidence for the boundary itself: awaited, and a failing write
  // fails the request closed. Per-tool execution evidence rides the claim
  // transaction inside executeIdempotent (see server.ts's audit hook).
  try {
    await insertApiKeyEvent(transportEvent(
      auth.audit,
      { orgId: auth.user.orgId, keyId: auth.keyId },
      { statusCode: response.status, ...(transportError !== undefined ? { error: "transport failure" } : {}) },
    ));
  } catch (cause) {
    console.error("[mcp] execution evidence unavailable", cause);
    return jsonRpcErrorResponse(500, -32003, "Execution evidence unavailable");
  }
  return response;
}

export function methodNotAllowed(): Response {
  return mcpMethodNotAllowed();
}

export function mcpOptions(request: Request): Response {
  const rejected = mcpBoundaryResponse(request, boundaryOptions());
  if (rejected) return rejected;
  return mcpPreflightResponse(request);
}

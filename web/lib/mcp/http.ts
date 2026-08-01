import "server-only";
import { randomUUID } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { NextResponse } from "next/server";
import { enforceRateLimit, guardApiKeyFeature, logKeyEvent, resolveApiKeyAuth } from "../api-auth";
import { createOpenBooksMcpServer } from "./server";

function jsonRpcError(status: number, code: number, message: string): NextResponse {
  return NextResponse.json(
    { jsonrpc: "2.0", error: { code, message }, id: null },
    { status },
  );
}

function configuredSet(name: string): Set<string> {
  return new Set(
    (process.env[name] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function validateRequestBoundary(request: Request): NextResponse | null {
  const url = new URL(request.url);
  const host = request.headers.get("host")?.toLowerCase();
  const allowedHosts = configuredSet("OPENBOOKS_MCP_ALLOWED_HOSTS");
  const expectedHost = url.host.toLowerCase();
  if (!host || (host !== expectedHost && !allowedHosts.has(host))) {
    return jsonRpcError(421, -32001, "Misdirected Request");
  }

  const origin = request.headers.get("origin");
  if (origin) {
    const allowedOrigins = configuredSet("OPENBOOKS_MCP_ALLOWED_ORIGINS");
    if (origin !== url.origin && !allowedOrigins.has(origin)) {
      return jsonRpcError(403, -32001, "Origin not allowed");
    }
  }
  return null;
}

export async function handleMcpPost(request: Request): Promise<Response> {
  const startedAt = Date.now();
  const boundary = validateRequestBoundary(request);
  if (boundary) return boundary;

  const auth = await resolveApiKeyAuth(request);
  if (!auth) {
    return new NextResponse(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Invalid or missing bearer token" },
        id: null,
      }),
      {
        status: 401,
        headers: {
          "content-type": "application/json",
          "www-authenticate": 'Bearer realm="OpenBooks MCP"',
        },
      },
    );
  }
  const featureGate = await guardApiKeyFeature(auth, "mcpAccess");
  if (featureGate) return featureGate;
  const limited = await enforceRateLimit(auth, request, startedAt);
  if (limited) return limited;

  const requestIdHeader = request.headers.get("x-request-id");
  const requestId = requestIdHeader && /^[A-Za-z0-9._:-]{8,200}$/.test(requestIdHeader)
    ? requestIdHeader
    : randomUUID();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = createOpenBooksMcpServer({ auth, request, requestId });

  try {
    await server.connect(transport);
    const response = await transport.handleRequest(request, {
      authInfo: {
        token: auth.keyId,
        clientId: `openbooks-api-key:${auth.keyId}`,
        scopes: [...auth.permissions],
      },
    });
    logKeyEvent({
      orgId: auth.user.orgId,
      keyId: auth.keyId,
      method: request.method,
      path: "/mcp",
      statusCode: response.status,
      durationMs: Date.now() - startedAt,
      req: request,
    });
    const headers = new Headers(response.headers);
    headers.set("x-request-id", requestId);
    headers.set("cache-control", "no-store");
    return new Response(response.body, { status: response.status, headers });
  } catch (error) {
    console.warn("[mcp] transport failure", error);
    logKeyEvent({
      orgId: auth.user.orgId,
      keyId: auth.keyId,
      method: request.method,
      path: "/mcp",
      statusCode: 500,
      durationMs: Date.now() - startedAt,
      req: request,
      error: "transport failure",
    });
    return jsonRpcError(500, -32603, "Internal server error");
  } finally {
    await Promise.allSettled([transport.close(), server.close()]);
  }
}

export function methodNotAllowed(): NextResponse {
  const response = jsonRpcError(405, -32000, "Method not allowed");
  response.headers.set("allow", "POST, OPTIONS");
  return response;
}

export function mcpOptions(request: Request): NextResponse {
  const boundary = validateRequestBoundary(request);
  if (boundary) return boundary;
  const origin = request.headers.get("origin");
  const response = new NextResponse(null, { status: 204 });
  if (origin) {
    response.headers.set("access-control-allow-origin", origin);
    response.headers.set("vary", "Origin");
  }
  response.headers.set("access-control-allow-methods", "POST, OPTIONS");
  response.headers.set(
    "access-control-allow-headers",
    "Authorization, Content-Type, Accept, MCP-Protocol-Version, X-Request-ID",
  );
  response.headers.set("access-control-expose-headers", "MCP-Protocol-Version, X-Request-ID");
  response.headers.set("access-control-max-age", "600");
  return response;
}

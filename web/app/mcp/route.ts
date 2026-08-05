import { handleMcpPost, mcpOptions, methodNotAllowed } from "../../lib/mcp/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleMcpPost(request);
}

export async function OPTIONS(request: Request): Promise<Response> {
  return mcpOptions(request);
}

export async function GET(): Promise<Response> {
  return methodNotAllowed();
}

export async function DELETE(): Promise<Response> {
  return methodNotAllowed();
}

import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { ApplicationError } from "../../../../lib/application/errors";
import { applicationContextFromSession } from "../../../../lib/application/context";
import {
  applicationTool,
  executeApplicationTool,
} from "../../../../lib/application/tool-catalog";
import { guardPermission } from "../../../../lib/authz";
import { verifyApplicationCommand } from "../../../../lib/assistant/application-proposals";

export const runtime = "nodejs";
const MAX_BODY_BYTES = 1_000_000;

export async function POST(request: Request): Promise<NextResponse> {
  const gate = await guardPermission("assistant.write");
  if (gate instanceof NextResponse) return gate;

  let body: { toolName?: unknown; input?: unknown; confirmToken?: unknown };
  try {
    const text = await request.text();
    if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "request_too_large" }, { status: 413 });
    }
    body = JSON.parse(text) as typeof body;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (typeof body.toolName !== "string" || typeof body.confirmToken !== "string") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const definition = applicationTool(body.toolName);
  if (!definition || definition.readOnly || definition.assistantConfirmation !== "always") {
    return NextResponse.json({ error: "unsupported_command" }, { status: 400 });
  }
  if (!definition.visibleTo(gate)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const parsed = definition.inputSchema.safeParse(body.input);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input" }, { status: 422 });
  }
  if (!verifyApplicationCommand(definition.name, parsed.data, body.confirmToken, gate)) {
    return NextResponse.json(
      { error: "confirmation_expired_or_modified" },
      { status: 422 },
    );
  }

  try {
    const requestId = request.headers.get("x-request-id") || randomUUID();
    const context = applicationContextFromSession(gate, "assistant", requestId);
    const result = await executeApplicationTool(definition, context, parsed.data);
    return NextResponse.json(result, {
      headers: { "cache-control": "no-store", "x-request-id": requestId },
    });
  } catch (error) {
    if (error instanceof ApplicationError) {
      return NextResponse.json(
        { error: error.code, message: error.message, details: error.details },
        { status: error.status },
      );
    }
    console.error(`[assistant/application-command] ${definition.name} failed`, error);
    return NextResponse.json({ error: "command_failed" }, { status: 500 });
  }
}

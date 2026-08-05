import { NextResponse } from "next/server";
import { guardPermission } from "../../../../../lib/authz";
import {
  deleteConversation,
  ownsConversation,
  recentMessages,
  renameConversation,
} from "../../../../../lib/ai-conversations";

export const runtime = "nodejs";

const SCOPE = "assistant";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Recent messages of one owned conversation, oldest first. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("assistant.use");
  if (gate instanceof NextResponse) return gate;
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "bad request" }, { status: 400 });
  if (!(await ownsConversation(gate, id, SCOPE))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const messages = await recentMessages(gate, id);
  return NextResponse.json({ messages });
}

/** Rename an owned conversation: { title }. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("assistant.use");
  if (gate instanceof NextResponse) return gate;
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "bad request" }, { status: 400 });
  let body: { title?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  if (typeof body.title !== "string" || !body.title.trim()) {
    return NextResponse.json({ error: "title required" }, { status: 400 });
  }
  const renamed = await renameConversation(gate, id, SCOPE, body.title);
  if (!renamed) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("assistant.use");
  if (gate instanceof NextResponse) return gate;
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const deleted = await deleteConversation(gate, id, SCOPE);
  if (!deleted) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

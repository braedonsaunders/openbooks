import { NextResponse } from "next/server";
import { login, SESSION_COOKIE, SESSION_TTL_S } from "../../../lib/auth";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const { email, password } = (await req.json()) as { email?: string; password?: string };
  if (!email || !password) return NextResponse.json({ error: "missing credentials" }, { status: 400 });
  const token = await login(email, password);
  if (!token) {
    // uniform delay curbs user-enumeration timing
    await new Promise((r) => setTimeout(r, 400));
    return NextResponse.json({ error: "invalid credentials" }, { status: 401 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: "lax",
    secure: false, // served over LAN http for now; flip when TLS fronting lands
    maxAge: SESSION_TTL_S, path: "/",
  });
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, maxAge: 0, path: "/" });
  return res;
}

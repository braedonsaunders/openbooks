import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { guardPermission } from "../../../../lib/authz";

export const runtime = "nodejs";

/**
 * JavaScript regular expressions have no execution timeout. Account-group
 * name patterns run against every account during classification, so reject
 * constructs that let a quantified group recursively backtrack through its
 * own quantifiers or alternatives. The check intentionally keeps the
 * existing expressive unanchored patterns (including `.*` and `(?:a|b)`), but
 * refuses the nested/ambiguous forms that turn a long account name into a
 * request-wide ReDoS primitive.
 */
function unsafeNamePattern(pattern: string): boolean {
  if (pattern.length > 256) return true;
  if (/\\(?:[1-9]|k<)/.test(pattern)) return true;
  if (/\(\?(?:[=!]|<[=!])/.test(pattern)) return true;

  type Group = { hasQuantifier: boolean; hasAlternation: boolean };
  type Atom = { kind: "group" | "other"; hasQuantifier: boolean; hasAlternation: boolean };
  const groups: Group[] = [];
  let atom: Atom | undefined;
  let escaped = false;
  let inCharacterClass = false;

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (escaped) {
      escaped = false;
      atom = { kind: "other", hasQuantifier: false, hasAlternation: false };
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (inCharacterClass) {
      if (char === "]") {
        inCharacterClass = false;
        atom = { kind: "other", hasQuantifier: false, hasAlternation: false };
      }
      continue;
    }
    if (char === "[") {
      inCharacterClass = true;
      continue;
    }
    if (char === "(") {
      groups.push({ hasQuantifier: false, hasAlternation: false });
      atom = undefined;
      continue;
    }
    if (char === "|") {
      if (groups.length) groups[groups.length - 1]!.hasAlternation = true;
      atom = undefined;
      continue;
    }
    if (char === ")") {
      const group = groups.pop();
      if (!group) return true;
      if (groups.length) {
        groups[groups.length - 1]!.hasQuantifier ||= group.hasQuantifier;
        groups[groups.length - 1]!.hasAlternation ||= group.hasAlternation;
      }
      atom = { kind: "group", ...group };
      continue;
    }
    const isQuantifier = char === "*" || char === "+" || char === "?";
    if (char === "{") {
      const close = pattern.indexOf("}", index + 1);
      if (close === -1) return true;
      index = close;
      if (atom) {
        if (atom.kind === "group" && (atom.hasQuantifier || atom.hasAlternation)) return true;
        if (groups.length) groups[groups.length - 1]!.hasQuantifier = true;
      }
      continue;
    }
    if (isQuantifier) {
      // A lazy suffix (`+?`) modifies the preceding quantifier; it does not
      // introduce another independently quantified atom.
      if (char === "?" && atom?.hasQuantifier) continue;
      if (atom) {
        if (atom.kind === "group" && (atom.hasQuantifier || atom.hasAlternation)) return true;
        if (groups.length) groups[groups.length - 1]!.hasQuantifier = true;
      }
      continue;
    }
    if (char === "^" || char === "$") continue;
    atom = { kind: "other", hasQuantifier: false, hasAlternation: false };
  }

  return groups.length > 0;
}

/**
 * Mutations on one account group (the reporting-classification primitive).
 * PATCH updates the display fields and/or the auto-match rule; membership
 * pins live under ./pins. Guarded by the Setup permission — the same gate as
 * the Setup → Account Groups workspace.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission("admin.setup.manage");
  if (gate instanceof NextResponse) return gate;
  const { id } = await params;

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as {
    name?: string;
    color?: string | null;
    match?: { accountTypes?: string[]; numberPrefixes?: string[]; namePattern?: string } | null;
  };

  if (body.match?.namePattern) {
    try {
      new RegExp(body.match.namePattern, "i");
    } catch {
      return NextResponse.json({ error: "invalid namePattern regex" }, { status: 400 });
    }
    if (unsafeNamePattern(body.match.namePattern)) {
      return NextResponse.json({ error: "unsafe namePattern regex" }, { status: 400 });
    }
  }

  const sets: ReturnType<typeof sql>[] = [];
  if (body.name !== undefined) sets.push(sql`name = ${body.name}`);
  if (body.color !== undefined) sets.push(sql`color = ${body.color}`);
  if (body.match !== undefined) sets.push(sql`match = ${JSON.stringify(body.match ?? {})}::jsonb`);
  if (!sets.length) return NextResponse.json({ error: "nothing to update" }, { status: 400 });

  const updated = await db.transaction(async (tx) => {
    // Lock and snapshot the row in the same transaction as the update so the
    // audit evidence always describes the committed state transition, even
    // when two classification edits arrive concurrently.
    const current = await tx.execute<Record<string, unknown>>(sql`
      select * from account_groups
       where id = ${id} and org_id = ${gate.user.orgId}
       for update
    `);
    const before = current.rows[0];
    if (!before) return null;

    const result = await tx.execute<Record<string, unknown>>(sql`
      update account_groups
         set ${sql.join(sets, sql`, `)}, updated_at = now(), updated_by = ${gate.user.id}
       where id = ${id} and org_id = ${gate.user.orgId}
       returning *
    `);
    const after = result.rows[0];
    if (!after) return null;

    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id, request_id)
      values
        (${gate.user.orgId}, 'account_groups', ${id}, 'update',
         ${JSON.stringify({ before, after })}::jsonb,
         ${gate.user.id}, ${req.headers.get("x-request-id")})
    `);
    return after;
  });
  if (!updated) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

import { z } from "zod";
import { NextResponse } from "next/server";
import { AR_KINDS, AP_KINDS } from "@openbooks/engine/records/document-kinds";
import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { guardSubsidiaryScope } from "@/lib/authz";
import { isUuid } from "@/lib/list-params";
import {
  deletePartyRole,
  openRoleActivity,
  readPartyForRoleChange,
  readPartyRoleRow,
  type RemovablePartyRole,
} from "@/lib/party-roles";

export const runtime = "nodejs";

type PartyRole = RemovablePartyRole;

/** Stored kind once its naming role is gone: customers and vendors fall back to a company, employees to a person. */
const ROLE_BASE_KINDS: Record<PartyRole, "company" | "person"> = {
  customer: "company",
  vendor: "company",
  employee: "person",
};

const removeBody = z.object({ role: z.enum(["customer", "vendor", "employee"]) }).strict();

function bad(error: string) {
  return NextResponse.json({ error }, { status: 422 });
}

/**
 * Remove one native role from a party. Deleting the row is permanent, so a
 * role with open activity refuses by name: the refusal counts the blocking
 * records and names the supported remedy (deactivate the role instead, which
 * keeps the history readable). A clean role deletes with its kind fallback —
 * a stored role-kind without its role row is a claim no read can back, so
 * the kind returns to its base alongside the deletion — and the whole change
 * is audited with before/after state.
 *
 * POST /api/parties/{id}/roles/remove { role } → { removed: true, kind }
 */
export const POST = defineRoute({
  permission: "parties.manage",
  feature: { none: "Parties are shared master records; CRM capabilities do not gate their roles." },
  params: z.object({ id: z.string() }),
  body: removeBody,
  invalidBodyStatus: 422,
  handler: async ({ body, authz, params }) => {
    const orgId = authz.user.orgId;
    if (!isUuid(params.id)) return notFound("record");
    const role = body.role as PartyRole;

    const party = await readPartyForRoleChange(orgId, params.id);
    if (!party) return notFound("record");
    const scoped = guardSubsidiaryScope(authz, party.subsidiary_id, { orgWideNull: true });
    if (scoped) return scoped;

    const roleRow = await readPartyRoleRow(orgId, role, party.id);
    if (!roleRow) return bad(`This party has no ${role} role to remove.`);

    // Open activity is transactional evidence, checked per role; a role with
    // any refuses by name with the supported remedy.
    const activity = await openRoleActivity(
      orgId,
      party.id,
      role,
      role === "customer" ? [...AR_KINDS] : [...AP_KINDS],
    );
    if (activity.length > 0) {
      return bad(
        `Cannot remove the ${role} role — ${activity.join("; ")}. ` +
          `Deactivate the ${role} role instead to keep the history.`,
      );
    }

    const nextKind = party.kind === role ? ROLE_BASE_KINDS[role] : party.kind;
    const removed = await deletePartyRole({
      orgId,
      actorId: authz.user.id,
      partyId: party.id,
      role,
      priorKind: party.kind,
      nextKind,
      roleRow,
    });

    return NextResponse.json({ removed: true, kind: removed });
  },
});

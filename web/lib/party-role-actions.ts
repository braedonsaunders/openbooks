import "server-only";
import { NextResponse } from "next/server";
import { AP_KINDS, AR_KINDS } from "@openbooks/engine/records/document-kinds";
import type { Authz } from "./authz";
import { guardSubsidiaryScope } from "./authz";
import { notFound } from "./api/responses";
import { BULK_ACTION_MAX_IDS } from "./api/bulk-ids";
import { isUuid } from "./list-params";
import {
  assignPartyRoleAudited,
  deletePartyRole,
  openRoleActivity,
  readPartyForRoleChange,
  readPartyRoleRow,
  roleLessPartiesInSlice,
  type RemovablePartyRole,
} from "./party-roles";

export async function assignPartyRolesInSlice(
  authz: Authz,
  input: { role: RemovablePartyRole; q?: string; includeInactive?: boolean },
): Promise<NextResponse | { assigned: number; total: number }> {
  const orgId = authz.user.orgId;
  const q = input.q?.trim() ? `%${input.q.trim()}%` : null;
  const candidates = await roleLessPartiesInSlice({
    orgId,
    q,
    includeInactive: input.includeInactive === true,
    limit: BULK_ACTION_MAX_IDS + 1,
    allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
  });
  if (candidates.length > BULK_ACTION_MAX_IDS) {
    return NextResponse.json(
      {
        error: `More than ${BULK_ACTION_MAX_IDS} role-less parties match — narrow the directory search and assign in batches of ${BULK_ACTION_MAX_IDS}.`,
      },
      { status: 422 },
    );
  }
  let assigned = 0;
  for (const party of candidates) {
    await assignPartyRoleAudited({
      orgId,
      actorId: authz.user.id,
      partyId: party.id,
      role: input.role,
    });
    assigned++;
  }
  return { assigned, total: candidates.length };
}

const ROLE_BASE_KINDS: Record<RemovablePartyRole, "company" | "person"> = {
  customer: "company",
  vendor: "company",
  employee: "person",
};

function bad(error: string) {
  return NextResponse.json({ error }, { status: 422 });
}

export async function removePartyRoleFromParty(
  authz: Authz,
  partyId: string,
  role: RemovablePartyRole,
): Promise<NextResponse | { removed: true; kind: string }> {
  const orgId = authz.user.orgId;
  if (!isUuid(partyId)) return notFound("record");
  const party = await readPartyForRoleChange(orgId, partyId);
  if (!party) return notFound("record");
  const scoped = guardSubsidiaryScope(authz, party.subsidiary_id, { orgWideNull: true });
  if (scoped) return scoped;
  const roleRow = await readPartyRoleRow(orgId, role, party.id);
  if (!roleRow) return bad(`This party has no ${role} role to remove.`);
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
  return { removed: true, kind: removed };
}

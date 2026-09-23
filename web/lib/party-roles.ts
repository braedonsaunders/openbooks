import 'server-only'
import { sql } from 'drizzle-orm'
import { db, type SqlExecutor } from '@openbooks/engine/src/platform/db.ts'

/**
 * Party kinds that name a role row. The party lists, the drawer tabs, and
 * compliance all resolve the ROLE, never `parties.kind` — so a stored
 * customer/vendor/employee kind is a claim the matching role row must back.
 */
export type PartyRoleKind = 'customer' | 'vendor' | 'employee'

const PARTY_ROLE_TABLES: Record<PartyRoleKind, 'customer_roles' | 'vendor_roles' | 'employee_roles'> = {
  customer: 'customer_roles',
  vendor: 'vendor_roles',
  employee: 'employee_roles',
}

export function partyRoleKindOf(kind: unknown): PartyRoleKind | null {
  return kind === 'customer' || kind === 'vendor' || kind === 'employee' ? kind : null
}

export function partyRoleTable(kind: PartyRoleKind): 'customer_roles' | 'vendor_roles' | 'employee_roles' {
  return PARTY_ROLE_TABLES[kind]
}

/**
 * OM-16: keep a role-kind party backed by its canonical role row.
 *
 * Writers that persist `parties.kind` without going through the parties
 * routes (master-data import, the generic v1/MCP entity writer) call this
 * after the party row lands, in the same transaction where one exists. A
 * role-kind kind with no role row strands a "Kind: Vendor" no read can
 * back, so the canonical row is created atomically with the kind that
 * names it.
 *
 * Insert-only by construction (`on conflict do nothing` — a conflict here
 * is the expected benign case of a re-import or a retry meeting the row the
 * first attempt wrote): an existing role row, active or deactivated, is
 * never flipped by a kind echo or a re-import.
 */
export async function ensurePartyRoleRow(
  executor: SqlExecutor | typeof db,
  args: { orgId: string; partyId: string; kind: unknown; isActive?: unknown; actorId: string },
): Promise<void> {
  const role = partyRoleKindOf(args.kind)
  if (!role) return
  const table = PARTY_ROLE_TABLES[role]
  const active = args.isActive !== false
  await executor.execute(sql`
    insert into ${sql.raw(table)} (org_id, party_id, is_active, created_by, updated_by)
    values (${args.orgId}, ${args.partyId}, ${active}, ${args.actorId}, ${args.actorId})
    on conflict (party_id) do nothing`)
}

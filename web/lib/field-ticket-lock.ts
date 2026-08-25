import 'server-only'

/**
 * Causal lock namespace for Field Ticket state transitions. Advisory locks are
 * scoped per org on one pinned transaction connection, so the caller must hold
 * the same connection for every write the lock protects.
 */
export function resolveFieldTicketLockId(
  purpose: 'sign' | 'foreman-sign' | 'approve' | 'charge',
  orgId: string,
  ticketId: string,
  requestId?: string,
): bigint {
  const scope = requestId ? `${orgId}:${ticketId}:${requestId}` : `${orgId}:${ticketId}`
  return hashtext(`field-ticket:${purpose}:${scope}`)
}

/** Minimal copy of PostgreSQL's hashtext logic so the lock id matches the
 * database-native hashtext() used everywhere else. The 32-bit signed integer
 * result matches pg_catalog.hashtext.
 */
function hashtext(value: string): bigint {
  let hash = 0x811c9dc5n
  const FNV_PRIME = 0x1000193n
  for (let i = 0; i < value.length; i++) {
    hash ^= BigInt(value.charCodeAt(i))
    hash = (hash * FNV_PRIME) & 0xffffffffn
  }
  return hash >= 0x80000000n ? hash - 0x1_0000_0000n : hash
}

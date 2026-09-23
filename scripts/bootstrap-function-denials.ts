/**
 * Runtime-role function-execute denials for an app schema.
 *
 * Function execution is inherited only from deliberately retained PUBLIC
 * grants: the runtime role must not execute functions it is not meant to
 * (notably tightly controlled SECURITY DEFINER maintenance functions), so
 * bootstrap revokes its EXECUTE on the schema's functions. That revoke must
 * never touch an owner-held entry: after the ownership transfer the runtime
 * role owns these functions, and stripping its own entry collapses the ACL
 * to explicitly empty — which denies EXECUTE even to the owner (observed as
 * `permission denied for function lease_charges_base_rent_repair` on
 * migration replay and direct calls) while PUBLIC stays revoked either way.
 * So the revoke is issued per function, skipping owner-held entries; the
 * owner's own grant is neither created nor removed here.
 */

interface FunctionDb {
  query: (
    text: string,
    values?: unknown[],
  ) => Promise<{ rows: Array<{ stmt: string }> }>;
}

/**
 * Revoke EXECUTE from the role on the schema's functions it does not own.
 * Returns the revoke count.
 */
export async function revokeRuntimeFunctionExecute(
  db: FunctionDb,
  roleName: string,
  schemaName = "public",
): Promise<number> {
  const found = await db.query(
    `select 'revoke execute on function ' || p.oid::regprocedure::text
            || ' from ' || quote_ident($1) as stmt
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = $2
        and pg_get_userbyid(p.proowner) <> $1`,
    [roleName, schemaName],
  );
  for (const { stmt } of found.rows) {
    await db.query(stmt);
  }
  return found.rows.length;
}

import { sql } from 'drizzle-orm'
import { type SqlExecutor } from '../platform/db.ts'
import { canonicalJson } from '../platform/canonical-json.ts'
export class ExtensionProjectionError extends Error { constructor(message: string, readonly status = 409) { super(message) } }
async function writeAudit(
  tx: SqlExecutor,
  opts: {
    orgId: string;
    table: string;
    rowId: string;
    action: "insert" | "update";
    event: string;
    reason: string;
    before: unknown;
    after: unknown;
    actorId: string;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${opts.orgId}, ${opts.table}, ${opts.rowId}, ${opts.action},
            ${JSON.stringify({ event: opts.event, reason: opts.reason, before: opts.before, after: opts.after })}::jsonb,
            ${opts.actorId})`);
}

/**
 * Project one page contribution: deactivate this extension's live rows for the
 * route, then insert the new row pointing at the installing version.
 * Org-native tenant rows (extension_version_id NULL) live under their own
 * partial index (0111) and are never touched — they shadow this projection
 * by read-time precedence (user > org-native > extension > built-in) instead
 * of blocking it, and a tenant clear falls back to this row naturally.
 * Other extensions' rows still refuse: one extension owns a route.
 */
export async function projectExtensionPage(
  tx: SqlExecutor,
  opts: {
    orgId: string;
    actorId: string;
    extensionId: string;
    extensionKey: string;
    version: string;
    versionId: string;
    contribution: { kind: 'page'; route: string; spec: unknown; scope?: 'org' };
    reason: string;
  },
): Promise<string> {
  const { orgId, contribution } = opts;
  // Extension rows only: org-native layouts coexist (see above) so they are
  // not occupants here. The FOR UPDATE lock serializes same-route installs
  // of extension rows against each other for the check below.
  const occupants = (
    await tx.execute<{ id: string; extension_version_id: string | null; app_id: string | null; extension_key: string | null }>(sql`
      select s.id, s.extension_version_id, v.app_id, m.key as extension_key
        from page_specs s
        left join app_versions v on v.org_id = s.org_id and v.id = s.extension_version_id
        left join apps m on m.org_id = v.org_id and m.id = v.app_id
       where s.org_id = ${orgId} and s.route = ${contribution.route} and s.is_active and s.user_id is null
         and s.extension_version_id is not null
       for update of s`)
  ).rows;

  for (const row of occupants) {
    if (row.app_id !== opts.extensionId) {
      throw new ExtensionProjectionError(
        `route ${contribution.route} is already projected by extension "${row.extension_key ?? "unknown"}" (${row.extension_version_id}); ` +
          `extension "${opts.extensionKey}" not installed — one extension owns a route`,
        409,
      );
    }
  }

  const superseded = (
    await tx.execute<{ id: string; extension_version_id: string }>(sql`
      update page_specs set is_active = false, updated_at = now(), updated_by = ${opts.actorId}
       where org_id = ${orgId} and route = ${contribution.route} and is_active and user_id is null
         and extension_version_id in (select id from app_versions where org_id = ${orgId} and app_id = ${opts.extensionId})
      returning id, extension_version_id`)
  ).rows;
  for (const row of superseded) {
    await writeAudit(tx, {
      orgId,
      table: "page_specs",
      rowId: row.id,
      action: "update",
      event: "extension_projection_superseded",
      reason: opts.reason,
      before: { route: contribution.route, is_active: true, extension_version_id: row.extension_version_id },
      after: { route: contribution.route, is_active: false, extension_version_id: row.extension_version_id },
      actorId: opts.actorId,
    });
  }

  // A concurrent identical install may have projected this route between
  // our occupant check and this insert; converge on its row instead of
  // leaking a raw unique violation. The arbiter is the 0111 extension partial
  // index — one live row per extension VERSION per route — so a conflict here
  // can only be this same version's row, never the org-native row (its own
  // partial index) and never a superseded version (a different version id).
  const inserted = (
    await tx.execute<{ id: string }>(sql`
      insert into page_specs (org_id, user_id, route, spec, note, extension_version_id, created_by, updated_by)
      values (${orgId}, null, ${contribution.route}, ${JSON.stringify(contribution.spec)}::jsonb,
              ${`Projected by extension "${opts.extensionKey}" version ${opts.version}`},
              ${opts.versionId}, ${opts.actorId}, ${opts.actorId})
      on conflict (org_id, route, extension_version_id) where (is_active and extension_version_id is not null) do nothing
      returning id`)
  ).rows[0] ?? null;
  if (!inserted) {
    const live = (
      await tx.execute<{ id: string; extension_version_id: string; spec: unknown }>(sql`
        select id, extension_version_id, spec from page_specs
         where org_id = ${orgId} and route = ${contribution.route} and is_active and user_id is null
           and extension_version_id = ${opts.versionId}
         limit 1`)
    ).rows[0];
    if (
      live &&
      live.extension_version_id === opts.versionId &&
      canonicalJson(live.spec) === canonicalJson(contribution.spec)
    ) {
      // Identical bytes already projected (the concurrent install won the
      // race); its audit row covers this projection, so converge silently.
      return live.id;
    }
    // Unreachable through the version gate above (same label with different
    // bytes is refused before any projection): a live row for this version
    // carrying other bytes is a hard conflict, never a silent share.
    throw new ExtensionProjectionError(
      `route ${contribution.route} already has a different live projection for this version; ` +
        `extension "${opts.extensionKey}" not installed`,
      409,
    );
  }
  await writeAudit(tx, {
    orgId,
    table: "page_specs",
    rowId: inserted.id,
    action: "insert",
    event: "extension_projection",
    reason: opts.reason,
    before: { superseded_projection_ids: superseded.map((r) => r.id) },
    after: {
      route: contribution.route,
      page_spec_id: inserted.id,
      extension_version_id: opts.versionId,
      extension_key: opts.extensionKey,
      version: opts.version,
    },
    actorId: opts.actorId,
  });
  return inserted.id;
}

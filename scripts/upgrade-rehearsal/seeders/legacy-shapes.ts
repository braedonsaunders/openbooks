/**
 * edge-legacy / edge-refusals seeder (P1B).
 *
 * Runs INSIDE the source tree on the source release's runtime (rehearse.mjs
 * seedWithSeeder copies this file into the source's engine/src and runs it
 * with the source's tsx). It must work on v0.1.0-alpha.22 AND alpha.23, so
 * it imports NOTHING from the engine: only `pg` (a dependency at every tag)
 * plus env. Every shape below exists in the baseline schema shared by both
 * tags (verified: the tags differ by exactly one unrelated migration, 0236).
 *
 * Selection is by CLI arg: `legacy` builds the NOTICE shapes (the install
 * upgrades cleanly, then post-upgrade assertions verify legacy handling),
 * `refusals` builds the REFUSE shapes (bootstrap --check must report exactly
 * expectFindings, bootstrap refuses without touching the ledger, the remedy
 * files apply, --check comes back clean, the upgrade proceeds).
 *
 * Raw SQL throughout, by design: malformed markers, negative counts and
 * duplicate subjects cannot be produced through the source's own writers
 * (they refuse), which is exactly the instruction's carve-out ("raw SQL
 * only where the source schema allowed it"). Where the source could produce
 * the shape (in-place rule/profile edits, vendor rename), raw SQL performs
 * the same row transition the API would, without coupling this file to
 * engine APIs that drift between tags.
 *
 * Prints `{"orgIds": [...]}` as its last JSON line (seedWithSeeder contract).
 *
 * Fixed ids: rows the remedy files mechanize (0299 true values, 0296 marker
 * correction) use the exact ids those files name; everything else is
 * discoverable by its EDGE- prefix.
 */
import pg from "pg";

const MODE = process.argv[2] === "refusals" ? "refusals" : "legacy";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  // Raw SQL with no tenant context: the runtime login sees zero org rows
  // through RLS, so the runner hands raw-SQL seeders the migration login as
  // OPENBOOKS_SEED_DB_URL. Standalone runs keep working: a directly exported
  // OPENBOOKS_DB_URL (usually the migration login) is the fallback.
  const seedUrl = process.env["OPENBOOKS_SEED_DB_URL"]?.trim() || requireEnv("OPENBOOKS_DB_URL");
  const client = new pg.Client({ connectionString: seedUrl });
  await client.connect();
  try {
    // The rehearsal database holds exactly one org: with several tenants,
    // taking whatever sorts first would seed legacy shapes into an
    // arbitrary org. (Inline here by design — this file imports nothing
    // from the engine so it runs on both the alpha.22 and alpha.23
    // runtimes — rather than sharing the provisioning guard.)
    const orgs = (await client.query<{ id: string; name: string }>(
      `select id, name from public.orgs order by created_at`,
    )).rows;
    if (orgs.length !== 1) {
      throw new Error(
        `legacy-shapes seeder runs against exactly one org but found ${orgs.length}` +
          (orgs.length === 0
            ? " — seed an org first"
            : ` — available orgs: ${orgs.map((org) => `${org.name} (${org.id})`).join(", ")}`),
      );
    }
    const orgId = orgs[0]!.id;
    const sub = (await client.query<{ id: string }>(
      `select id from public.subsidiaries where org_id = $1 order by created_at limit 1`,
      [orgId],
    )).rows[0];
    if (!sub) throw new Error("legacy-shapes seeder found no subsidiary to seed into");

    if (MODE === "refusals") await seedRefusals(client, orgId, sub.id);
    else {
      // The 0291 scope (and the scheduler tick the assertions drive) admits
      // only production orgs with Bank Feeds on the Features switchboard.
      // env_kind defaults to production; bankFeeds defaults off, so the
      // legacy org opts in here — deep-merged, never clobbering siblings.
      await client.query(
        `update public.orgs
            set settings = coalesce(settings, '{}'::jsonb)
              || jsonb_build_object('features',
                   coalesce(settings->'features', '{}'::jsonb)
                   || '{"bankFeeds": true}'::jsonb)
          where id = $1`,
        [orgId],
      );
      await seedLegacy(client, orgId, sub.id);
    }

    console.log(JSON.stringify({ orgIds: [orgId] }));
  } finally {
    await client.end();
  }
}

async function seedRefusals(client: pg.Client, orgId: string, subsidiaryId: string): Promise<void> {
  // Shared inventory parents.
  await client.query(
    `insert into public.locations (org_id, name) values ($1, 'EDGE warehouse')
     on conflict do nothing`,
    [orgId],
  );
  const loc = (await client.query<{ id: string }>(
    `select id from public.locations where org_id = $1 and name = 'EDGE warehouse'`,
    [orgId],
  )).rows[0]!.id;
  await client.query(
    `insert into public.stock_locations (org_id, location_id, code)
     values ($1, $2, 'EDGE-BIN') on conflict do nothing`,
    [orgId, loc],
  );
  const sloc = (await client.query<{ id: string }>(
    `select id from public.stock_locations where org_id = $1 and code = 'EDGE-BIN'`,
    [orgId],
  )).rows[0]!.id;
  await client.query(
    `insert into public.items (org_id, kind, name) values ($1, 'stock', 'EDGE widget')
     on conflict do nothing`,
    [orgId],
  );
  const item = (await client.query<{ id: string }>(
    `select id from public.items where org_id = $1 and name = 'EDGE widget'`,
    [orgId],
  )).rows[0]!.id;

  // Duplicate subjects on a DRAFT count: 0293.duplicate_subject refuse.
  const draft = (await client.query<{ id: string }>(
    `insert into public.stock_counts (org_id, location_id, subsidiary_id, status, counted_on, memo)
     values ($1, $2, $3, 'draft', '2026-01-15', 'EDGE dup')
     returning id`,
    [orgId, loc, subsidiaryId],
  )).rows[0]!.id;
  await client.query(
    `insert into public.stock_count_lines
       (org_id, stock_count_id, item_id, stock_location_id, lot_id, expected_quantity, counted_quantity)
     values ($1, $2, $3, $4, NULL, 10, 9), ($1, $2, $3, $4, NULL, 10, 9)`,
    [orgId, draft, item, sloc],
  );

  // Negatives on their own DRAFT count. Fixed ids are kept for stability
  // and discoverability; the 0299 remedy takes the delete-and-recount
  // branch for draft counts holding negatives.
  const negCount = (await client.query<{ id: string }>(
    `insert into public.stock_counts (org_id, location_id, subsidiary_id, status, counted_on, memo)
     values ($1, $2, $3, 'draft', '2026-01-16', 'EDGE neg')
     returning id`,
    [orgId, loc, subsidiaryId],
  )).rows[0]!.id;
  await client.query(
    `insert into public.stock_count_lines
       (id, org_id, stock_count_id, item_id, stock_location_id, lot_id, expected_quantity, counted_quantity)
     values ('02990000-0000-4000-8000-000000000001', $1, $2, $3, $4, NULL, 10, -3),
            ('02990000-0000-4000-8000-000000000002', $1, $2, $3, $4, NULL, 10, -1)`,
    [orgId, negCount, item, sloc],
  );

  // Vendor for the malformed-marker bills (fixed id shared with the remedy file).
  await client.query(
    `insert into public.parties (id, org_id, kind, display_name)
     values ('02960000-0000-4000-8000-000000000010', $1, 'vendor', 'EDGE CRA')
     on conflict (id) do nothing`,
    [orgId],
  );
  // Malformed payrollRemittance markers: impossible date, mis-dashed uuid,
  // and a marker missing its required fields. 0296.malformed_remittance_marker
  // refuse. The remedy file strips the tag from exactly these bills.
  await client.query(
    `insert into public.documents
       (id, org_id, kind, document_number, document_date, currency, custom)
     values
       ('02960000-0000-4000-8000-000000000001', $1, 'vendor_bill', 'EDGE-BAD-DATE', '2026-01-31', 'USD',
        '{"payrollRemittance": {"from": "2026-13-45", "to": "2026-01-31", "partyId": "02960000-0000-4000-8000-000000000010"}}'),
       ('02960000-0000-4000-8000-000000000002', $1, 'vendor_bill', 'EDGE-BAD-UUID', '2026-01-31', 'USD',
        '{"payrollRemittance": {"from": "2026-01-01", "to": "2026-01-31", "partyId": "aaaaaaaa-bbbb-cccc-ddd-eeeeeeeeeeeee"}}'),
       ('02960000-0000-4000-8000-000000000003', $1, 'vendor_bill', 'EDGE-MISSING', '2026-01-31', 'USD',
        '{"payrollRemittance": {"from": "2026-01-01"}}')
     on conflict (id) do nothing`,
    [orgId],
  );
}

async function seedLegacy(client: pg.Client, orgId: string, subsidiaryId: string): Promise<void> {
  // Shared inventory parents (same shape as refusals; separate names).
  await client.query(
    `insert into public.locations (org_id, name) values ($1, 'EDGE legacy warehouse')
     on conflict do nothing`,
    [orgId],
  );
  const loc = (await client.query<{ id: string }>(
    `select id from public.locations where org_id = $1 and name = 'EDGE legacy warehouse'`,
    [orgId],
  )).rows[0]!.id;
  await client.query(
    `insert into public.stock_locations (org_id, location_id, code)
     values ($1, $2, 'EDGE-LEGACY-BIN') on conflict do nothing`,
    [orgId, loc],
  );
  const sloc = (await client.query<{ id: string }>(
    `select id from public.stock_locations where org_id = $1 and code = 'EDGE-LEGACY-BIN'`,
    [orgId],
  )).rows[0]!.id;
  await client.query(
    `insert into public.items (org_id, kind, name) values ($1, 'stock', 'EDGE legacy widget')
     on conflict do nothing`,
    [orgId],
  );
  const item = (await client.query<{ id: string }>(
    `select id from public.items where org_id = $1 and name = 'EDGE legacy widget'`,
    [orgId],
  )).rows[0]!.id;

  // Custom catch-all group. The pristine default `other` arrives with 0306 at
  // upgrade time, so the post-upgrade scope holds default-plus-custom:
  // 0319.default-plus-custom notice.
  await client.query(
    `insert into public.account_groups (org_id, dimension, key, name, color, sort_order, match, is_catch_all)
     values ($1, 'cost_pool', 'edge-catch', 'EDGE Catch', '#111111', 10, '{}', true)
     on conflict (org_id, dimension, key) do nothing`,
    [orgId],
  );

  // Executed waiver whose vendor is renamed afterwards: 0292 notice.
  // (The insert lists every NOT NULL column the baseline CHECKs require.)
  const vendor = (await client.query<{ id: string }>(
    `insert into public.parties (org_id, kind, display_name)
     values ($1, 'vendor', 'EDGE Vendor') returning id`,
    [orgId],
  )).rows[0]!.id;
  const project = (await client.query<{ id: string }>(
    `insert into public.projects (org_id, name) values ($1, 'EDGE Tower') returning id`,
    [orgId],
  )).rows[0]!.id;
  await client.query(
    `insert into public.lien_waivers
       (org_id, waiver_number, direction, party_id, project_id, waiver_type,
        status, through_date, currency, signed_at, signed_by_name)
     values ($1, 'EDGE-W-1', 'issued', $2, $3, 'unconditional_final',
             'signed', '2026-01-31', 'USD', '2026-02-01T10:00:00Z', 'EDGE Signer')`,
    [orgId, vendor, project],
  );
  await client.query(`update public.parties set display_name = 'EDGE Vendor Renamed' where id = $1`, [vendor]);
  await client.query(`update public.projects set name = 'EDGE Tower Renamed' where id = $1`, [project]);

  // Active SFTP schedule with no binding configured (the binding column does
  // not exist pre-0291): 0291.unbound-schedule notice. The assertions drive
  // one scheduler tick and stage one identified file, proving the schedule
  // pauses with a named notice instead of misattributing — so the server is
  // local-backend (a rehearsal has no S3) and the org holds a recipient
  // operator (the notice needs an active author, super-admin, or setup
  // manager; a source install has no users at all). The operator arrives
  // inactive (an active user must hold an explicit role assignment, 0096
  // guard), takes the Administrator role, then activates. A source install
  // seeds the roles; the hash is never used for a login, only the flags.
  const operator = (await client.query<{ id: string }>(
    `insert into public.users (org_id, email, name, password_hash, is_super_admin, is_active)
     values ($1, 'edge-operator@example.invalid', 'EDGE Operator', 'NOT-A-REAL-HASH', true, false)
     returning id`,
    [orgId],
  )).rows[0]!.id;
  const assigned = await client.query(
    `insert into public.role_assignments (org_id, user_id, role_id)
     select $1, $2, r.id from public.app_roles r
      where r.org_id = $1 and r.name = 'Administrator'
      limit 1`,
    [orgId, operator],
  );
  if (assigned.rowCount !== 1) {
    throw new Error("legacy-shapes seeder found no Administrator role to assign the EDGE operator");
  }
  await client.query(`update public.users set is_active = true where id = $1`, [operator]);
  // The tick confines every server under sftp/<org_id>/ (assertTenantRootPrefix),
  // and the local backend roots at $OPENBOOKS_DATA_DIR/sftp.
  const server = (await client.query<{ id: string }>(
    `insert into public.sftp_servers (org_id, name, username, backend, root_prefix)
     values ($1, 'EDGE bank', 'edge', 'local', $2) returning id`,
    [orgId, `sftp/${orgId}/edge-inbound`],
  )).rows[0]!.id;
  const acct = (await client.query<{ id: string }>(
    `insert into public.accounts (org_id, name, type) values ($1, 'EDGE checking', 'asset') returning id`,
    [orgId],
  )).rows[0]!.id;
  await client.query(
    `insert into public.sftp_import_schedules (org_id, sftp_server_id, account_id, is_active, created_by)
     values ($1, $2, $3, true, $4)`,
    [orgId, server, acct, operator],
  );

  // Document completed under a live-action schedule: 0274 notice. The doc is
  // completed (completed_at set) so m74's 0326 retrospective marks it too.
  const sched = (await client.query<{ id: string }>(
    `insert into public.hrm_retention_schedules (org_id, category_key, retain_years, from_event, action)
     values ($1, 'EDGE-CAT', 7, 'termination', 'anonymize') returning id`,
    [orgId],
  )).rows[0]!.id;
  await client.query(
    `insert into public.hrm_documents (org_id, category_key, title, retention_rule_id, completed_at)
     values ($1, 'EDGE-CAT', 'EDGE file', $2, '2026-03-01T00:00:00Z')`,
    [orgId, sched],
  );

  // Recognition rule edited in place after its obligation was created: 0297 notice.
  const customer = (await client.query<{ id: string }>(
    `insert into public.parties (org_id, kind, display_name)
     values ($1, 'customer', 'EDGE Customer') returning id`,
    [orgId],
  )).rows[0]!.id;
  const contract = (await client.query<{ id: string }>(
    `insert into public.revenue_contracts (org_id, customer_id, contract_number)
     values ($1, $2, 'EDGE-C-1') returning id`,
    [orgId, customer],
  )).rows[0]!.id;
  const rule = (await client.query<{ id: string }>(
    `insert into public.recognition_rules (org_id, code, name, method, created_at, updated_at)
     values ($1, 'EDGE-RR', 'EDGE rule', 'straight_line_even', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
     returning id`,
    [orgId],
  )).rows[0]!.id;
  await client.query(
    `insert into public.performance_obligations
       (org_id, contract_id, description, recognition_rule_id, allocated_price, created_at)
     values ($1, $2, 'EDGE obligation', $3, 1200, '2026-01-15T00:00:00Z')`,
    [orgId, contract, rule],
  );
  await client.query(
    `update public.recognition_rules
        set method = 'point_in_time', updated_at = '2026-06-01T00:00:00Z'
      where id = $1`,
    [rule],
  );

  // Item rate version older than its profile's last edit: 0298 notice.
  const rateItem = (await client.query<{ id: string }>(
    `insert into public.items (org_id, kind, name) values ($1, 'service', 'EDGE rate item') returning id`,
    [orgId],
  )).rows[0]!.id;
  const book = (await client.query<{ id: string }>(
    `insert into public.item_rate_books (org_id, code, name, currency)
     values ($1, 'EDGE-RB', 'EDGE book', 'USD') returning id`,
    [orgId],
  )).rows[0]!.id;
  const version = (await client.query<{ id: string }>(
    `insert into public.item_rate_versions (org_id, rate_book_id, effective_from, created_at)
     values ($1, $2, '2026-01-01', '2026-01-10T00:00:00Z') returning id`,
    [orgId, book],
  )).rows[0]!.id;
  await client.query(
    `insert into public.item_rate_profiles
       (org_id, item_id, base_unit, pricing_policy, invoice_presentation, created_at, updated_at)
     values ($1, $2, 'hour', 'capped_ladder', 'rate_components', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    [orgId, rateItem],
  );
  await client.query(
    `insert into public.item_rate_lines (org_id, version_id, item_id, unit_code, unit_name, base_quantity)
     values ($1, $2, $3, 'HR', 'Hour', 1)`,
    [orgId, version, rateItem],
  );
  await client.query(
    `update public.item_rate_profiles
        set pricing_policy = 'lowest_cost', updated_at = '2026-06-01T00:00:00Z'
      where org_id = $1 and item_id = $2`,
    [orgId, rateItem],
  );

  // Posted history the guards grandfather: duplicate subjects + a negative on
  // POSTED counts (0293/0299 grandfathered notices; immutable, never merged).
  const posted = (await client.query<{ id: string }>(
    `insert into public.stock_counts (org_id, location_id, subsidiary_id, status, counted_on, memo)
     values ($1, $2, $3, 'posted', '2026-01-10', 'EDGE posted')
     returning id`,
    [orgId, loc, subsidiaryId],
  )).rows[0]!.id;
  await client.query(
    `insert into public.stock_count_lines
       (org_id, stock_count_id, item_id, stock_location_id, lot_id, expected_quantity, counted_quantity)
     values ($1, $2, $3, $4, NULL, 10, 9), ($1, $2, $3, $4, NULL, 10, 9), ($1, $2, $3, $4, NULL, 10, -5)`,
    [orgId, posted, item, sloc],
  );
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);

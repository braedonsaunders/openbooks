/** Migration filename transitions and the digest-transition ledger. Split from scripts/bootstrap.ts (ARCH-FILE-SPLIT; pure moves only). */
import { migrationsDir, sha256 } from "../bootstrap-paths"
import { type MigrationLedgerClient } from "./governed-views"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { pool } from "../../engine/src/platform/db.ts"


type MigrationFilenameIdentity = {
  filename: string;
  sha256: string;
};

type MigrationFilenameTransition = {
  from: MigrationFilenameIdentity;
  to: MigrationFilenameIdentity;
  reason: string;
};

/**
 * A published migration rename is not a new migration and must never re-run
 * its body. Each transition therefore binds both filenames to the exact same
 * reviewed bytes. Existing ledgers move only the primary-key filename; their
 * digest is neither rewritten nor restamped.
 */
export const APPROVED_MIGRATION_FILENAME_TRANSITIONS: ReadonlyArray<MigrationFilenameTransition> = [
  {
    from: {
      filename: "generated/0006_terminal_failure_surfacing.sql",
      sha256: "df5db290b100f7bfd51cb4301b86a81442d6031c5efb451df28ad667f6ed3991",
    },
    to: {
      filename: "generated/0035_terminal_failure_surfacing.sql",
      sha256: "df5db290b100f7bfd51cb4301b86a81442d6031c5efb451df28ad667f6ed3991",
    },
    reason: "give terminal-failure surfacing a unique migration ordinal",
  },
  {
    from: {
      filename: "generated/0010_bank_statement_source_idempotency.sql",
      sha256: "a78e9e61ea2860192304c4a254e86f57ecd70c92bd6c5225f7bbaa425c80788e",
    },
    to: {
      filename: "generated/0036_bank_statement_source_idempotency.sql",
      sha256: "a78e9e61ea2860192304c4a254e86f57ecd70c92bd6c5225f7bbaa425c80788e",
    },
    reason: "give bank-statement source idempotency a unique migration ordinal",
  },
  {
    from: {
      filename: "generated/0008_durable_work_lease_fencing.sql",
      sha256: "bd2ade3638423462d48b539afd9c18e77a9ad1301ca2bca3fb4e2e132f8e2011",
    },
    to: {
      filename: "generated/0052_durable_work_lease_fencing.sql",
      sha256: "bd2ade3638423462d48b539afd9c18e77a9ad1301ca2bca3fb4e2e132f8e2011",
    },
    reason:
      "move the lease-fencing backfill after terminal-failure column creation; " +
        "fresh installs otherwise fail at 0008 because the approved 0006-to-0035 " +
        "canonicalization reordered the column DDL behind its backfill",
  },
  {
    from: {
      filename: "generated/0028_email_delivery_idempotency.sql",
      sha256: "ca93c827fa161d267f6b93717f4d0ef28f9d6c30511c52152618229e6f07e052",
    },
    to: {
      filename: "generated/0063_email_delivery_idempotency.sql",
      sha256: "ca93c827fa161d267f6b93717f4d0ef28f9d6c30511c52152618229e6f07e052",
    },
    reason:
      "move the email delivery_key format CHECK + org-scoped index after " +
        "0059_email_delivery_identity_reconciliation which creates the delivery_key " +
        "column; fresh installs otherwise fail at 0028 with 'column delivery_key does " +
        "not exist' because filename order runs 0028 before 0059",
  },
];

export function generatedMigrationFiles(): string[] {
  const generated = readdirSync(join(migrationsDir, "generated"))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const seenOrdinals = new Map<number, string>();
  let previousOrdinal = -1;

  for (const file of generated) {
    const match = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(file);
    if (!match) {
      throw new Error(
        `[bootstrap] generated migration ${file} does not have a four-digit ordinal`,
      );
    }
    const ordinal = Number(match[1]);
    const duplicate = seenOrdinals.get(ordinal);
    if (duplicate) {
      throw new Error(
        `[bootstrap] generated migrations ${duplicate} and ${file} share ordinal ${match[1]}`,
      );
    }
    if (ordinal <= previousOrdinal) {
      throw new Error(
        `[bootstrap] generated migration ${file} is not in strictly increasing ordinal order`,
      );
    }
    seenOrdinals.set(ordinal, file);
    previousOrdinal = ordinal;
  }

  return generated;
}

export function assertMigrationFilenameTransitionTargets(generated: readonly string[]): void {
  const generatedSet = new Set(generated.map((file) => `generated/${file}`));
  for (const transition of APPROVED_MIGRATION_FILENAME_TRANSITIONS) {
    if (transition.from.sha256 !== transition.to.sha256) {
      throw new Error(
        `[bootstrap] migration filename transition ${transition.from.filename} -> ${transition.to.filename} changes its digest`,
      );
    }
    if (generatedSet.has(transition.from.filename)) {
      throw new Error(
        `[bootstrap] legacy migration filename ${transition.from.filename} is still published`,
      );
    }
    if (!generatedSet.has(transition.to.filename)) {
      throw new Error(
        `[bootstrap] renamed migration ${transition.to.filename} is not published`,
      );
    }
    const target = readFileSync(join(migrationsDir, transition.to.filename), "utf8");
    if (sha256(target) !== transition.to.sha256) {
      throw new Error(
        `[bootstrap] renamed migration ${transition.to.filename} does not match its approved digest`,
      );
    }
  }
}

// BEGIN migration-filename-convergence-test-surface
export async function reconcileMigrationFilenameTransitions(
  client: MigrationLedgerClient,
  transitions: ReadonlyArray<MigrationFilenameTransition> = APPROVED_MIGRATION_FILENAME_TRANSITIONS,
): Promise<void> {
  for (const transition of transitions) {
    if (transition.from.sha256 !== transition.to.sha256) {
      throw new Error(
        `[bootstrap] migration filename transition ${transition.from.filename} -> ${transition.to.filename} changes its digest`,
      );
    }

    const recorded = await client.query<{ filename: string; sha256: string }>(
      `select filename, sha256
         from public._applied_migrations
        where filename in ($1, $2)
        order by filename
        for update`,
      [transition.from.filename, transition.to.filename],
    );
    const legacy = recorded.rows.find(
      (row) => row.filename === transition.from.filename,
    );
    if (!legacy) continue;
    if (legacy.sha256 !== transition.from.sha256) {
      throw new Error(
        `[bootstrap] ${transition.from.filename} changed after it was applied; refusing migration filename convergence`,
      );
    }
    const canonical = recorded.rows.find(
      (row) => row.filename === transition.to.filename,
    );
    if (canonical) {
      throw new Error(
        `[bootstrap] migration history contains both ${transition.from.filename} and ${transition.to.filename}`,
      );
    }

    const updated = await client.query(
      `update public._applied_migrations
          set filename = $1
        where filename = $2 and sha256 = $3`,
      [transition.to.filename, transition.from.filename, transition.from.sha256],
    );
    if (updated.rowCount !== 1) {
      throw new Error(
        `[bootstrap] ${transition.from.filename} changed during migration filename convergence`,
      );
    }
    console.log(
      `[bootstrap] migration history renamed ${transition.from.filename} -> ${transition.to.filename}`,
    );
    console.log(`[bootstrap]   ${transition.reason}`);
  }
}
// END migration-filename-convergence-test-surface
export async function convergeMigrationFilenames(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await reconcileMigrationFilenameTransitions(client);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Published migrations are immutable except for an exact, reviewed digest
 * transition. A restamp is limited to a schema-equivalent rebaseline whose
 * before/after dumps match. A reapply is limited to a corrective revision that
 * is deliberately idempotent against the old migration's successful state.
 *
 * This is a fixed table of digest pairs rather than a bypass flag. Each entry
 * names both byte identities and its one permitted strategy; every other
 * mismatch still fails closed.
 */
export const APPROVED_MIGRATION_TRANSITIONS: ReadonlyArray<{
  filename: string;
  from: string;
  to: string;
  strategy: "restamp" | "reapply";
  reason: string;
}> = [
  {
    filename: "generated/0001_baseline.sql",
    from: "f65211f25eb7d6fb31669612b9be2cfcafd1c24717902adc8f1cffa3fb121f5b",
    to: "51397fe175d9c3c6f10853625847cf6f9b8615fc52701ac5973095c3dca2360e",
    strategy: "restamp",
    reason:
      "the canonical baseline was regenerated repeatedly across August 2026 (this "
      + "identity was published at 7c8c5d5a4) without per-hop transition entries, so "
      + "a ledger recorded at it aborted the whole chain at 0001 with 'changed after "
      + "it was applied'. This entry advances the identity to the current canonical "
      + "digest; the schema delta that regeneration family introduced beyond the "
      + "runtime-refreshed views - the timesheet week lifecycle - is carried "
      + "idempotently by forward migration 0248. Restamp, not reapply: the baseline "
      + "is ~48k lines of pg_dump output whose replay would corrupt tenant data. A "
      + "database at this identity additionally predates the baseline-only "
      + "absorptions that landed later and never had forward migrations of their own "
      + "(payroll filing submissions, employee tax certificates, party payment stats, "
      + "GL month activity, payroll opening balance components); reconciliation "
      + "migrations for those are pending, and past this transition any use of them "
      + "surfaces as a named failure instead of the blanket immutability refusal.",
  },
  {
    filename: "generated/0001_baseline.sql",
    from: "1fadf5ee6e4639f7755844d9b1b36b5739deeb9b0f58590ff7c3de2f0aa02659",
    to: "51397fe175d9c3c6f10853625847cf6f9b8615fc52701ac5973095c3dca2360e",
    strategy: "restamp",
    reason:
      "the canonical baseline was regenerated repeatedly across August 2026 (this "
      + "identity was published at 3a4f4ccf4) without per-hop transition entries, so "
      + "a ledger recorded at it aborted the whole chain at 0001 with 'changed after "
      + "it was applied'. This entry advances the identity to the current canonical "
      + "digest; the schema delta that regeneration family introduced beyond the "
      + "runtime-refreshed views - the timesheet week lifecycle - is carried "
      + "idempotently by forward migration 0248. Restamp, not reapply: the baseline "
      + "is ~48k lines of pg_dump output whose replay would corrupt tenant data. A "
      + "database at this identity additionally predates the baseline-only "
      + "absorptions that landed later and never had forward migrations of their own "
      + "(payroll filing submissions, employee tax certificates, party payment stats, "
      + "GL month activity, payroll opening balance components); reconciliation "
      + "migrations for those are pending, and past this transition any use of them "
      + "surfaces as a named failure instead of the blanket immutability refusal.",
  },
  {
    filename: "generated/0001_baseline.sql",
    from: "b4e3aa7d8dee59e79e7e3317d2faff4a425676af8549297681a35345efa19b9d",
    to: "51397fe175d9c3c6f10853625847cf6f9b8615fc52701ac5973095c3dca2360e",
    strategy: "restamp",
    reason:
      "the canonical baseline was regenerated repeatedly across August 2026 (this "
      + "identity was published at eee5886ab) without per-hop transition entries, so "
      + "a ledger recorded at it aborted the whole chain at 0001 with 'changed after "
      + "it was applied'. This entry advances the identity to the current canonical "
      + "digest; the schema delta that regeneration family introduced beyond the "
      + "runtime-refreshed views - the timesheet week lifecycle - is carried "
      + "idempotently by forward migration 0248. Restamp, not reapply: the baseline "
      + "is ~48k lines of pg_dump output whose replay would corrupt tenant data. A "
      + "database at this identity additionally predates the baseline-only "
      + "absorptions that landed later and never had forward migrations of their own "
      + "(payroll filing submissions, employee tax certificates, party payment stats, "
      + "GL month activity, payroll opening balance components); reconciliation "
      + "migrations for those are pending, and past this transition any use of them "
      + "surfaces as a named failure instead of the blanket immutability refusal.",
  },
  {
    filename: "generated/0001_baseline.sql",
    from: "51442b77d6796b1e0ef042839e01e4098ab4888281e9d611873227fc0a7cb5c9",
    to: "51397fe175d9c3c6f10853625847cf6f9b8615fc52701ac5973095c3dca2360e",
    strategy: "restamp",
    reason:
      "the canonical baseline was regenerated repeatedly across August 2026 (this "
      + "identity was published at f6018a4ae) without per-hop transition entries, so "
      + "a ledger recorded at it aborted the whole chain at 0001 with 'changed after "
      + "it was applied'. This entry advances the identity to the current canonical "
      + "digest; the schema delta that regeneration family introduced beyond the "
      + "runtime-refreshed views - the timesheet week lifecycle - is carried "
      + "idempotently by forward migration 0248. Restamp, not reapply: the baseline "
      + "is ~48k lines of pg_dump output whose replay would corrupt tenant data. A "
      + "database at this identity additionally predates the baseline-only "
      + "absorptions that landed later and never had forward migrations of their own "
      + "(payroll filing submissions, employee tax certificates, party payment stats, "
      + "GL month activity, payroll opening balance components); reconciliation "
      + "migrations for those are pending, and past this transition any use of them "
      + "surfaces as a named failure instead of the blanket immutability refusal.",
  },
  {
    filename: "generated/0001_baseline.sql",
    from: "197b4a0d018dbbeb93a80786ebddf1a2171c671b9f80a1254d202a8b0dcbb049",
    to: "51397fe175d9c3c6f10853625847cf6f9b8615fc52701ac5973095c3dca2360e",
    strategy: "restamp",
    reason:
      "the canonical baseline was regenerated repeatedly across August 2026 (this "
      + "identity was published at a544960bd) without per-hop transition entries, so "
      + "a ledger recorded at it aborted the whole chain at 0001 with 'changed after "
      + "it was applied'. This entry advances the identity to the current canonical "
      + "digest; the schema delta that regeneration family introduced beyond the "
      + "runtime-refreshed views - the timesheet week lifecycle - is carried "
      + "idempotently by forward migration 0248. Restamp, not reapply: the baseline "
      + "is ~48k lines of pg_dump output whose replay would corrupt tenant data. A "
      + "database at this identity additionally predates the baseline-only "
      + "absorptions that landed later and never had forward migrations of their own "
      + "(payroll filing submissions, employee tax certificates, party payment stats, "
      + "GL month activity, payroll opening balance components); reconciliation "
      + "migrations for those are pending, and past this transition any use of them "
      + "surfaces as a named failure instead of the blanket immutability refusal.",
  },
  {
    filename: "generated/0001_baseline.sql",
    from: "ab9387ff76b968fb9c3edbeacfabc8dbc355f14597e85ee2886436e6a188b834",
    to: "51397fe175d9c3c6f10853625847cf6f9b8615fc52701ac5973095c3dca2360e",
    strategy: "restamp",
    reason:
      "the canonical baseline was regenerated repeatedly across August 2026 (this "
      + "identity was published at 60e5b4fca) without per-hop transition entries, so "
      + "a ledger recorded at it aborted the whole chain at 0001 with 'changed after "
      + "it was applied'. This entry advances the identity to the current canonical "
      + "digest; the schema delta that regeneration family introduced beyond the "
      + "runtime-refreshed views - the timesheet week lifecycle - is carried "
      + "idempotently by forward migration 0248. Restamp, not reapply: the baseline "
      + "is ~48k lines of pg_dump output whose replay would corrupt tenant data. A "
      + "database at this identity additionally predates the baseline-only "
      + "absorptions that landed later and never had forward migrations of their own "
      + "(payroll filing submissions, employee tax certificates, party payment stats, "
      + "GL month activity, payroll opening balance components); reconciliation "
      + "migrations for those are pending, and past this transition any use of them "
      + "surfaces as a named failure instead of the blanket immutability refusal.",
  },
  {
    filename: "generated/0001_baseline.sql",
    from: "f6ecbacdf37ff464d5cf2625594fbe6e69288e719f5428a60c63d7b07c84fb5e",
    to: "51397fe175d9c3c6f10853625847cf6f9b8615fc52701ac5973095c3dca2360e",
    strategy: "restamp",
    reason:
      "the canonical baseline was regenerated repeatedly across August 2026 (this "
      + "identity was published at 672b72ffa) without per-hop transition entries, so "
      + "a ledger recorded at it aborted the whole chain at 0001 with 'changed after "
      + "it was applied'. This entry advances the identity to the current canonical "
      + "digest; the schema delta that regeneration family introduced beyond the "
      + "runtime-refreshed views - the timesheet week lifecycle - is carried "
      + "idempotently by forward migration 0248. Restamp, not reapply: the baseline "
      + "is ~48k lines of pg_dump output whose replay would corrupt tenant data. A "
      + "database at this identity additionally predates the baseline-only "
      + "absorptions that landed later and never had forward migrations of their own "
      + "(payroll filing submissions, employee tax certificates, party payment stats, "
      + "GL month activity, payroll opening balance components); reconciliation "
      + "migrations for those are pending, and past this transition any use of them "
      + "surfaces as a named failure instead of the blanket immutability refusal.",
  },
  {
    filename: "generated/0001_baseline.sql",
    from: "f932387099f3e8eed708f7caf113b5747bf06665b33053112366f8b9ddbc30e2",
    to: "51397fe175d9c3c6f10853625847cf6f9b8615fc52701ac5973095c3dca2360e",
    strategy: "restamp",
    reason:
      "the canonical baseline was regenerated repeatedly across August 2026 (this "
      + "identity was published at febe8f2d6) without per-hop transition entries, so "
      + "a ledger recorded at it aborted the whole chain at 0001 with 'changed after "
      + "it was applied'. This entry advances the identity to the current canonical "
      + "digest; the schema delta that regeneration family introduced beyond the "
      + "runtime-refreshed views - the timesheet week lifecycle - is carried "
      + "idempotently by forward migration 0248. Restamp, not reapply: the baseline "
      + "is ~48k lines of pg_dump output whose replay would corrupt tenant data. A "
      + "database at this identity additionally predates the baseline-only "
      + "absorptions that landed later and never had forward migrations of their own "
      + "(payroll filing submissions, employee tax certificates, party payment stats, "
      + "GL month activity, payroll opening balance components); reconciliation "
      + "migrations for those are pending, and past this transition any use of them "
      + "surfaces as a named failure instead of the blanket immutability refusal.",
  },
  {
    filename: "generated/0001_baseline.sql",
    from: "0779993e7ab72be43b9f87e80fe928ba34adb97d6fdecce5e31dac83f8e9f5b5",
    to: "51397fe175d9c3c6f10853625847cf6f9b8615fc52701ac5973095c3dca2360e",
    strategy: "restamp",
    reason:
      "the canonical baseline was regenerated repeatedly across August 2026 (this "
      + "identity was published at b5bbbb084) without per-hop transition entries, so "
      + "a ledger recorded at it aborted the whole chain at 0001 with 'changed after "
      + "it was applied'. This entry advances the identity to the current canonical "
      + "digest; the schema delta that regeneration family introduced beyond the "
      + "runtime-refreshed views - the timesheet week lifecycle - is carried "
      + "idempotently by forward migration 0248. Restamp, not reapply: the baseline "
      + "is ~48k lines of pg_dump output whose replay would corrupt tenant data. A "
      + "database at this identity additionally predates the baseline-only "
      + "absorptions that landed later and never had forward migrations of their own "
      + "(payroll filing submissions, employee tax certificates, party payment stats, "
      + "GL month activity, payroll opening balance components); reconciliation "
      + "migrations for those are pending, and past this transition any use of them "
      + "surfaces as a named failure instead of the blanket immutability refusal.",
  },
  {
    filename: "generated/0001_baseline.sql",
    from: "6e9a1efeb9093df663ca8168881c818dfa492f4a4f36f7ad61536cefb5731795",
    to: "51397fe175d9c3c6f10853625847cf6f9b8615fc52701ac5973095c3dca2360e",
    strategy: "restamp",
    reason:
      "the canonical baseline was regenerated repeatedly across August 2026 (this "
      + "identity was published at ca3250a9f) without per-hop transition entries, so "
      + "a ledger recorded at it aborted the whole chain at 0001 with 'changed after "
      + "it was applied'. This entry advances the identity to the current canonical "
      + "digest; the schema delta that regeneration family introduced beyond the "
      + "runtime-refreshed views - the timesheet week lifecycle - is carried "
      + "idempotently by forward migration 0248. Restamp, not reapply: the baseline "
      + "is ~48k lines of pg_dump output whose replay would corrupt tenant data. A "
      + "database at this identity additionally predates the baseline-only "
      + "absorptions that landed later and never had forward migrations of their own "
      + "(payroll filing submissions, employee tax certificates, party payment stats, "
      + "GL month activity, payroll opening balance components); reconciliation "
      + "migrations for those are pending, and past this transition any use of them "
      + "surfaces as a named failure instead of the blanket immutability refusal.",
  },
  {
    filename: "generated/0001_baseline.sql",
    from: "b564ecd1e31e1a67a74e88c41620e6dc9428092942913a3b03dba023f30ad61e",
    to: "51397fe175d9c3c6f10853625847cf6f9b8615fc52701ac5973095c3dca2360e",
    strategy: "restamp",
    reason:
      "the canonical baseline was regenerated repeatedly across August 2026 (this "
      + "identity was published at dddf430d4) without per-hop transition entries, so "
      + "a ledger recorded at it aborted the whole chain at 0001 with 'changed after "
      + "it was applied'. This entry advances the identity to the current canonical "
      + "digest; the schema delta that regeneration family introduced beyond the "
      + "runtime-refreshed views - the timesheet week lifecycle - is carried "
      + "idempotently by forward migration 0248. Restamp, not reapply: the baseline "
      + "is ~48k lines of pg_dump output whose replay would corrupt tenant data. A "
      + "database at this identity additionally predates the baseline-only "
      + "absorptions that landed later and never had forward migrations of their own "
      + "(payroll filing submissions, employee tax certificates, party payment stats, "
      + "GL month activity, payroll opening balance components); reconciliation "
      + "migrations for those are pending, and past this transition any use of them "
      + "surfaces as a named failure instead of the blanket immutability refusal.",
  },
  {
    filename: "generated/0001_baseline.sql",
    from: "c05effa006b6cce26a3f1a3e9fcd64720a0ddc3dca24141a56defceb5109c083",
    to: "51397fe175d9c3c6f10853625847cf6f9b8615fc52701ac5973095c3dca2360e",
    strategy: "restamp",
    reason:
      "the canonical baseline was regenerated repeatedly across August 2026 (this "
      + "identity was published at 10b048323) without per-hop transition entries, so "
      + "a ledger recorded at it aborted the whole chain at 0001 with 'changed after "
      + "it was applied'. This entry advances the identity to the current canonical "
      + "digest; the schema delta that regeneration family introduced beyond the "
      + "runtime-refreshed views - the timesheet week lifecycle - is carried "
      + "idempotently by forward migration 0248. Restamp, not reapply: the baseline "
      + "is ~48k lines of pg_dump output whose replay would corrupt tenant data. A "
      + "database at this identity additionally predates the baseline-only "
      + "absorptions that landed later and never had forward migrations of their own "
      + "(payroll filing submissions, employee tax certificates, party payment stats, "
      + "GL month activity, payroll opening balance components); reconciliation "
      + "migrations for those are pending, and past this transition any use of them "
      + "surfaces as a named failure instead of the blanket immutability refusal.",
  },
  {
    filename: "generated/0001_baseline.sql",
    from: "74a3b21e956f2f02334f5245f54b37fe235af732a8eb3345d86a9ea9611df007",
    to: "51397fe175d9c3c6f10853625847cf6f9b8615fc52701ac5973095c3dca2360e",
    strategy: "restamp",
    reason:
      "the canonical baseline was regenerated repeatedly across August 2026 (this "
      + "identity was published at 9f47d9479) without per-hop transition entries, so "
      + "a ledger recorded at it aborted the whole chain at 0001 with 'changed after "
      + "it was applied'. This entry advances the identity to the current canonical "
      + "digest; the schema delta that regeneration family introduced beyond the "
      + "runtime-refreshed views - the timesheet week lifecycle - is carried "
      + "idempotently by forward migration 0248. Restamp, not reapply: the baseline "
      + "is ~48k lines of pg_dump output whose replay would corrupt tenant data. A "
      + "database at this identity additionally predates the baseline-only "
      + "absorptions that landed later and never had forward migrations of their own "
      + "(payroll filing submissions, employee tax certificates, party payment stats, "
      + "GL month activity, payroll opening balance components); reconciliation "
      + "migrations for those are pending, and past this transition any use of them "
      + "surfaces as a named failure instead of the blanket immutability refusal.",
  },
  {
    filename: "generated/0001_baseline.sql",
    from: "780dfaf134f8d98a40c5e9d143291c161194fec196151aca30d1d4f6f4fbade6",
    to: "51397fe175d9c3c6f10853625847cf6f9b8615fc52701ac5973095c3dca2360e",
    strategy: "restamp",
    reason:
      "the canonical baseline was regenerated repeatedly across August 2026 (this "
      + "identity was published at 2521e288d) without per-hop transition entries, so "
      + "a ledger recorded at it aborted the whole chain at 0001 with 'changed after "
      + "it was applied'. This entry advances the identity to the current canonical "
      + "digest; the schema delta that regeneration family introduced beyond the "
      + "runtime-refreshed views - the timesheet week lifecycle - is carried "
      + "idempotently by forward migration 0248. Restamp, not reapply: the baseline "
      + "is ~48k lines of pg_dump output whose replay would corrupt tenant data. A "
      + "database at this identity additionally predates the baseline-only "
      + "absorptions that landed later and never had forward migrations of their own "
      + "(payroll filing submissions, employee tax certificates, party payment stats, "
      + "GL month activity, payroll opening balance components); reconciliation "
      + "migrations for those are pending, and past this transition any use of them "
      + "surfaces as a named failure instead of the blanket immutability refusal.",
  },
  {
    filename: "generated/0001_baseline.sql",
    from: "4456055b785a98bd396ae0f79cf1f667567a51c4a048771dea8ca4af650f4403",
    to: "51397fe175d9c3c6f10853625847cf6f9b8615fc52701ac5973095c3dca2360e",
    strategy: "restamp",
    reason:
      "the canonical baseline was regenerated repeatedly across August 2026 (this "
      + "identity was published at c10ef0b98) without per-hop transition entries, so "
      + "a ledger recorded at it aborted the whole chain at 0001 with 'changed after "
      + "it was applied'. This entry advances the identity to the current canonical "
      + "digest; the schema delta that regeneration family introduced beyond the "
      + "runtime-refreshed views - the timesheet week lifecycle - is carried "
      + "idempotently by forward migration 0248. Restamp, not reapply: the baseline "
      + "is ~48k lines of pg_dump output whose replay would corrupt tenant data. A "
      + "database at this identity additionally predates the baseline-only "
      + "absorptions that landed later and never had forward migrations of their own "
      + "(payroll filing submissions, employee tax certificates, party payment stats, "
      + "GL month activity, payroll opening balance components); reconciliation "
      + "migrations for those are pending, and past this transition any use of them "
      + "surfaces as a named failure instead of the blanket immutability refusal.",
  },
  {
    filename: "generated/0001_baseline.sql",
    from: "e55af0e3d57075639ca9295c8935b34d031892bd2ec6d77c73c322e1f0fc4041",
    to: "51397fe175d9c3c6f10853625847cf6f9b8615fc52701ac5973095c3dca2360e",
    strategy: "restamp",
    reason:
      "the canonical baseline was regenerated repeatedly across August 2026 (this "
      + "identity was published at 9020552e9) without per-hop transition entries, so "
      + "a ledger recorded at it aborted the whole chain at 0001 with 'changed after "
      + "it was applied'. This entry advances the identity to the current canonical "
      + "digest; the schema delta that regeneration family introduced beyond the "
      + "runtime-refreshed views - the timesheet week lifecycle - is carried "
      + "idempotently by forward migration 0248. Restamp, not reapply: the baseline "
      + "is ~48k lines of pg_dump output whose replay would corrupt tenant data. A "
      + "database at this identity additionally predates the baseline-only "
      + "absorptions that landed later and never had forward migrations of their own "
      + "(payroll filing submissions, employee tax certificates, party payment stats, "
      + "payroll opening balance components); reconciliation migrations for those are "
      + "pending, and past this transition any use of them surfaces as a named "
      + "failure instead of the blanket immutability refusal.",
  },
  {
    filename: "generated/0001_baseline.sql",
    from: "be286c62810e6bd5a83c1296e7b3edba0905b35790411c6e93d4fba7c69d59e8",
    to: "51397fe175d9c3c6f10853625847cf6f9b8615fc52701ac5973095c3dca2360e",
    strategy: "restamp",
    reason:
      "the canonical baseline was regenerated repeatedly across August 2026 (this "
      + "identity was published at 6697ee99c) without per-hop transition entries, so "
      + "a ledger recorded at it aborted the whole chain at 0001 with 'changed after "
      + "it was applied'. This entry advances the identity to the current canonical "
      + "digest; the schema delta that regeneration family introduced beyond the "
      + "runtime-refreshed views - the timesheet week lifecycle - is carried "
      + "idempotently by forward migration 0248. Restamp, not reapply: the baseline "
      + "is ~48k lines of pg_dump output whose replay would corrupt tenant data. A "
      + "database at this identity additionally predates the baseline-only "
      + "absorptions that landed later and never had forward migrations of their own "
      + "(payroll filing submissions, employee tax certificates, party payment stats, "
      + "GL month activity, payroll opening balance components); reconciliation "
      + "migrations for those are pending, and past this transition any use of them "
      + "surfaces as a named failure instead of the blanket immutability refusal.",
  },
  {
    filename: "generated/0001_baseline.sql",
    from: "8441c24678ddb20770d3d8dc7974b05006fe875f6fc1ab81e409f03853468582",
    to: "51397fe175d9c3c6f10853625847cf6f9b8615fc52701ac5973095c3dca2360e",
    strategy: "restamp",
    reason:
      "the canonical baseline was regenerated repeatedly across August 2026 (this "
      + "identity was published at 4193046ba) without per-hop transition entries, so "
      + "a ledger recorded at it aborted the whole chain at 0001 with 'changed after "
      + "it was applied'. This entry advances the identity to the current canonical "
      + "digest; the schema delta that regeneration family introduced beyond the "
      + "runtime-refreshed views - the timesheet week lifecycle - is carried "
      + "idempotently by forward migration 0248. Restamp, not reapply: the baseline "
      + "is ~48k lines of pg_dump output whose replay would corrupt tenant data. A "
      + "database at this identity additionally predates the baseline-only "
      + "absorptions that landed later and never had forward migrations of their own "
      + "(payroll filing submissions, employee tax certificates, party payment "
      + "stats); reconciliation migrations for those are pending, and past this "
      + "transition any use of them surfaces as a named failure instead of the "
      + "blanket immutability refusal.",
  },
  {
    filename: "generated/0001_baseline.sql",
    from: "25d4e4da19a70b0c802b628b452909c458ee993ffbc1e85391f302a0a420f897",
    to: "51397fe175d9c3c6f10853625847cf6f9b8615fc52701ac5973095c3dca2360e",
    strategy: "restamp",
    reason:
      "the canonical baseline was regenerated repeatedly across August 2026 (this "
      + "identity was published at e2951940b) without per-hop transition entries, so "
      + "a ledger recorded at it aborted the whole chain at 0001 with 'changed after "
      + "it was applied'. This entry advances the identity to the current canonical "
      + "digest; the schema delta that regeneration family introduced beyond the "
      + "runtime-refreshed views - the timesheet week lifecycle - is carried "
      + "idempotently by forward migration 0248. Restamp, not reapply: the baseline "
      + "is ~48k lines of pg_dump output whose replay would corrupt tenant data. A "
      + "database at this identity additionally predates the baseline-only "
      + "absorptions that landed later and never had forward migrations of their own "
      + "(payroll filing submissions, employee tax certificates, party payment "
      + "stats); reconciliation migrations for those are pending, and past this "
      + "transition any use of them surfaces as a named failure instead of the "
      + "blanket immutability refusal.",
  },
  {
    filename: "generated/0001_baseline.sql",
    from: "d28acf11d61654a936db58830475d3cd190dd4c55454d5e9d24f3d53b485277a",
    to: "51397fe175d9c3c6f10853625847cf6f9b8615fc52701ac5973095c3dca2360e",
    strategy: "restamp",
    reason:
      "the canonical baseline was regenerated repeatedly across August 2026 (this "
      + "identity was published at c57edc899) without per-hop transition entries, so "
      + "a ledger recorded at it aborted the whole chain at 0001 with 'changed after "
      + "it was applied'. This entry advances the identity to the current canonical "
      + "digest; the schema delta that regeneration family introduced beyond the "
      + "runtime-refreshed views - the timesheet week lifecycle - is carried "
      + "idempotently by forward migration 0248. Restamp, not reapply: the baseline "
      + "is ~48k lines of pg_dump output whose replay would corrupt tenant data. A "
      + "database at this identity additionally predates the baseline-only "
      + "absorptions that landed later and never had forward migrations of their own "
      + "(payroll filing submissions, employee tax certificates, party payment "
      + "stats); reconciliation migrations for those are pending, and past this "
      + "transition any use of them surfaces as a named failure instead of the "
      + "blanket immutability refusal.",
  },
  {
    filename: "generated/0001_baseline.sql",
    from: "fbb2e1ddcceecba7d35c9d6cb96699a4ff05e27652cf1313983ffaa79f08b245",
    to: "51397fe175d9c3c6f10853625847cf6f9b8615fc52701ac5973095c3dca2360e",
    strategy: "restamp",
    reason:
      "the canonical baseline was regenerated repeatedly across August 2026 (this "
      + "identity was published at de2de5c8f) without per-hop transition entries, so "
      + "a ledger recorded at it aborted the whole chain at 0001 with 'changed after "
      + "it was applied'. This entry advances the identity to the current canonical "
      + "digest; the schema delta that regeneration family introduced beyond the "
      + "runtime-refreshed views - the timesheet week lifecycle - is carried "
      + "idempotently by forward migration 0248. Restamp, not reapply: the baseline "
      + "is ~48k lines of pg_dump output whose replay would corrupt tenant data. A "
      + "database at this identity additionally predates the baseline-only "
      + "absorptions that landed later and never had forward migrations of their own "
      + "(payroll filing submissions, employee tax certificates, party payment "
      + "stats); reconciliation migrations for those are pending, and past this "
      + "transition any use of them surfaces as a named failure instead of the "
      + "blanket immutability refusal.",
  },
  {
    filename: "generated/0001_baseline.sql",
    from: "44f9d9aee56eaa87d51b37fab43e3ae96f9a0ba453351bed27ad230e5628f05c",
    to: "51397fe175d9c3c6f10853625847cf6f9b8615fc52701ac5973095c3dca2360e",
    strategy: "restamp",
    reason:
      "the canonical baseline was regenerated repeatedly across August 2026 (this "
      + "identity was published at f7b392df9) without per-hop transition entries, so "
      + "a ledger recorded at it aborted the whole chain at 0001 with 'changed after "
      + "it was applied'. This entry advances the identity to the current canonical "
      + "digest; the schema delta that regeneration family introduced beyond the "
      + "runtime-refreshed views - the timesheet week lifecycle - is carried "
      + "idempotently by forward migration 0248. Restamp, not reapply: the baseline "
      + "is ~48k lines of pg_dump output whose replay would corrupt tenant data. A "
      + "database at this identity additionally predates the baseline-only "
      + "absorptions that landed later and never had forward migrations of their own "
      + "(payroll filing submissions, employee tax certificates, party payment "
      + "stats); reconciliation migrations for those are pending, and past this "
      + "transition any use of them surfaces as a named failure instead of the "
      + "blanket immutability refusal.",
  },
  {
    filename: "generated/0001_baseline.sql",
    from: "700b5d03f383c3d85924d1cfdbd39eceb157727751878260f14eeb2d59378c65",
    to: "51397fe175d9c3c6f10853625847cf6f9b8615fc52701ac5973095c3dca2360e",
    strategy: "restamp",
    reason:
      "the canonical baseline was regenerated repeatedly across August 2026 (this "
      + "identity was published at bf47ae3e7) without per-hop transition entries, so "
      + "a ledger recorded at it aborted the whole chain at 0001 with 'changed after "
      + "it was applied'. This entry advances the identity to the current canonical "
      + "digest; the schema delta that regeneration family introduced beyond the "
      + "runtime-refreshed views - the timesheet week lifecycle - is carried "
      + "idempotently by forward migration 0248. Restamp, not reapply: the baseline "
      + "is ~48k lines of pg_dump output whose replay would corrupt tenant data. A "
      + "database at this identity additionally predates the baseline-only "
      + "absorptions that landed later and never had forward migrations of their own "
      + "(payroll filing submissions, employee tax certificates); reconciliation "
      + "migrations for those are pending, and past this transition any use of them "
      + "surfaces as a named failure instead of the blanket immutability refusal.",
  },
  {
    filename: "generated/0001_baseline.sql",
    from: "7c403687f332814513f33ff3a5628265f8f4aca6e28742e5cfa167e74918c851",
    to: "51397fe175d9c3c6f10853625847cf6f9b8615fc52701ac5973095c3dca2360e",
    strategy: "restamp",
    reason:
      "the canonical baseline was regenerated repeatedly across August 2026 (this "
      + "identity was published at ae8c64e49) without per-hop transition entries, so "
      + "a ledger recorded at it aborted the whole chain at 0001 with 'changed after "
      + "it was applied'. This entry advances the identity to the current canonical "
      + "digest; the schema delta that regeneration family introduced beyond the "
      + "runtime-refreshed views - the timesheet week lifecycle - is carried "
      + "idempotently by forward migration 0248. Restamp, not reapply: the baseline "
      + "is ~48k lines of pg_dump output whose replay would corrupt tenant data.",
  },
  {
    filename: "generated/0001_baseline.sql",
    from: "35ce0c7a8efe59c6a3f19a36be64a9a87ea62e826b2b3d3c26aec818aa361612",
    to: "51397fe175d9c3c6f10853625847cf6f9b8615fc52701ac5973095c3dca2360e",
    strategy: "restamp",
    reason:
      "the canonical baseline was regenerated repeatedly across August 2026 (this "
      + "identity was published at c608d5d22) without per-hop transition entries, so "
      + "a ledger recorded at it aborted the whole chain at 0001 with 'changed after "
      + "it was applied'. This entry advances the identity to the current canonical "
      + "digest; the schema delta that regeneration family introduced beyond the "
      + "runtime-refreshed views - the timesheet week lifecycle - is carried "
      + "idempotently by forward migration 0248. Restamp, not reapply: the baseline "
      + "is ~48k lines of pg_dump output whose replay would corrupt tenant data.",
  },
  {
    filename: "generated/0026_scheduler_outbox_terminal_audit.sql",
    from: "c7dde9ba1846fd0609faaa4426f70d5cbbd14d5a3731a51fb666c048a4a8b235",
    to: "929fd15922f09e86d1b416a6cfedca684492d2b7e20f19e700a83b64a3cfa286",
    strategy: "reapply",
    reason:
      "the corrective revision makes the replay-allowed predicate NULL-safe: a "
      + "NULL p_org_id previously left the comparison NULL, so `IF NOT ...` "
      + "fell through instead of denying. It now returns false for NULL and the "
      + "trigger tests `IS NOT TRUE`, closing a fail-open path on system-scan "
      + "rows that carry no tenant. Every statement is idempotent — CREATE TABLE "
      + "/ INDEX IF NOT EXISTS, CREATE OR REPLACE FUNCTION, DROP TRIGGER IF "
      + "EXISTS, a policy guarded by IF NOT EXISTS, and an anti-joined backfill "
      + "— so reapplying redefines the guard and inserts no duplicate evidence.",
  },
  {
    filename: "generated/0060_lease_base_rent_window_exclusive.sql",
    from: "03f488dd20d7e56efc3a1a4ccc7d5d20977c9f88b821561186a902bb30535e9c",
    to: "72410c818c0c0b5bd006d29cbc7d281f6097f90ca5833690219554b81cabd4da",
    strategy: "restamp",
    reason:
      "the sole difference is one line inside the one-time repair DO block, "
      + "where a cancelled-line counter overwrote instead of accumulating and so "
      + "under-reported in its RAISE NOTICE. The repair has already run on any "
      + "database carrying the old digest and the count was only ever logged, "
      + "never stored. Restamp rather than reapply: the file ends in ALTER TABLE "
      + "... ADD CONSTRAINT, which has no IF NOT EXISTS form and would fail on a "
      + "database that already has the exclusion constraint.",
  },
  {
    filename: "generated/0015_payment_instruction_posting_claim_fence.sql",
    from: "8c71d6c3dfdde2f83c5d7a13c48296bfc3841d54020d6cb29a87cee8e89e663f",
    to: "90b8dcf7b3dccc670bcfc4edb3078ce1a8a234cf0e050254215a6ad59309efc9",
    strategy: "reapply",
    reason:
      "the corrective revision TIGHTENS the fence: the settlement-style retreat "
      + "carve-out (settled/returned/rejected) now also requires every other "
      + "instruction field to be unchanged, so a bank-outcome writer can no "
      + "longer alter unrelated columns without holding the posting claim. The "
      + "file is idempotent — CREATE OR REPLACE FUNCTION, DROP TRIGGER IF "
      + "EXISTS, then comments — so reapplying only redefines the trigger and "
      + "touches no row. A database still on the looser definition is strictly "
      + "less protected until it runs.",
  },
  {
    filename: "generated/0010_bank_statement_source_evidence.sql",
    from: "577f345ac58b2b585fce5802f2895234c2a0494e2835677ad223d735280e2ec6",
    to: "0f36b431a4574d340da65f401fdac15f2e5a92339118d2a2d041529c495be631",
    strategy: "reapply",
    reason:
      "the original migration could only be recorded after every statement "
      + "already had source evidence and raw_file_ref was NOT NULL. Reapplying "
      + "the corrective revision therefore creates no legacy-gap attestations "
      + "on that database and safely refreshes the evidence catalog comment.",
  },
  {
    filename: "generated/0002_kernel_hardening.sql",
    from: "964952e28517abe607b4c6490b7ce1644addfaf4c011c16c8592bb65fa60bb46",
    to: "33947b5ff76c8d3b042e362ebaccfa056ab46690ee448d546aa9e088ea1c37b7",
    strategy: "reapply",
    reason:
      "corrective revision replaces the racy BEFORE-trigger SELECT EXISTS guard "
      + "on income_tax_rates with a storage-side GiST exclusion constraint "
      + "(income_tax_rates_no_active_overlap, mirroring 0051), so concurrent "
      + "overlapping active-rate inserts can no longer both commit. The revision "
      + "is deliberately idempotent against the old migration's successful state "
      + "(retire the single-duty trigger, repair lost-race rows, then add the "
      + "constraint) and replays cleanly on an already-bootstrapped database. "
      + "Now also carries the query-console REVOKE fix described in the "
      + "b814bcca transition below.",
  },
  {
    filename: "generated/0002_kernel_hardening.sql",
    from: "b814bccaa12d21d425aee0fc940c43317b554bbceab0cb12a813f41d1034d156",
    to: "33947b5ff76c8d3b042e362ebaccfa056ab46690ee448d546aa9e088ea1c37b7",
    strategy: "restamp",
    reason:
      "section 1 revoked EXECUTE on the pg_catalog file readers from PUBLIC "
      + "unconditionally. Those functions are not granted to PUBLIC on a stock "
      + "PostgreSQL 16 cluster, so the loop only ever revoked privileges nobody "
      + "held — and because pg_catalog is owned by the superuser, it raised "
      + "'permission denied for function pg_current_logfile' under the "
      + "constrained schema-owner migration role that "
      + "assertConstrainedSchemaOwnerMigrationRole requires, aborting the entire "
      + "chain at 0002 before any later migration could run. The revision skips "
      + "signatures PUBLIC does not hold and downgrades an unrevokable real "
      + "grant to a WARNING naming the superuser statement. A database that "
      + "already recorded b814bcca ran section 1 as a privileged role, so its "
      + "schema is already the revision's outcome and only the digest moves. "
      + "Section 4's duplicate entry_number repair carries a second fix in the "
      + "same revision: it updated posted and reversed journal_entries headers "
      + "without a sanctioned migration path, so it aborted the chain with "
      + "'journal entry % is posted and immutable' on every database that "
      + "actually had duplicates. It now locks journal_entries against "
      + "concurrent writers, suspends je_guard transactionally for the narrowly "
      + "scoped entry_number repair, restores it before later sections run, and "
      + "writes durable per-entry before/after audit evidence. A database that "
      + "recorded b814bcca completed section 4, so it had no duplicates left to "
      + "rename and the revision is a no-op there too.",
  },
  {
    filename: "generated/0062_recognition_events.sql",
    from: "8a21bbb92ccc5ae295ed23572888e396e9099eb96f49403aecc6167b203bebc2",
    to: "3d9146e6152005ced41915a7ad45c3f16c7524a7ba13703126c0a4a4626d9a7b",
    strategy: "restamp",
    reason:
      "corrective RLS policy revision changes TO openbooks_app to TO PUBLIC "
      + "while preserving the tenant predicate; environments.sql already "
      + "replaces org_isolation with the PUBLIC form on every run where the "
      + "policy comment is not openbooks:org_isolation:v1, so databases that "
      + "applied the prior migration already have an equivalent schema before "
      + "and after the restamp.",
  },
  {
    filename: "generated/0006_recurring_occurrence_guard.sql",
    from: "e67de81a35d3e27db9494395d444380361b92d44ba84ecbe72ac8ca976a860c1",
    to: "8bb20d32a74195e630747f48024f5e35e5d72457fa7669d2d80a409b53d72510",
    strategy: "reapply",
    reason:
      "corrective revision adds tenant-coherent composite foreign keys for "
      + "recurring occurrence lineage, after a preflight that refuses to rewrite "
      + "mismatched legacy rows. It drops the original global-id references and "
      + "rebuilds the constraints idempotently against the prior migration state.",
  },
  {
    filename: "generated/0060_lease_base_rent_window_exclusive.sql",
    from: "03f488dd20d7e56efc3a1a4ccc7d5d20977c9f88b821561186a902bb30535e9c",
    to: "72410c818c0c0b5bd006d29cbc7d281f6097f90ca5833690219554b81cabd4da",
    strategy: "restamp",
    reason:
      "corrective revision fixes only the cumulative cancellation count in the "
      + "legacy-overlap repair notice; the exclusion constraint and repaired "
      + "schema/data outcome are unchanged, so existing installations need only "
      + "the reviewed digest restamp.",
  },
  {
    filename: "generated/0079_budget_subsidiary.sql",
    from: "1bec7d225490c8a1fcb0b8a69dccc5b22b77d6da13447d2992a20bc044998353",
    to: "fabec3977b4b5345923a8871098ce46c183fc8bf52a9d7e8026cb4b092f99fac",
    strategy: "restamp",
    reason:
      "local/origin reconciliation: both lines published 0079 with divergent "
      + "bytes and no transition. The local revision is authoritative because it "
      + "carries the newer subsidiary-identity fix (preserve subsidiary identity "
      + "in budget cells) that supersedes the origin revision; the owner-fill and "
      + "resulting budget_lines.subsidiary_id state are equivalent before and "
      + "after, so a ledger recorded at the origin digest advances safely.",
  },
  {
    filename: "generated/0080_payment_instruction_claim_fence_bundle_guard.sql",
    from: "98c8992c32ed83463ea2709a2f4b9a929a0ce366b05a271e65f954997712c93c",
    to: "091062cfeecd8047d8eb22f21eaa8c1917b4735b4d822f294e1bfb9c8186f759",
    strategy: "restamp",
    reason:
      "local/origin reconciliation, corrected direction: both lines published "
      + "0080 with divergent bytes. The local revision advanced the file and was "
      + "then reverted to the origin bytes, which are what the tree publishes "
      + "today - so the published digest is this entry's former 'from', not its "
      + "'to'. As previously written the entry could never fire (a ledger only "
      + "advances when from matches the recorded digest AND to matches the "
      + "published one), and a ledger recorded at the local digest 98c8992c "
      + "stayed wedged. Flipped, those ledgers advance back to the published "
      + "origin identity; the installed trigger and its guard semantics are "
      + "equivalent on both sides, so only the recorded bytes move.",
  },
  {
    filename: "generated/0252_ca_eht_remuneration_opening_ytd.sql",
    from: "52c4b7e9f43fdc4fea907142bf55de7089644849d243ee6f9c4a395b22aa06aa",
    to: "e6727002bfba426eb8bbf67ccf1d380ea9191fb9b3f7592fe4686e3c98c16c20",
    strategy: "reapply",
    reason:
      "corrective revision eb5311a73 hardens the governed payroll_opening_balances "
      + "view replacement: CREATE OR REPLACE cannot reorder a drifted view's columns, "
      + "so the revision drops and recreates the view (nothing depends on it), restores "
      + "the read-role grant explicitly, and adds the five standard header SETs. A "
      + "database that recorded 52c4b7e9 already has the eht_remuneration_ytd column and "
      + "an equivalent view; re-running the current body only re-adds the column (IF NOT "
      + "EXISTS), rebuilds the identical view, and re-issues the grant. Reapply, not "
      + "restamp: the installed view definition text changed, so only executing the body "
      + "converges it.",
  },
  {
    filename: "generated/0257_provisional_cost_subsidiary.sql",
    from: "569040393f4ccd6c64186c49c9d0f7e917a78228d2aacaf5e01a22027099fc43",
    to: "67256fd8450973ff88a2592c4d0bb834547499da41e9410ff96a43a3eb1583fa",
    strategy: "reapply",
    reason:
      "corrective revisions b8403c9a and 0d752732 remove the forbidden lock_timeout, "
      + "guard constraint adds, and stage the two lookup indexes CONCURRENTLY with "
      + "INVALID-index cleanup and guarded NOT VALID/VALIDATE foreign keys. The current "
      + "body is retry-safe against the 56904039 state: columns and indexes use "
      + "IF NOT EXISTS, backfills only fill NULL ownership, and constraints are added "
      + "and validated only when absent or unvalidated. Reapply, not restamp: the "
      + "migration body changed, and executing it converges that state to the current "
      + "staged build.",
  },
  {
    filename: "generated/0258_payment_run_file_created_at.sql",
    from: "5f259721c26016d4642a4ae0c6c7a6d5bd4759116c0576ee7cb61240cde02393",
    to: "acb659bbcd9ac6929267c771070ec4c8f6ca8b34c6e69440ad22d14e5f662f24",
    strategy: "reapply",
    reason:
      "corrective revision af3bf4e appends the billing anchor-day columns (IF NOT "
      + "EXISTS DDL, NULL-guarded backfills, guarded check constraints) to the original "
      + "file_created_at migration. A database recorded at 5f259721 that re-runs the "
      + "current body gains the anchor-day schema idempotently; targeting the current "
      + "digest also carries the later sync-overlap append in the same run. Reapply, not "
      + "restamp: the revision adds real schema the old state lacks.",
  },
  {
    filename: "generated/0258_payment_run_file_created_at.sql",
    from: "2190304596efb06ee372ee695dcd0be042f864dac02801faeda66f49b5fd9381",
    to: "acb659bbcd9ac6929267c771070ec4c8f6ca8b34c6e69440ad22d14e5f662f24",
    strategy: "reapply",
    reason:
      "corrective revision 313d85e appends the bank_feed_connections sync_overlap_days "
      + "column (IF NOT EXISTS DDL, guarded range check; null means the 14-day default, "
      + "so no backfill) to the anchor-day revision. A database recorded at 21903045 "
      + "that re-runs the current body converges to the published schema idempotently. "
      + "Reapply, not restamp: the revision adds real schema the old state lacks.",
  },
  {
    filename: "generated/0265_filing_currency_and_ship_to_snapshot.sql",
    from: "84fe8ca15877116d6f7cb221907a13c2163a1f38f13019afa85962ec80912498",
    to: "863fb22fc97911ed8ef81a8a0808277a8069c4039b96838de94a7c8001639944",
    strategy: "reapply",
    reason:
      "corrective revision 97609eae (tax-nexus shard) appends the documents ship-to "
      + "snapshot to the filings-only 0265: ship_to_country / ship_to_region DDL (both "
      + "IF NOT EXISTS) plus an evidence-only backfill from first-line provider-quote "
      + "destinations, limited to untouched rows so a kernel stamp is never overwritten. "
      + "A database recorded at the filings-only 84fe8ca1 that re-runs the current body "
      + "gains the snapshot columns and backfill idempotently; the filings DDL is all "
      + "IF NOT EXISTS and its backfill NULL-guarded. Reapply, not restamp: the revision "
      + "adds real schema the old state lacks.",
  },
  {
    filename: "generated/0265_filing_currency_and_ship_to_snapshot.sql",
    from: "ae246367720744529f44d87887e154b7f2c28b92bcb3f3fdc6ac0d4d6f76de65",
    to: "863fb22fc97911ed8ef81a8a0808277a8069c4039b96838de94a7c8001639944",
    strategy: "reapply",
    reason:
      "corrective revision UPG-0265 (upgrade rehearsal R1): the functional_currency "
      + "backfill UPDATEs tax_filings, whose baseline tax_filing_immutable guard refuses "
      + "every UPDATE except prepared->filed, so any install holding a filing failed the "
      + "upgrade. The revision suspends that one trigger for the single NULL-guarded "
      + "statement inside the migration's transaction and asserts it is enabled again "
      + "before commit. A database recorded at ae246367 (it could only have applied with "
      + "no filings) re-runs the current body idempotently: every DDL is IF NOT EXISTS "
      + "and both backfills are NULL-guarded. Reapply, not restamp: the body changed.",
  },
  {
    filename: "generated/0296_payroll_remittance_destination_snapshot.sql",
    from: "65164ea1ba89df3dde63064a76bf931f3704ca0c8c802368247858d26d2f2c37",
    to: "126d6d8962862048241522d9862a7a9a72e3cf552f50aac3c5acbb00ba608bb7",
    strategy: "reapply",
    reason:
      "corrective revisions U1+U2+U4+PR6b+U5 (payroll-remittance shard) supersede "
      + "every earlier 0296: U1 refuses first over unparseable legacy markers, naming "
      + "each bill and field. U2 replaces the grand-total backfill with an exact "
      + "reconciliation repair (recorded party equals the marker party, lines per "
      + "liability account equal the accrual groups). U4 resolves each line's "
      + "destination pack-aware (regional key, then snapshot, then pack default, "
      + "from a frozen 0296-era map parity-pinned against the TypeScript "
      + "resolver), so legacy statutory and regional bills gain correct coverage "
      + "instead of zero. PR6b admits the frozen-destination guard for the "
      + "merge's paired amend+migration authority, so a source-asserted merge "
      + "re-points absorbed snapshots to the survivor. Reconciling bills fill "
      + "anti-joined, anything else empties to no backfill rows and is named "
      + "by notice, backfill rows for voided bills are deleted, app-recorded "
      + "rows are never rewritten. Every statement stays idempotent against "
      + "every published revision. Reapply, not restamp: the revisions add "
      + "real guards and repair semantics the old states lack.",
  },
  {
    filename: "generated/0296_payroll_remittance_destination_snapshot.sql",
    from: "5589a8b5b31dfcabd8ccd74ce4d5d6eeca95b141844b6282bfdda4b6ce45f62b",
    to: "126d6d8962862048241522d9862a7a9a72e3cf552f50aac3c5acbb00ba608bb7",
    strategy: "reapply",
    reason:
      "same U1+U2+U4+PR6b+U5 revision as the entry above, for databases that recorded "
      + "the U1-only 5589a8b5.",
  },
  {
    filename: "generated/0296_payroll_remittance_destination_snapshot.sql",
    from: "097ed6dd7492562a23147fca19d013c22da682373c17c7793b008f123ab58704",
    to: "126d6d8962862048241522d9862a7a9a72e3cf552f50aac3c5acbb00ba608bb7",
    strategy: "reapply",
    reason:
      "same U1+U2+U4+PR6b+U5 revision as the entry above, for databases that recorded "
      + "the U1+U2 097ed6dd.",
  },
  {
    filename: "generated/0296_payroll_remittance_destination_snapshot.sql",
    from: "a24896ea622d91dde33b3dd8b25e47928618723d1eb60b08a9ab9f793c063ef3",
    to: "126d6d8962862048241522d9862a7a9a72e3cf552f50aac3c5acbb00ba608bb7",
    strategy: "reapply",
    reason:
      "same U1+U2+U4+PR6b+U5 revision as the entry above, for databases that recorded "
      + "the U1+U2+U4 a24896ea.",
  },
  {
    filename: "generated/0296_payroll_remittance_destination_snapshot.sql",
    from: "96d038a431b19b806fa36dac97ebaf5e3bbbb3001e2240091ef3cf11fe67ab70",
    to: "126d6d8962862048241522d9862a7a9a72e3cf552f50aac3c5acbb00ba608bb7",
    strategy: "reapply",
    reason:
      "U5 hot-table conversion (payroll-remittance shard): the file declares "
      + "no-transaction and the runner applies it statement by statement, the "
      + "snapshot index builds CONCURRENTLY behind an INVALID-drop guard, and "
      + "the snapshot FK arrives NOT VALID with a separate VALIDATE step. "
      + "Every statement stays idempotent against the PR6b state, so reapply, "
      + "not restamp.",
  },
  {
    filename: "generated/0293_stock_count_line_subject_unique.sql",
    from: "19b0e9b674360129aec13cb3c911de38dfd1cb86f1976cca3979c28521720c11",
    to: "38eaf276d1a5f1994b06726a87d4b14d7c703c058967acf2752002368d60a099",
    strategy: "reapply",
    reason:
      "staged revision (U10) builds the duplicate-subject unique as CREATE UNIQUE "
      + "INDEX CONCURRENTLY outside the tracked transaction instead of holding the "
      + "ALTER TABLE lock for the whole build, and preserves pre-guard immutable "
      + "history (U13): lines of duplicate groups on posted or cancelled counts are "
      + "marked is_pre_guard_legacy, and the guard is a partial unique index over "
      + "unmarked rows (a constraint cannot attach a partial index, so enforcement "
      + "lives on the index under the same name). A database recorded at the old "
      + "digest re-runs the current body: the classify finds no legacy rows (the "
      + "old precheck refused them), ADD COLUMN IF NOT EXISTS gains the marker, the "
      + "guarded DROP removes the old full constraint, and the concurrent build "
      + "recreates the guard in staged partial form — converging to the "
      + "fresh-install catalog. Reapply, not restamp: the revision adds the marker "
      + "column and the partiality, which a restamp would leave behind on "
      + "old-ledger databases.",
  },
  {
    filename: "generated/0293_stock_count_line_subject_unique.sql",
    from: "307683c85d8536bcdc3838b48fb02c3630d56820100138b95371d2a75e3ad726",
    to: "38eaf276d1a5f1994b06726a87d4b14d7c703c058967acf2752002368d60a099",
    strategy: "reapply",
    reason:
      "same staged revision as the entry above, for databases that recorded the "
      + "picked-then-superseded 307683c8 (partial index, marker column, no old "
      + "constraint): the guarded DROP finds nothing and the body replays "
      + "idempotently to the same catalog.",
  },
  {
    filename: "generated/0299_stock_count_line_counted_nonnegative.sql",
    from: "65a3e4fa4abaee059777ccaf198ea996c4d5b29064971d20765626a085fd0ab8",
    to: "e0806b314fcdeee02b1393f0e96cb51656c86520d5de5cdd9dba76feea6cadb7",
    strategy: "reapply",
    reason:
      "staged revision (U11) replaces the validated CHECK with ADD CONSTRAINT ... "
      + "NOT VALID plus a guarded VALIDATE that treats an already-validated guard "
      + "as done, and preserves pre-guard immutable history (U14): posted and "
      + "cancelled negatives are marked is_pre_guard_legacy (the column is added "
      + "by 0293, which runs first) and the CHECK exempts marked rows. A database "
      + "recorded at the old digest re-runs the current body: the classify finds "
      + "no legacy rows, the guarded DROP removes the old CHECK, and the ADD plus "
      + "VALIDATE recreate it in staged exempting form — converging to the "
      + "fresh-install catalog. Reapply, not restamp: the revision adds the "
      + "exemption the old CHECK lacks.",
  },
  {
    filename: "generated/0294_dunning_delivery_state_machine.sql",
    from: "d911b36ae7fc8eace336a44b4d45f4f32d7025e48d5e4ebaedfc9a6e0de213a9",
    to: "09a6e05f50536bb6d2c36bae7193548c8f713200f06b458c0463e69727e9078d",
    strategy: "restamp",
    reason:
      "staged revision (U12) replaces the validated CHECK with a guarded DROP "
      + "plus ADD CONSTRAINT ... NOT VALID and a guarded VALIDATE that treats an "
      + "already-validated guard as done. The new CHECK is a strict superset of "
      + "the old one, so every existing row already satisfies it. A database "
      + "recorded at the old digest applied the old validated guard successfully "
      + "and holds the identical end catalog — same name, same expression, "
      + "validated — so only the digest moves. Restamp, not reapply: the "
      + "revision stages the build but changes no enforced state.",
  },
  {
    filename: "generated/0301_item_price_schedule_versioning.sql",
    from: "e829a51ac2cc235bfa00408adb33ff55ecc7ff2c6fb0261c9aed8be7c3b7d5f8",
    to: "31b3e345c6a76b900e0a2d0fc51f59cae3f65f4c81b96fbab2638f56ba6ff668",
    strategy: "restamp",
    reason:
      "staged revision (U12): the two CHECKs and the self-referential foreign "
      + "key arrive NOT VALID with guarded VALIDATEs that treat "
      + "already-validated guards as done, instead of scanning the schedule "
      + "history under the ALTER TABLE lock. Existing rows start at revision 0 "
      + "with no predecessor and no reason, so none can violate the new guards. "
      + "A database recorded at the old digest holds the identical end catalog "
      + "— same names, expressions and references, validated — so only the "
      + "digest moves. Restamp, not reapply: the revision stages the build but "
      + "changes no enforced state.",
  },
  {
    filename: "generated/0327_item_price_level_activation_history.sql",
    from: "26606980c32021dae07ba3942fbe0bf955c6c10dae5e5f5985f84b19ce4049b2",
    to: "683a93ba8734ba3b472ce6dbdff1fe4a7fe1477c687b70a90a837b22129f5432",
    strategy: "reapply",
    reason:
      "corrective revisions (PRC15c, PRC15d, plus the Sol residual): revoking a "
      + "future-effective assignment before it starts kept its open window "
      + "while the resolver matches windows ignoring the flag, so a dead "
      + "future window would price when its dates arrive — the trigger now "
      + "removes it audited with the before-image. A same-day revoke keeps "
      + "the row and stamps revoked_at/revoked_by instead of deleting it: "
      + "the row may already have priced intraday transactions whose "
      + "recorded price basis points at it, and removing it destroyed that "
      + "lineage; the resolver treats the row as inactive for lookups at or "
      + "after the instant, and reactivation clears the stamp. Activation "
      + "periods record opened_at/closed_at instants for same-date evidence. "
      + "Same idempotence story as the PRC15c entry: IF NOT EXISTS DDL, "
      + "ADD-COLUMN-IF-NOT-EXISTS, CREATE OR REPLACE FUNCTION, DROP + "
      + "CREATE of the widened trigger, gap-only backfills. Reapply, not "
      + "restamp: enforced trigger behavior changes. For databases still at "
      + "the original digest; databases already at the PRC15c digest use "
      + "the next entry. Reapplying the current body from the original digest "
      + "also includes PRC15c's audited removal of same-day never-effective rows.",
  },
  {
    filename: "generated/0327_item_price_level_activation_history.sql",
    from: "74408c2026f5e84d304f1a1586dca7e7967222efd6cdb388f02ffd128f9552be",
    to: "683a93ba8734ba3b472ce6dbdff1fe4a7fe1477c687b70a90a837b22129f5432",
    strategy: "reapply",
    reason:
      "same revision as the entry above, for databases that already "
      + "reapplied the PRC15c revision: the delta from that state is the "
      + "future-start audited removal, the same-day keep-and-stamp with "
      + "revoked_at/revoked_by (instead of PRC15c's delete), the activation "
      + "period instants, and comments; the resolver asOf/backstop change is "
      + "a query, not stored state. Re-running converges half-revocations "
      + "the PRC15c revision left behind and redefines the trigger "
      + "idempotently. Reapply, not restamp.",
  },
  {
    filename: "generated/0327_item_price_level_activation_history.sql",
    from: "b70ecb046f73f2f4310cacfaa9f45075819466e09e73a85d2902db75a65c8eab",
    to: "683a93ba8734ba3b472ce6dbdff1fe4a7fe1477c687b70a90a837b22129f5432",
    strategy: "reapply",
    reason:
      "same revision as the two entries above, for databases that applied the "
      + "interim PRC15d body (b70ecb04, briefly on local main between the PRC15d "
      + "and residual commits and applied by the coordinator's and shards' test "
      + "databases): the residual replaced that body without a transition from it, "
      + "so those databases could not reach the current digest. The delta is the "
      + "keep-and-stamp revocation (revoked_at/revoked_by) and activation instants; "
      + "every statement is idempotent. Reapply, not restamp.",
  },
  {
    filename: "generated/0327_item_price_level_activation_history.sql",
    from: "696333297953bfffdf39879cd5618a585a10c5b85a8fa8ffb6e81bb0c7372091",
    to: "683a93ba8734ba3b472ce6dbdff1fe4a7fe1477c687b70a90a837b22129f5432",
    strategy: "reapply",
    reason:
      "the published 0a7e9d94 PRC15d revision added audited removal of "
      + "future-effective assignments and historical handling for inactive "
      + "rows. The current revision retains that behavior and adds the final "
      + "recorded-basis-safe same-day revocation and activation instants. Its "
      + "DDL, trigger replacement, and gap-only backfills are idempotent from "
      + "the PRC15d state. Reapply to reach the current published digest.",
  },
  {
    filename: "generated/0334_tenant_isolation_and_posting_guards.sql",
    from: "08c69798a164afcace78fbf2b18bc196f983de7ab0d8599f62a7b8d94c99a30f",
    to: "85e22004dcc3ea50eb5225e683c7e39de5335a65d7c004f02c4e4c0a3b55e7b7",
    strategy: "restamp",
    reason:
      "comment-only header correction on an unpublished migration: the 0334 "
      + "header described posting-guard and derived-summary sections that ship "
      + "separately in 0338, so the file overclaimed its own contents. No "
      + "statement changed — the applied RLS state is byte-identical before "
      + "and after. Restamp, not reapply: replaying the file would be a no-op "
      + "by construction (every statement tolerates re-execution), and only "
      + "the recorded identity moves.",
  },
  {
    filename: "generated/0338_posting_guards_and_summary_heals.sql",
    from: "c573c6091ee2be62e196c409db619bce6c693ef954602a84ad4261bf80d20599",
    to: "6dea34018b40dc9f2f3095000c3e8cc80f50b5239525b457c25944145c254f8c",
    strategy: "reapply",
    reason:
      "the published G9 revision (4be4bada) corrected the inactive-account "
      + "refusal remedy. The current body retains that function and includes the "
      + "subsequent G10-G13 guards, recompute trigger, catalog additions, and "
      + "queued-table promotion. Replaying against the G9 state is idempotent: "
      + "functions are replaced, triggers and constraints are guarded, and the "
      + "backfills only fill eligible NULL state. Reapply to converge the ledger "
      + "and catalog to the published migration.",
  },
  {
    filename: "generated/0338_posting_guards_and_summary_heals.sql",
    from: "2063e23ba8f1d68b1dc6d59e610c17247a094ae23f0d3ab361530990cfdc8d91",
    to: "6dea34018b40dc9f2f3095000c3e8cc80f50b5239525b457c25944145c254f8c",
    strategy: "reapply",
    reason:
      "the published G8 revision (d0e4e0b7) added posted-document INSERT "
      + "open-balance recomputation and healed NULL caches. The current body "
      + "retains G8 and adds G9-G13. Its DDL and trigger changes are guarded or "
      + "replaceable, and its NULL-only backfills converge from the G8 state; "
      + "reapply to install the later sections and current digest.",
  },
  {
    filename: "generated/0338_posting_guards_and_summary_heals.sql",
    from: "b3738d09a836ba824febc892bac3a081cb162b9a4fafe1561edbc28a17f9a1f0",
    to: "6dea34018b40dc9f2f3095000c3e8cc80f50b5239525b457c25944145c254f8c",
    strategy: "reapply",
    reason:
      "unshipped wave-G migration grows by section: the G4-only body gains "
      + "the wipe-fix (no raw sandbox_wipe GUC read), the G5 amend-delete "
      + "fence, the G6 book-rehome aggregate trigger, the G8 "
      + "open-balance INSERT trigger plus NULL-cache backfill, the G9 "
      + "inactive-account remedy message, the G10 line-edit recompute "
      + "trigger, the G11 payment-stats date-move trigger, the G12 catalog "
      + "additions, and the G13 promotion of the queued tables. Every statement is CREATE OR REPLACE / DROP ... IF EXISTS "
      + "+ CREATE or a NULL-guarded backfill, so reapply converges "
      + "idempotently. Reapply, not restamp: the body changed.",
  },
  {
    filename: "generated/0338_posting_guards_and_summary_heals.sql",
    from: "3d46141b8540f29d28d1905acad92a0d3478c6b0b7297e85e2b3654783a3ffab",
    to: "6dea34018b40dc9f2f3095000c3e8cc80f50b5239525b457c25944145c254f8c",
    strategy: "reapply",
    reason:
      "same growth as the entry above, for databases that applied the "
      + "G4+G5 body: the delta is the wipe-fix, the G6 book-rehome "
      + "aggregate trigger, the G8 open-balance section, the G9 remedy "
      + "message, the G10 line-edit recompute trigger, the G11 payment-stats "
      + "date-move trigger, the G12 catalog additions, and the G13 promotion "
      + "of the queued tables, all idempotent on replay. Reapply, not restamp.",
  },
  {
    filename: "generated/0338_posting_guards_and_summary_heals.sql",
    from: "8a941cc3890f3159392c37dd7c94848d2fa3b7b60df9bf7684cc075fa6fa50d4",
    to: "6dea34018b40dc9f2f3095000c3e8cc80f50b5239525b457c25944145c254f8c",
    strategy: "reapply",
    reason:
      "same growth as the entries above, for databases that applied the "
      + "wipe-corrected G4+G5 body: the delta is the G6 book-rehome "
      + "aggregate trigger, the G8 open-balance section, the G9 remedy "
      + "message, the G10 line-edit recompute trigger, the G11 payment-stats "
      + "date-move trigger, the G12 catalog additions, and the G13 promotion "
      + "of the queued tables, all idempotent on replay. Reapply, not restamp.",
  },
  {
    filename: "generated/0338_posting_guards_and_summary_heals.sql",
    from: "d91d0842bd8c0741eddb06ec4e16969bc216a79f0b2fc7fa3cb5a1a85aa2024e",
    to: "6dea34018b40dc9f2f3095000c3e8cc80f50b5239525b457c25944145c254f8c",
    strategy: "reapply",
    reason:
      "same growth as the entries above, for databases at the published "
      + "G4+G5+G6 body: the delta is the G8 open-balance section, the G9 "
      + "remedy message, the G10 line-edit recompute trigger, the G11 "
      + "payment-stats date-move trigger, the G12 catalog additions, and the "
      + "G13 promotion of the queued tables, all idempotent on replay. "
      + "Reapply, not restamp.",
  },
  {
    filename: "generated/0338_posting_guards_and_summary_heals.sql",
    from: "65ec1f847284c54e4ff51d8cfad926a89cfdeecc94c467d2ae83f1c9d8f1bd31",
    to: "6dea34018b40dc9f2f3095000c3e8cc80f50b5239525b457c25944145c254f8c",
    strategy: "reapply",
    reason:
      "same growth as the entries above, for databases at the merged "
      + "G4+G5+G6+G8+G9+G10 body: the delta is only the G11 payment-stats "
      + "date-move trigger (plus the delta-function date overrides), the G12 "
      + "catalog additions, and the G13 promotion of the queued tables, all "
      + "idempotent on replay. Reapply, not restamp.",
  },
  {
    filename: "generated/0338_posting_guards_and_summary_heals.sql",
    from: "05bc89024bb2d2a614e14b7fb564d505600c7a026a648c7acac59af23b17aa6c",
    to: "6dea34018b40dc9f2f3095000c3e8cc80f50b5239525b457c25944145c254f8c",
    strategy: "reapply",
    reason:
      "same growth as the entries above, for databases at the branch "
      + "G4+G5+G6+G8+G9+G10+G11 body: the delta is only the G12 catalog "
      + "additions (safe_relations array, one curated view, refresh), and the "
      + "G13 promotion of the queued tables, all idempotent on replay. "
      + "Reapply, not restamp.",
  },
  {
    filename: "generated/0338_posting_guards_and_summary_heals.sql",
    from: "1c2ea84ecdd366d6cb9deef2067de17114e2451ba80f7edc5b210f5b4f8c3d05",
    to: "6dea34018b40dc9f2f3095000c3e8cc80f50b5239525b457c25944145c254f8c",
    strategy: "reapply",
    reason:
      "same growth as the entries above, for databases at the branch "
      + "G12 body: the delta is only the G13 promotion of the queued "
      + "tables into safe_relations plus refresh, all idempotent on "
      + "replay. Reapply, not restamp.",
  },
  {
    filename: "generated/0374_pay_stub_employment_required.sql",
    from: "957f3a84dd6145b5689f69ed1ec184697f5a5d2b387916de5e3e3630f7e94b75",
    to: "89cd4e08d445e962a52ac9cb2d4dbf284c67c97c9ccd16c624994b9875e485c1",
    strategy: "reapply",
    reason:
      "the published I3-people-61 revision (ec1e01df0) reconstructed "
      + "employment_id from existing HR history and left unresolvable legacy "
      + "nulls to the preflight refusal. The current revision retains that "
      + "reconstruction and first backfills one open employment per (worker, "
      + "pay-run legal entity) key that holds no employments at all, "
      + "effective from the earliest stub pay date. The runner records a "
      + "digest with its body's transaction, so a ledger recorded at the old "
      + "digest completed the old body: no NULL employment_id remains, the "
      + "backfill selects no keys, the provenance inserts select from empty "
      + "sets, the reconstruction updates zero rows, and SET NOT NULL on an "
      + "already-constrained column is a no-op. Reapply, not restamp: the "
      + "body changed.",
  },
  {
    filename: "generated/0257_provisional_cost_subsidiary.sql",
    from: "ecd2626b775e72025ce26251643930f1bf676ec06fcfae4f1605d35374c734f3",
    to: "67256fd8450973ff88a2592c4d0bb834547499da41e9410ff96a43a3eb1583fa",
    strategy: "restamp",
    reason:
      "staged revision declares no-transaction, builds both lookup indexes "
      + "CONCURRENTLY behind an INVALID-drop guard, and arrives both foreign "
      + "keys NOT VALID with separate guarded VALIDATEs, instead of scanning "
      + "inventory_provisional_costs under write-blocking locks. An install "
      + "recorded at the old digest holds the identical end catalog — same "
      + "index names and definitions, same foreign-key names and references, "
      + "validated — so only the digest moves. Restamp, not reapply: the "
      + "revision stages the build but changes no enforced state.",
  },
  {
    filename: "generated/0328_obligation_legacy_reconciliation.sql",
    from: "1c526dc25a2edb8aa2ec2da422bcf11b6eef00cba2021994359e5e512a3a0d0f",
    to: "4ef841e91a1c3ec9c0609c93a677f562b0e5b44c601ad549a553b4efb8715703",
    strategy: "restamp",
    reason:
      "staged revision replaces the validated CHECK with a guarded ADD "
      + "CONSTRAINT ... NOT VALID plus a guarded VALIDATE that treats an "
      + "already-validated guard as done, instead of scanning every "
      + "performance_obligations row under the ALTER TABLE lock. The three "
      + "columns are added by this same migration, so every pre-existing row "
      + "trivially holds all three NULLs and satisfies the shape. A database "
      + "recorded at the old digest holds the identical end catalog — same "
      + "name, same expression, validated — so only the digest moves. "
      + "Restamp, not reapply: the revision stages the build but changes no "
      + "enforced state.",
  },
];

import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import {
  publishProjectFinancialProfileInTransaction,
  type PublishProjectFinancialProfileInput,
} from "../project-financial-profile-versions.ts";
import type { FinancialProfile } from "@openbooks/schema";

const ROLLBACK = Symbol("expected validation rollback");

async function expectDatabaseRejection(
  tx: { execute: (query: any) => Promise<any> },
  name: string,
  query: any,
): Promise<void> {
  await tx.execute(sql.raw(`savepoint ${name}`));
  let rejected = false;
  try {
    await tx.execute(query);
  } catch {
    rejected = true;
    await tx.execute(sql.raw(`rollback to savepoint ${name}`));
  }
  if (!rejected) throw new Error(`${name} was not rejected by the database`);
}

async function main(): Promise<void> {
  const population = (await db.execute(sql`
    select
      (select count(*)::int from project_types) as project_types,
      (select count(*)::int from project_financial_profile_versions) as versions,
      (
        select count(*)::int
          from project_types pt
         where not exists (
           select 1
             from project_financial_profile_versions v
            where v.org_id = pt.org_id and v.project_type_id = pt.id
         )
      ) as missing_versions,
      (
        select count(*)::int
          from project_financial_profile_versions a
          join project_financial_profile_versions b
            on b.org_id = a.org_id
           and b.project_type_id = a.project_type_id
           and b.id > a.id
           and daterange(a.effective_from, a.effective_to, '[]')
               && daterange(b.effective_from, b.effective_to, '[]')
      ) as overlaps,
      (
        select count(*)::int
          from (
            select effective_to,
                   lead(effective_from) over (
                     partition by org_id, project_type_id order by effective_from
                   ) as next_from
              from project_financial_profile_versions
          ) ranges
         where next_from is not null
           and effective_to <> next_from - 1
      ) as gaps,
      (
        select count(*)::int
          from project_types pt
         where (
           select count(*)
             from project_financial_profile_versions v
            where v.org_id = pt.org_id
              and v.project_type_id = pt.id
              and v.effective_from <= current_date
              and (v.effective_to is null or v.effective_to >= current_date)
         ) <> 1
      ) as unresolved_current
  `)) as unknown as {
    rows: {
      project_types: number;
      versions: number;
      missing_versions: number;
      overlaps: number;
      gaps: number;
      unresolved_current: number;
    }[];
  };
  const counts = population.rows[0]!;
  for (const key of [
    "missing_versions",
    "overlaps",
    "gaps",
    "unresolved_current",
  ] as const) {
    if (counts[key] !== 0) throw new Error(`${key}: ${counts[key]}`);
  }

  const candidate = (await db.execute(sql`
    select pt.org_id, pt.id, v.financial_profile
      from project_types pt
      join project_financial_profile_versions v
        on v.org_id = pt.org_id
       and v.project_type_id = pt.id
       and v.effective_from <= current_date
       and (v.effective_to is null or v.effective_to >= current_date)
     where not exists (
       select 1
         from project_financial_profile_versions future
        where future.project_type_id = pt.id
          and future.effective_from = date '9999-01-01'
     )
     order by pt.org_id, pt.id
     limit 1
  `)) as unknown as {
    rows: {
      org_id: string;
      id: string;
      financial_profile: FinancialProfile;
    }[];
  };
  const type = candidate.rows[0];
  if (!type) throw new Error("no project type available for rollback exercise");

  try {
    await db.transaction(async (tx) => {
      await expectDatabaseRejection(
        tx,
        "legacy_profile_guard",
        sql`
          update project_types
             set financial_profile =
                   jsonb_set(financial_profile, '{__validationProbe}', 'true')
           where org_id = ${type.org_id} and id = ${type.id}
        `,
      );
      await expectDatabaseRejection(
        tx,
        "version_mutation_guard",
        sql`
          update project_financial_profile_versions
             set financial_profile =
                   jsonb_set(financial_profile, '{__validationProbe}', 'true')
           where org_id = ${type.org_id}
             and project_type_id = ${type.id}
             and effective_from <= current_date
             and (effective_to is null or effective_to >= current_date)
        `,
      );
      await expectDatabaseRejection(
        tx,
        "version_delete_guard",
        sql`
          delete from project_financial_profile_versions
           where org_id = ${type.org_id}
             and project_type_id = ${type.id}
             and effective_from <= current_date
             and (effective_to is null or effective_to >= current_date)
        `,
      );

      const input: PublishProjectFinancialProfileInput = {
        orgId: type.org_id,
        projectTypeId: type.id,
        effectiveFrom: "9999-01-01",
        financialProfile: type.financial_profile,
        reason: "Rollback-only effective-date publication validation",
        actorId: null,
      };
      const published = await publishProjectFinancialProfileInTransaction(tx, input);
      const evidence = (await tx.execute(sql`
        select
          exists (
            select 1
              from project_financial_profile_versions
             where id = ${published.id}
               and effective_from = date '9999-01-01'
          ) as version_exists,
          exists (
            select 1
              from audit_log
             where table_name = 'project_financial_profile_versions'
               and row_id = ${published.id}
               and action = 'insert'
          ) as audit_exists
      `)) as unknown as {
        rows: { version_exists: boolean; audit_exists: boolean }[];
      };
      if (!evidence.rows[0]?.version_exists || !evidence.rows[0]?.audit_exists) {
        throw new Error("controlled publication did not produce version and audit evidence");
      }
      throw ROLLBACK;
    });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }

  const persistedProbe = (await db.execute(sql`
    select count(*)::int as n
      from project_financial_profile_versions
     where org_id = ${type.org_id}
       and project_type_id = ${type.id}
       and effective_from = date '9999-01-01'
  `)) as unknown as { rows: { n: number }[] };
  if (persistedProbe.rows[0]?.n !== 0) {
    throw new Error("rollback-only validation version persisted");
  }

  console.log(
    JSON.stringify(
      {
        status: "exact",
        ...counts,
        rollbackExercise: {
          legacySeedMutationRejected: true,
          publishedVersionMutationRejected: true,
          publishedVersionDeleteRejected: true,
          controlledPublishAudited: true,
          persistedRows: 0,
        },
      },
      null,
      2,
    ),
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });

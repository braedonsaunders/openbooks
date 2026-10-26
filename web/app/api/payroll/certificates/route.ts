import { uuidId } from "@/lib/api/json-schema";
import { prepareWithholdingRecordWrite } from "@openbooks/engine/payroll/withholding";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db, withOrgTransaction } from "@openbooks/engine/platform/db";
import { businessToday, isIsoCalendarDate } from "@openbooks/engine/platform/business-date/module";
import { normalizeDecimal } from "@openbooks/engine/money/money";
import { PAYROLL_COUNTRY_PACKS } from "@openbooks/engine/payroll/packs";
import {
  certificateAnswersProblem,
  packCertificates,
  payrollCertificate,
} from "@openbooks/engine/payroll/certificates";
import { guardSubsidiaryScope } from "../../../../lib/authz";
import { isUuid } from "../../../../lib/list-params";
import { notFound } from "@/lib/api/responses";

export const dynamic = "force-dynamic";

/**
 * Employee tax certificates — the pack-declared forms an employee files to
 * set their own withholding (or the employer-collected facts the pack prices
 * from), stored as rows in `employee_tax_certificates`.
 *
 * Every pack declares its certificates with typed fields
 * (engine/src/payroll/certificates.ts); this surface renders and validates
 * whatever the declarations admit and NOTHING else. No country, form number
 * or field key appears below: adding a certificate to a pack offers it here
 * with no edit, and an answer for a field the pack does not declare is
 * refused rather than stored where no engine reads it.
 *
 * Column-backed certificates (the pre-model W-4/TD1 family) are NOT served
 * here — they are edited through the payroll profile, which owns their
 * columns. Only `certificate_rows` certificates are listed and accepted.
 */

const certificateBodySchema = z.strictObject({
  employeePartyId: uuidId,
  country: z.string().min(1),
  certificateKey: z.string().trim().min(1),
  region: z.string().nullable().optional(),
  subRegion: z.string().nullable().optional(),
  answers: z.record(z.string().min(1), z.string()),
  effectiveFrom: z
    .string()
    .refine(
      (date) => date === "" || isIsoCalendarDate(date),
      "effectiveFrom must be a real ISO calendar date (YYYY-MM-DD)",
    )
    .nullable()
    .optional(),
});

const correctionSchema = z.strictObject({
  id: uuidId,
  effectiveFrom: z
    .string()
    .refine(
      (date) => isIsoCalendarDate(date),
      "effectiveFrom must be a real ISO calendar date (YYYY-MM-DD)",
    ),
  reason: z.string().trim().min(1).max(2000),
});

const voidSchema = z.strictObject({
  id: uuidId,
  reason: z.string().trim().min(1).max(2000),
});

type FiledRow = {
  id: string;
  employee_party_id: string;
  certificate_key: string;
  country: string;
  region: string | null;
  sub_region: string | null;
  answers: Record<string, string>;
  effective_from: string | null;
  superseded_on: string | null;
};

async function committedStubInRange(
  orgId: string,
  employeePartyId: string,
  fromInclusive: string,
  toExclusive: string,
): Promise<string | null> {
  const posted = (
    await db.execute<{ pay_date: string }>(
      sql`
    select r.pay_date::text as pay_date from pay_runs r
      join pay_stubs s on s.org_id = r.org_id and s.pay_run_document_id = r.document_id
      join documents d on d.org_id = r.org_id and d.id = r.document_id
     where r.org_id = ${orgId} and s.employee_party_id = ${employeePartyId}
       and r.run_status = 'committed' and d.status <> 'voided'
       and r.pay_date >= ${fromInclusive}::date and r.pay_date < ${toExclusive}::date
     order by r.pay_date limit 1`,
      "objects",
    )
  )[0];
  return posted?.pay_date ?? null;
}

// A type alias, not an interface: db.execute constrains its row generic to
// Record<string, unknown>, and an interface carries no implicit index
// signature, so only the alias satisfies it.
type StoredRow = {
  id: string;
  certificate_key: string;
  country: string;
  region: string | null;
  sub_region: string | null;
  answers: Record<string, string>;
  effective_from: string | null;
  superseded_on: string | null;
  created_at: string;
  created_by: string | null;
  created_by_name: string | null;
  updated_at: string;
  updated_by: string | null;
  updated_by_name: string | null;
};

async function employeeSubsidiaryId(orgId: string, employee: string) {
  const rows = await db.execute<{ subsidiaryId: string | null }>(
    sql`
    select subsidiary_id as "subsidiaryId" from parties
     where org_id = ${orgId} and id = ${employee}`,
    "objects",
  );
  return rows.length === 1 ? rows[0]!.subsidiaryId : undefined;
}

export const GET = defineRoute({
  permission: "payroll.manage",
  feature: "payroll",
  handler: async ({ request: req, authz: gate }) => {
    const employee = new URL(req.url).searchParams.get("employee");
    if (!employee || !isUuid(employee))
      return NextResponse.json({ error: "invalid employee" }, { status: 422 });
    const subsidiaryId = await employeeSubsidiaryId(gate.user.orgId, employee);
    if (subsidiaryId === undefined) return notFound("record");
    const denied = guardSubsidiaryScope(gate, subsidiaryId);
    if (denied) return denied;

    // Row-backed declarations per pack: the forms this surface may store
    // answers for. Column-backed certificates stay on the profile editor.
    const declarations: Record<string, ReturnType<typeof packCertificates>> = {};
    for (const country of Object.keys(PAYROLL_COUNTRY_PACKS)) {
      const declared = packCertificates(country);
      declarations[country] = {
        country: declared.country,
        certificates: declared.certificates.filter(
          (certificate) => certificate.storage === "certificate_rows",
        ),
      };
    }
    const stored = await db.execute<StoredRow>(
      sql`
      select c.id::text as id, c.certificate_key, c.country, c.region, c.sub_region, c.answers,
             c.effective_from::text as effective_from, c.superseded_on::text as superseded_on,
             c.created_at::text as created_at, c.created_by::text as created_by,
             cb.name as created_by_name,
             c.updated_at::text as updated_at, c.updated_by::text as updated_by,
             ub.name as updated_by_name
        from employee_tax_certificates c
        left join users cb on cb.id = c.created_by and cb.org_id = c.org_id
        left join users ub on ub.id = c.updated_by and ub.org_id = c.org_id
       where c.org_id = ${gate.user.orgId} and c.employee_party_id = ${employee}
       order by c.certificate_key, coalesce(c.region, ''), coalesce(c.sub_region, ''),
                c.effective_from nulls first`,
      "objects",
    );
    // The employment start the certificate form defaults its effective date
    // to: the hire date on the employee role, so a converting org files the
    // certificate as of when the employment began rather than today.
    const employmentStart =
      (
        await db.execute<{ hired_on: string | null }>(
          sql`
      select min(hired_on)::text as hired_on from employee_roles
       where org_id = ${gate.user.orgId} and party_id = ${employee}`,
          "objects",
        )
      )[0]?.hired_on ?? null;
    return NextResponse.json({
      countries: Object.keys(PAYROLL_COUNTRY_PACKS),
      declarations,
      stored,
      employmentStart,
      today: await businessToday(gate.user.orgId),
    });
  },
});

export const POST = defineRoute({
  permission: "payroll.manage",
  feature: "payroll",
  body: certificateBodySchema,
  invalidBodyStatus: 422,
  handler: async ({ authz: gate, body }) => {
    const orgId = gate.user.orgId;
    const userId = gate.user.id;

    const subsidiaryId = await employeeSubsidiaryId(orgId, body.employeePartyId);
    if (subsidiaryId === undefined) {
      return NextResponse.json(
        {
          error: `no employee "${body.employeePartyId}" in this organization — create the employee record before filing a certificate`,
        },
        { status: 422 },
      );
    }
    const denied = guardSubsidiaryScope(gate, subsidiaryId);
    if (denied) return denied;

    // The pack registry is the only validator for the country and the form.
    const country = body.country;
    if (!(country in PAYROLL_COUNTRY_PACKS)) {
      return NextResponse.json({ error: "unknown payroll country pack" }, { status: 422 });
    }
    let certificate;
    try {
      certificate = payrollCertificate(country, body.certificateKey);
    } catch {
      return NextResponse.json(
        { error: `unknown certificate "${String(body.certificateKey ?? "")}" for ${country}` },
        { status: 422 },
      );
    }
    if (certificate.storage !== "certificate_rows") {
      return NextResponse.json(
        {
          error: `certificate "${certificate.key}" is edited through the payroll profile, not here`,
        },
        { status: 422 },
      );
    }
    // The stored jurisdiction point must be the certificate's own scope: a
    // country-level form carries no region, a region-level form carries its
    // region, a sub-region form carries both. Anything else would fork "which
    // certificate is in force" into ambiguous rows.
    // Omitting the point means "the certificate's own" — the declaration already
    // says where a region-scoped form files, so a caller that does not repeat it
    // is not thereby wrong. Sending a CONFLICTING point still refuses below.
    const region =
      body.region === undefined
        ? (certificate.scope.region ?? null)
        : body.region === null || body.region === ""
          ? null
          : String(body.region);
    const subRegion =
      body.subRegion === undefined
        ? (certificate.scope.subRegion ?? null)
        : body.subRegion === null || body.subRegion === ""
          ? null
          : String(body.subRegion);
    const { level } = certificate.scope;
    if (level === "country" && (region !== null || subRegion !== null)) {
      return NextResponse.json(
        { error: `certificate "${certificate.key}" is country-level and carries no region` },
        { status: 422 },
      );
    }
    if (level === "region" && (region !== certificate.scope.region || subRegion !== null)) {
      return NextResponse.json(
        {
          error: `certificate "${certificate.key}" is filed for region "${certificate.scope.region ?? ""}"`,
        },
        { status: 422 },
      );
    }
    if (
      level === "sub_region" &&
      (region !== certificate.scope.region || subRegion !== certificate.scope.subRegion)
    ) {
      return NextResponse.json(
        {
          error: `certificate "${certificate.key}" is filed for "${certificate.scope.region ?? ""}/${certificate.scope.subRegion ?? ""}"`,
        },
        { status: 422 },
      );
    }

    const effectiveFrom = body.effectiveFrom || null;

    // Canonicalize before validating: empty answers are "unanswered" (the
    // reader falls back to the declared default), so they are dropped rather
    // than stored as empty strings beside real answers.
    const answers: Record<string, string> = {};
    for (const [key, value] of Object.entries(body.answers)) {
      const text = value.trim();
      if (text === "") continue;
      answers[key] = text;
    }
    // The scope check reads the employee's OWN profile, not just the body: a
    // region-scoped certificate files only for an employee of that region, and a
    // pack's form files only for an employee under that pack. Without this, a New
    // York certificate could be filed against a California employee and withhold
    // by the wrong state's table. The declared scope is the authority — the key's
    // name is never parsed.
    const profile = (
      await db.execute<{ country: string; province: string }>(
        sql`
      select country, province from employee_payroll_profiles
       where org_id = ${orgId} and employee_party_id = ${body.employeePartyId}`,
        "objects",
      )
    )[0];
    if (!profile) {
      return NextResponse.json(
        {
          error:
            "no payroll profile for this employee — save the profile before filing a certificate",
        },
        { status: 422 },
      );
    }
    if (profile.country !== country) {
      return NextResponse.json(
        {
          error:
            `"${certificate.key}" belongs to the ${country} payroll pack but this employee's ` +
            `profile is under ${profile.country} — file the certificate the employee's own pack declares`,
        },
        { status: 422 },
      );
    }
    if (certificate.scope.level !== "country" && profile.province !== region) {
      return NextResponse.json(
        {
          error:
            `"${certificate.key}" is scoped to ${region ?? "(unscoped)"} but this employee works in ` +
            `${profile.province || "(no region)"} — a certificate files only for its own region`,
        },
        { status: 422 },
      );
    }

    // A filing that answers NOTHING is refused outright. Where every required
    // field carries a declared default, nothing below would object — and the
    // stored row would then read as "on file" downstream while asserting
    // nothing, which is worse than no certificate at all.
    if (Object.keys(answers).length === 0) {
      return NextResponse.json(
        {
          error: `"${certificate.key}" was filed with no answers — a certificate on file must state something`,
        },
        { status: 422 },
      );
    }

    const problem = certificateAnswersProblem(certificate, answers);
    if (problem) return NextResponse.json({ error: problem }, { status: 422 });

    // Store amounts AT THE DECLARED SCALE. "25.5" and "25.5000" are the same
    // answer, and leaving whichever the operator typed makes two stored rows
    // that must compare equal look different to anything reading them back.
    // Validation above already proved each one normalizes.
    for (const field of certificate.fields) {
      if (field.kind !== "amount" || field.decimals == null) continue;
      const answer = answers[field.key];
      if (answer === undefined) continue;
      answers[field.key] = normalizeDecimal(answer, field.decimals);
    }

    return withOrgTransaction(orgId, async () => {
      const effective = effectiveFrom ?? (await businessToday(orgId));
      await prepareWithholdingRecordWrite({
        orgId,
        actorId: userId,
        employeePartyId: body.employeePartyId,
        effectiveFrom: effective,
        protectCommittedHistory: certificate.protectCommittedHistory ?? false,
      });
      // Lock the stable parent before reading current certificates. On a first
      // filing there is no certificate row for FOR UPDATE to lock, so locking
      // only the open rows lets two transactions both decide to insert a
      // current row. The payroll profile exists for every eligible employee and
      // serializes certificate filings for that employee, including first ones.
      const profileLock = await db.execute<{ employee_party_id: string }>(
        sql`
        select employee_party_id from employee_payroll_profiles
         where org_id = ${orgId} and employee_party_id = ${body.employeePartyId}
         for update`,
        "objects",
      );
      if (profileLock.length !== 1) {
        return NextResponse.json(
          {
            error:
              "no payroll profile for this employee — save the profile before filing a certificate",
          },
          { status: 422 },
        );
      }
      const filed = await db.execute<{
        id: string;
        effective_from: string | null;
        superseded_on: string | null;
      }>(
        sql`
        select id, effective_from::text as effective_from, superseded_on::text as superseded_on
          from employee_tax_certificates
         where org_id = ${orgId} and employee_party_id = ${body.employeePartyId}
           and certificate_key = ${certificate.key}
           and coalesce(region, '') = coalesce(${region}, '')
           and coalesce(sub_region, '') = coalesce(${subRegion}, '')
         for update`,
        "objects",
      );
      // Effective-dated history: a filing takes the interval
      // [effective, next filing) where the next filing is the earliest row
      // already starting after it. A back-filled EARLIER certificate closes at
      // the later filing's start and leaves that filing open, so an earlier
      // pay run reads the earlier answers and a later run reads the later
      // ones. Only an OVERLAP with closed history is refused — the covering
      // filing stays authoritative until it is voided or corrected, never
      // silently rewritten.
      // A new certificate takes effect on the org's business day, never the UTC
      // day (which is tomorrow in the evening for the Americas).
      let effectiveTo: string | null = null;
      for (const row of filed) {
        if (row.effective_from !== null && row.effective_from > effective) {
          if (effectiveTo === null || row.effective_from < effectiveTo)
            effectiveTo = row.effective_from;
        }
      }
      for (const row of filed) {
        if (row.superseded_on === null) continue;
        const startsBeforeEnd =
          row.effective_from === null || effectiveTo === null || row.effective_from < effectiveTo;
        if (startsBeforeEnd && row.superseded_on > effective) {
          const span = `${row.effective_from ?? "(undated)"} through ${row.superseded_on}`;
          return NextResponse.json(
            {
              error: `a "${certificate.key}" filing (effective ${span}) already covers ${effective}`,
              remedy:
                "void or correct the covering filing, or file with an effective date outside " +
                `${row.effective_from ?? "its start"}–${row.superseded_on}`,
            },
            { status: 422 },
          );
        }
      }
      const predecessors = filed.filter(
        (row) =>
          row.superseded_on === null &&
          (row.effective_from === null || row.effective_from <= effective),
      );
      await db.execute(sql`
        update employee_tax_certificates
           set superseded_on = ${effective}::date, updated_by = ${userId}, updated_at = clock_timestamp()
         where org_id = ${orgId} and employee_party_id = ${body.employeePartyId}
           and certificate_key = ${certificate.key}
           and coalesce(region, '') = coalesce(${region}, '')
           and coalesce(sub_region, '') = coalesce(${subRegion}, '')
           and superseded_on is null
           and (effective_from is null or effective_from <= ${effective}::date)`);
      const inserted = (
        await db.execute<{ id: string }>(
          sql`
        insert into employee_tax_certificates
          (org_id, employee_party_id, country, certificate_key, region, sub_region,
           answers, effective_from, superseded_on, created_by, updated_by)
        values (${orgId}, ${body.employeePartyId}, ${country}, ${certificate.key},
                ${region}, ${subRegion}, ${JSON.stringify(answers)}::jsonb,
                ${effective}::date, ${effectiveTo}::date, ${userId}, ${userId})
        returning id`,
          "objects",
        )
      )[0]!;
      await db.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id, at)
        values (${orgId}, 'employee_tax_certificates', ${inserted.id}, 'insert',
          ${JSON.stringify({
            after: {
              certificate_key: certificate.key,
              country,
              region,
              sub_region: subRegion,
              answers,
              effective_from: effective,
              effective_to: effectiveTo,
              superseded: predecessors.map((row) => row.id),
            },
          })}::jsonb,
          ${userId}, ${req.headers.get("X-Request-Id")}, clock_timestamp())`);
      return NextResponse.json({
        ok: true,
        certificateKey: certificate.key,
        effectiveFrom: effective,
        effectiveTo,
      });
    });
  },
});

/**
 * Correct a filing's effective date. The row stays on file — history is never
 * rewritten — but only while it is UNUSED: no committed pay stub may fall in
 * the row's current interval or the corrected one, and the corrected interval
 * must not overlap another filing's. Every correction carries a reason into
 * the audit trail.
 */
export const PATCH = defineRoute({
  permission: "payroll.manage",
  feature: "payroll",
  body: correctionSchema,
  invalidBodyStatus: 422,
  handler: async ({ request: req, authz: gate, body }) => {
    const orgId = gate.user.orgId;
    const userId = gate.user.id;

    return withOrgTransaction(orgId, async () => {
      // Read unlocked first: the employee is needed for the scope guard, and
      // the profile lock below must come before any row lock — the POST path
      // locks parent-then-row, and inverting that order deadlocks.
      const unloaded = (
        await db.execute<FiledRow>(
          sql`
        select id::text as id, employee_party_id::text as employee_party_id, certificate_key, country,
               region, sub_region, answers,
               effective_from::text as effective_from, superseded_on::text as superseded_on
          from employee_tax_certificates
         where org_id = ${orgId} and id = ${body.id}`,
          "objects",
        )
      )[0];
      if (!unloaded) return notFound("record");
      const subsidiaryId = await employeeSubsidiaryId(orgId, unloaded.employee_party_id);
      if (subsidiaryId === undefined) return notFound("record");
      const denied = guardSubsidiaryScope(gate, subsidiaryId);
      if (denied) return denied;
      if (unloaded.effective_from === body.effectiveFrom) {
        return NextResponse.json({
          ok: true,
          id: unloaded.id,
          effectiveFrom: unloaded.effective_from,
          unchanged: true,
        });
      }
      if (unloaded.superseded_on !== null && body.effectiveFrom >= unloaded.superseded_on) {
        return NextResponse.json(
          {
            error: `this "${unloaded.certificate_key}" filing closed on ${unloaded.superseded_on} — a corrected date must be before that`,
            remedy: "choose a date inside its interval, or file a new certificate instead",
          },
          { status: 422 },
        );
      }
      // Lock the stable parent before the row, exactly like the POST path, so
      // concurrent filings and corrections for this employee serialize.
      const profileLock = await db.execute<{ employee_party_id: string }>(
        sql`
        select employee_party_id from employee_payroll_profiles
         where org_id = ${orgId} and employee_party_id = ${unloaded.employee_party_id}
         for update`,
        "objects",
      );
      if (profileLock.length !== 1) {
        return NextResponse.json(
          {
            error:
              "no payroll profile for this employee — save the profile before correcting a certificate",
          },
          { status: 422 },
        );
      }
      const row = (
        await db.execute<FiledRow>(
          sql`
        select id::text as id, employee_party_id::text as employee_party_id, certificate_key, country,
               region, sub_region, answers,
               effective_from::text as effective_from, superseded_on::text as superseded_on
          from employee_tax_certificates
         where org_id = ${orgId} and id = ${body.id}
         for update`,
          "objects",
        )
      )[0];
      if (!row) return notFound("record");
      // The corrected interval, computed exactly like a filing: [new date,
      // next filing), keeping the row's own close when it is earlier.
      const siblings = await db.execute<{
        effective_from: string | null;
        superseded_on: string | null;
      }>(
        sql`
        select effective_from::text as effective_from, superseded_on::text as superseded_on
          from employee_tax_certificates
         where org_id = ${orgId} and employee_party_id = ${row.employee_party_id}
           and certificate_key = ${row.certificate_key}
           and coalesce(region, '') = coalesce(${row.region}, '')
           and coalesce(sub_region, '') = coalesce(${row.sub_region}, '')
           and id <> ${row.id}`,
        "objects",
      );
      let end: string | null = row.superseded_on;
      for (const sibling of siblings) {
        if (
          sibling.effective_from !== null &&
          sibling.effective_from > body.effectiveFrom &&
          (end === null || sibling.effective_from < end)
        ) {
          end = sibling.effective_from;
        }
      }
      const endText = end ?? "9999-12-31";
      for (const sibling of siblings) {
        const siblingEnd = sibling.superseded_on ?? "9999-12-31";
        // An open successor starts at or after the corrected interval's end
        // by construction, so it never trips this: only a true overlap does.
        if (
          (sibling.effective_from === null || sibling.effective_from < endText) &&
          siblingEnd > body.effectiveFrom
        ) {
          const span =
            sibling.superseded_on === null
              ? `(effective ${sibling.effective_from}) is already on file for ${body.effectiveFrom}`
              : `(effective ${sibling.effective_from ?? "(undated)"} through ${sibling.superseded_on}) already covers ${body.effectiveFrom}`;
          return NextResponse.json(
            {
              error: `a "${row.certificate_key}" filing ${span}`,
              remedy:
                "void or correct the covering filing first, or choose a date it does not cover",
            },
            { status: 422 },
          );
        }
      }
      // Unused means no committed stub read this row's answers: neither in
      // its current interval nor in the corrected one.
      const used =
        (await committedStubInRange(
          orgId,
          row.employee_party_id,
          row.effective_from ?? "0001-01-01",
          row.superseded_on ?? "9999-12-31",
        )) ??
        (await committedStubInRange(orgId, row.employee_party_id, body.effectiveFrom, endText));
      if (used) {
        return NextResponse.json(
          {
            error: `payroll dated ${used} was committed on this filing's answers — history is immutable`,
            remedy: "leave this filing and file a new certificate for the corrected date instead",
          },
          { status: 422 },
        );
      }
      await db.execute(sql`
        update employee_tax_certificates
           set effective_from = ${body.effectiveFrom}::date, superseded_on = ${end}::date,
               updated_by = ${userId}, updated_at = clock_timestamp()
         where org_id = ${orgId} and id = ${row.id}`);
      await db.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id, at)
        values (${orgId}, 'employee_tax_certificates', ${row.id}, 'update',
          ${JSON.stringify({
            kind: "certificate_correction",
            before: { effective_from: row.effective_from, superseded_on: row.superseded_on },
            after: { effective_from: body.effectiveFrom, superseded_on: end },
            reason: body.reason,
          })}::jsonb,
          ${userId}, ${req.headers.get("X-Request-Id")}, clock_timestamp())`);
      return NextResponse.json({
        ok: true,
        id: row.id,
        effectiveFrom: body.effectiveFrom,
        effectiveTo: end,
      });
    });
  },
});

/**
 * Void an open filing with a reason. The row stays on file with its answers
 * intact — prior-period re-runs still read it — but it stops being current as
 * of the org's business day (or its own start, for a future-dated filing).
 * A closed filing has nothing to void; correct its date instead.
 */
export const DELETE = defineRoute({
  permission: "payroll.manage",
  feature: "payroll",
  body: voidSchema,
  invalidBodyStatus: 422,
  handler: async ({ request: req, authz: gate, body }) => {
    const orgId = gate.user.orgId;
    const userId = gate.user.id;

    return withOrgTransaction(orgId, async () => {
      const row = (
        await db.execute<FiledRow>(
          sql`
        select id::text as id, employee_party_id::text as employee_party_id, certificate_key, country,
               region, sub_region, answers,
               effective_from::text as effective_from, superseded_on::text as superseded_on
          from employee_tax_certificates
         where org_id = ${orgId} and id = ${body.id}
         for update`,
          "objects",
        )
      )[0];
      if (!row) return notFound("record");
      const subsidiaryId = await employeeSubsidiaryId(orgId, row.employee_party_id);
      if (subsidiaryId === undefined) return notFound("record");
      const denied = guardSubsidiaryScope(gate, subsidiaryId);
      if (denied) return denied;
      if (row.superseded_on !== null) {
        return NextResponse.json(
          {
            error:
              `this "${row.certificate_key}" filing is already closed (${row.effective_from ?? "(undated)"} ` +
              `through ${row.superseded_on}) — voiding changes nothing`,
            remedy: "correct its effective date instead, or void the filing that is current",
          },
          { status: 422 },
        );
      }
      const today = await businessToday(orgId);
      // A future-dated filing closes at its own start (a zero-length interval
      // that was never in force); anything else closes as of today.
      const closedOn =
        row.effective_from !== null && row.effective_from > today ? row.effective_from : today;
      await db.execute(sql`
        update employee_tax_certificates
           set superseded_on = ${closedOn}::date, updated_by = ${userId}, updated_at = clock_timestamp()
         where org_id = ${orgId} and id = ${row.id}`);
      await db.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id, at)
        values (${orgId}, 'employee_tax_certificates', ${row.id}, 'update',
          ${JSON.stringify({
            kind: "certificate_void",
            before: { effective_from: row.effective_from, superseded_on: null },
            after: { effective_from: row.effective_from, superseded_on: closedOn },
            reason: body.reason,
          })}::jsonb,
          ${userId}, ${req.headers.get("X-Request-Id")}, clock_timestamp())`);
      return NextResponse.json({ ok: true, id: row.id, supersededOn: closedOn });
    });
  },
});

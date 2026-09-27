import { sql } from "drizzle-orm";
import { allocateDocumentNumber } from "../records/numbering.ts";
import { nextFreeEntryNumber } from "../records/entry-number.ts";
import { resolveCoveringPeriod } from "../periods/period-resolution.ts";
import { markEntryReversed, postEntry } from "../journal/post-entry.ts";
import { PostingError } from "../journal/posting-contracts.ts";
import { cmpMoney, negMoney, parseMoney, type Money } from "../money/brands.ts";
import { isIsoCalendarDate } from "../platform/business-date.ts";
import {
  lockAndCheckOrgFeature,
  orgFeatureEnabled,
} from "../organization/org-feature-lock.ts";
import {
  inDbTransaction,
  withOrgTransaction,
  type SqlExecutor,
} from "../platform/db.ts";
import {
  cancelDispatchRuns,
  dispatchFailureReason,
  findGatingRun,
} from "../flows/dispatch-result.ts";
import { runRecordFlows } from "../flows/run.ts";
import { FUND_RELEASE_SUBJECT_KIND } from "../flows/fund-releases-adapter.ts";
import {
  NonprofitError,
  NonprofitPostingError,
  fundFeatureOff,
} from "./errors.ts";
import {
  frameworkDeclaresRelease,
  requireNonprofitFramework,
  type NonprofitFrameworkKey,
} from "./frameworks.ts";

export type FundReleaseStatus = "draft" | "pending_approval" | "posted" | "void";

interface FundReleaseRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  release_number: string;
  from_fund_id: string;
  to_fund_id: string;
  release_account_id: string;
  release_date: string;
  amount: string;
  purpose: string;
  satisfaction_ref: string;
  status: FundReleaseStatus;
  submitted_by: string | null;
  submitted_at: string | null;
  flow_run_id: string | null;
  posted_entry_id: string | null;
  void_entry_id: string | null;
  created_by: string;
  updated_by: string;
}

export interface FundRelease {
  id: string;
  orgId: string;
  releaseNumber: string;
  fromFundId: string;
  toFundId: string;
  releaseAccountId: string;
  releaseDate: string;
  amount: Money;
  purpose: string;
  satisfactionRef: string;
  status: FundReleaseStatus;
  submittedBy: string | null;
  flowRunId: string | null;
  postedEntryId: string | null;
  voidEntryId: string | null;
}

export interface FundReleasePreview {
  release: FundRelease;
  framework: NonprofitFrameworkKey;
  fromFundCode: string;
  fromRestrictionClass: string;
  toFundCode: string;
  toRestrictionClass: string;
  availableNetAssets: Money;
}

interface FundDetail extends Record<string, unknown> {
  id: string;
  kind: string;
  restriction_class: string;
  code: string | null;
  name: string;
  is_active: boolean;
}

interface ReleaseReadiness {
  framework: NonprofitFrameworkKey;
  fromFund: FundDetail;
  toFund: FundDetail;
  availableNetAssets: Money;
}

const RELEASE_NUMBER_KIND = "fund_release";
const RELEASE_NUMBER_PREFIX = "FR-";
const RELEASE_ACCOUNT_TYPES = new Set(["income", "income_other", "equity"]);

function refusal(input: {
  message: string;
  code: string;
  remedy: string;
  status?: 409 | 422;
  field?: string;
}): NonprofitError {
  return new NonprofitError({
    ...input,
    status: input.status ?? 422,
  });
}

function toFundRelease(row: FundReleaseRow): FundRelease {
  return {
    id: row.id,
    orgId: row.org_id,
    releaseNumber: row.release_number,
    fromFundId: row.from_fund_id,
    toFundId: row.to_fund_id,
    releaseAccountId: row.release_account_id,
    releaseDate: row.release_date,
    amount: parseMoney(row.amount),
    purpose: row.purpose,
    satisfactionRef: row.satisfaction_ref,
    status: row.status,
    submittedBy: row.submitted_by,
    flowRunId: row.flow_run_id,
    postedEntryId: row.posted_entry_id,
    voidEntryId: row.void_entry_id,
  };
}

function requireText(value: string, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw refusal({
      message: `${field} is required for a fund release.`,
      code: "fund_release_input_required",
      remedy: `Enter a value for ${field}.`,
      field,
    });
  }
  return value.trim();
}

function requireActor(actorId: string): void {
  if (!actorId) {
    throw refusal({
      message: "A signed-in user is required to change a fund release.",
      code: "fund_release_actor_required",
      remedy: "Sign in with an organization user and retry.",
      field: "actorId",
    });
  }
}

function requireDate(value: string, field: string): string {
  if (typeof value !== "string" || !isIsoCalendarDate(value)) {
    throw refusal({
      message: `${field} must be a valid calendar date in YYYY-MM-DD format.`,
      code: "fund_release_date_invalid",
      remedy: "Choose a valid calendar date for the release.",
      field,
    });
  }
  return value;
}

function releaseAmount(value: unknown): Money {
  let amount: Money;
  try {
    amount = parseMoney(value);
  } catch {
    throw refusal({
      message: "The fund release amount is not a readable financial amount.",
      code: "fund_release_amount_invalid",
      remedy: "Enter the amount as a plain decimal string in the organization currency.",
      field: "amount",
    });
  }
  if (cmpMoney(amount, "0.0000") <= 0) {
    throw refusal({
      message: "A fund release amount must be greater than zero.",
      code: "fund_release_amount_not_positive",
      remedy: "Enter a positive amount for the release.",
      field: "amount",
    });
  }
  return amount;
}

async function assertFeatureRead(
  executor: SqlExecutor,
  orgId: string,
): Promise<void> {
  if (!(await orgFeatureEnabled(orgId, "fundAccounting", executor))) {
    throw fundFeatureOff();
  }
}

async function assertFeatureLocked(
  executor: SqlExecutor,
  orgId: string,
): Promise<void> {
  if (!(await lockAndCheckOrgFeature(executor, orgId, "fundAccounting"))) {
    throw fundFeatureOff();
  }
}

async function loadRelease(
  executor: SqlExecutor,
  orgId: string,
  releaseId: string,
  lock = false,
): Promise<FundReleaseRow> {
  const lockClause = lock ? sql`for update` : sql``;
  const row = (await executor.execute<FundReleaseRow>(sql`
    select id, org_id, release_number, from_fund_id, to_fund_id,
           release_account_id, release_date::text, amount::text, purpose,
           satisfaction_ref, status, submitted_by::text, submitted_at::text,
           flow_run_id::text, posted_entry_id::text, void_entry_id::text,
           created_by::text, updated_by::text
      from fund_releases
     where org_id = ${orgId} and id = ${releaseId}
     ${lockClause}
  `)).rows[0];
  if (!row) {
    throw refusal({
      message: `Fund release ${releaseId} was not found in this organization.`,
      code: "fund_release_not_found",
      remedy: "Choose a fund release from this organization's release list.",
      status: 409,
    });
  }
  return row;
}

async function loadFund(
  executor: SqlExecutor,
  orgId: string,
  fundId: string,
  field: "fromFundId" | "toFundId",
): Promise<FundDetail> {
  const row = (await executor.execute<FundDetail>(sql`
    select f.id, f.kind, f.restriction_class, sv.code, sv.name, sv.is_active
      from funds f
      join segment_values sv on sv.org_id = f.org_id and sv.id = f.id
     where f.org_id = ${orgId} and f.id = ${fundId}
     for share
  `)).rows[0];
  if (!row || !row.is_active) {
    throw refusal({
      message: `Fund ${fundId} is not an active fund in this organization.`,
      code: "fund_release_fund_invalid",
      remedy: "Choose active funds from this organization's fund list.",
      field,
    });
  }
  return row;
}

async function loadReleaseAccount(
  executor: SqlExecutor,
  orgId: string,
  accountId: string,
): Promise<void> {
  const account = (await executor.execute<{ id: string; type: string }>(sql`
    select id, type from accounts
     where org_id = ${orgId} and id = ${accountId}
       and is_active and not is_summary
     for share
  `)).rows[0];
  if (!account) {
    throw refusal({
      message: "The fund release account is missing, inactive, or cannot receive postings.",
      code: "fund_release_account_invalid",
      remedy: "Choose an active posting account from this organization's chart of accounts.",
      field: "releaseAccountId",
    });
  }
  if (!RELEASE_ACCOUNT_TYPES.has(account.type)) {
    throw refusal({
      message: "The fund release account must represent a net asset reclassification on the statement of activities or net assets.",
      code: "fund_release_account_type_invalid",
      remedy: "Choose an income or equity account for net assets released from restrictions in the chart of accounts.",
      field: "releaseAccountId",
    });
  }
}

function classPairRefusal(
  fromClass: string,
  toClass: string,
  framework: NonprofitFrameworkKey,
): NonprofitError {
  return refusal({
    message: `The ${framework} framework does not declare a release from class "${fromClass}" to class "${toClass}".`,
    code: "fund_release_class_pair_undeclared",
    remedy: "Choose funds with a release class pair declared by the selected framework.",
  });
}

function endowmentRefusal(fundCode: string, detail: string): NonprofitError {
  return refusal({
    message: `Endowment fund "${fundCode}" cannot be released without a posted board appropriation citing its resolution: ${detail}.`,
    code: "fund_release_endowment_appropriation_required",
    remedy: "Post and approve a board appropriation journal entry carrying this fund and citing the resolution in its memo, then enter the resolution reference in Satisfaction reference.",
  });
}

async function assertEndowmentAppropriation(
  executor: SqlExecutor,
  orgId: string,
  fund: FundDetail,
  reference: string,
): Promise<void> {
  if (fund.kind !== "endowment") return;
  const entry = (await executor.execute<{ id: string }>(sql`
    select je.id
      from journal_entries je
     where je.org_id = ${orgId}
       and je.status = 'posted'
       and je.origin = 'journal'
       and strpos(lower(coalesce(je.memo, '')), lower(${reference})) > 0
       and strpos(lower(coalesce(je.memo, '')), 'board appropriation') > 0
       and exists (
         select 1 from journal_lines jl
          where jl.org_id = je.org_id and jl.entry_id = je.id
            and jl.extra_dims->>'fund' = ${fund.id}
       )
     limit 1
  `)).rows[0];
  if (!entry) {
    throw endowmentRefusal(
      fund.code ?? fund.name,
      `resolution reference "${reference}" does not identify a posted board appropriation entry on that fund`,
    );
  }
}

async function availableNetAssets(
  executor: SqlExecutor,
  orgId: string,
  fundId: string,
  asOf: string,
): Promise<Money> {
  const row = (await executor.execute<{ amount: string }>(sql`
    select coalesce(sum(jl.amount), 0)::text as amount
      from journal_lines jl
      join journal_entries je
        on je.org_id = jl.org_id and je.id = jl.entry_id
      join accounts a on a.org_id = jl.org_id and a.id = jl.account_id
     where jl.org_id = ${orgId}
       and jl.extra_dims->>'fund' = ${fundId}
       and je.status in ('posted', 'reversed')
       and je.posting_date <= ${asOf}
       and (a.type like 'asset\\_%' escape '\\'
         or a.type like 'liability\\_%' escape '\\')
  `)).rows[0];
  return parseMoney(row?.amount ?? "0");
}

async function lockFundReleaseBalance(
  executor: SqlExecutor,
  orgId: string,
  fundId: string,
): Promise<void> {
  await executor.execute(sql`
    select pg_advisory_xact_lock(
      hashtextextended(${`openbooks:fund-release:${orgId}:${fundId}`}, 0)
    )
  `);
}

async function validateReadiness(
  executor: SqlExecutor,
  release: FundRelease,
  options: { checkAvailability: boolean; lockAvailability: boolean },
): Promise<ReleaseReadiness> {
  const framework = await requireNonprofitFramework(release.orgId, executor);
  const fromFund = await loadFund(executor, release.orgId, release.fromFundId, "fromFundId");
  const toFund = await loadFund(executor, release.orgId, release.toFundId, "toFundId");
  if (fromFund.id === toFund.id) {
    throw refusal({
      message: "A fund release must move value between two different funds.",
      code: "fund_release_same_fund",
      remedy: "Choose a different destination fund.",
      field: "toFundId",
    });
  }
  if (!frameworkDeclaresRelease(
    framework.framework,
    fromFund.restriction_class,
    toFund.restriction_class,
  )) {
    throw classPairRefusal(
      fromFund.restriction_class,
      toFund.restriction_class,
      framework.framework,
    );
  }
  await loadReleaseAccount(executor, release.orgId, release.releaseAccountId);
  await assertEndowmentAppropriation(
    executor,
    release.orgId,
    fromFund,
    release.satisfactionRef,
  );

  let available = "0.0000" as Money;
  if (options.checkAvailability) {
    if (options.lockAvailability) {
      await lockFundReleaseBalance(executor, release.orgId, fromFund.id);
    }
    available = await availableNetAssets(
      executor,
      release.orgId,
      fromFund.id,
      release.releaseDate,
    );
    if (cmpMoney(release.amount, available) > 0) {
      throw refusal({
        message: `Fund "${fromFund.code ?? fromFund.name}" has ${available} of available net assets; this release requests ${release.amount}.`,
        code: "fund_release_over_available",
        remedy: "Book qualifying support to the fund first, or reduce the release to the available amount shown.",
      });
    }
  }
  return {
    framework: framework.framework,
    fromFund,
    toFund,
    availableNetAssets: available,
  };
}

async function nextFundReleaseNumber(
  executor: SqlExecutor,
  orgId: string,
): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const number = await allocateDocumentNumber(
      executor,
      orgId,
      RELEASE_NUMBER_KIND,
      RELEASE_NUMBER_PREFIX,
    );
    const taken = (await executor.execute<{ id: string }>(sql`
      select id from fund_releases
       where org_id = ${orgId} and release_number = ${number}
       limit 1
    `)).rows[0];
    if (!taken) return number;
  }
  throw refusal({
    message: "A unique fund release number could not be allocated.",
    code: "fund_release_number_unavailable",
    remedy: "Review the fund release sequence in Company Settings and retry.",
    status: 409,
  });
}

async function recordAudit(
  executor: SqlExecutor,
  input: {
    orgId: string;
    releaseId: string;
    actorId: string | null;
    action: "insert" | "update";
    before: unknown;
    after: unknown;
    reason: string;
  },
): Promise<void> {
  await executor.execute(sql`
    insert into audit_log
      (org_id, table_name, row_id, action, changes, actor_id)
    values (
      ${input.orgId}, 'fund_releases', ${input.releaseId}, ${input.action},
      ${JSON.stringify({
        before: input.before,
        after: input.after,
        reason: input.reason,
      })}::jsonb,
      ${input.actorId}
    )
  `);
}

export async function createFundRelease(input: {
  orgId: string;
  fromFundId: string;
  toFundId: string;
  releaseAccountId: string;
  releaseDate: string;
  amount: unknown;
  purpose: string;
  satisfactionRef: string;
  actorId: string;
}): Promise<FundRelease> {
  requireActor(input.actorId);
  const purpose = requireText(input.purpose, "purpose");
  const satisfactionRef = requireText(input.satisfactionRef, "satisfactionRef");
  const releaseDate = requireDate(input.releaseDate, "releaseDate");
  const amount = releaseAmount(input.amount);
  for (const [field, value] of [
    ["fromFundId", input.fromFundId],
    ["toFundId", input.toFundId],
    ["releaseAccountId", input.releaseAccountId],
  ] as const) {
    requireText(value, field);
  }

  return withOrgTransaction(input.orgId, () =>
    inDbTransaction(async (tx) => {
      await assertFeatureLocked(tx, input.orgId);
      const draft: FundRelease = {
        id: "",
        orgId: input.orgId,
        releaseNumber: "",
        fromFundId: input.fromFundId,
        toFundId: input.toFundId,
        releaseAccountId: input.releaseAccountId,
        releaseDate,
        amount,
        purpose,
        satisfactionRef,
        status: "draft",
        submittedBy: null,
        flowRunId: null,
        postedEntryId: null,
        voidEntryId: null,
      };
      await validateReadiness(tx, draft, {
        checkAvailability: false,
        lockAvailability: false,
      });
      const releaseNumber = await nextFundReleaseNumber(tx, input.orgId);
      const inserted = (await tx.execute<FundReleaseRow>(sql`
        insert into fund_releases
          (org_id, release_number, from_fund_id, to_fund_id, release_account_id,
           release_date, amount, purpose, satisfaction_ref, status, custom,
           created_by, updated_by)
        values (
          ${input.orgId}, ${releaseNumber}, ${input.fromFundId}, ${input.toFundId},
          ${input.releaseAccountId}, ${releaseDate}, ${amount}, ${purpose},
          ${satisfactionRef}, 'draft', '{}'::jsonb, ${input.actorId}, ${input.actorId}
        )
        returning id, org_id, release_number, from_fund_id, to_fund_id,
                  release_account_id, release_date::text, amount::text, purpose,
                  satisfaction_ref, status, submitted_by::text, submitted_at::text,
                  flow_run_id::text, posted_entry_id::text, void_entry_id::text,
                  created_by::text, updated_by::text
      `)).rows[0];
      if (!inserted) {
        throw refusal({
          message: `Fund release ${releaseNumber} was not created.`,
          code: "fund_release_write_missing",
          remedy: "Retry release creation after checking the nonprofit release records.",
          status: 409,
        });
      }
      const release = toFundRelease(inserted);
      await recordAudit(tx, {
        orgId: input.orgId,
        releaseId: release.id,
        actorId: input.actorId,
        action: "insert",
        before: null,
        after: release,
        reason: purpose,
      });
      return release;
    }),
  );
}

export async function previewFundRelease(
  orgId: string,
  releaseId: string,
): Promise<FundReleasePreview> {
  return withOrgTransaction(orgId, () =>
    inDbTransaction(async (tx) => {
      await assertFeatureRead(tx, orgId);
      const release = toFundRelease(await loadRelease(tx, orgId, releaseId));
      const readiness = await validateReadiness(tx, release, {
        checkAvailability: true,
        lockAvailability: false,
      });
      return {
        release,
        framework: readiness.framework,
        fromFundCode: readiness.fromFund.code ?? readiness.fromFund.name,
        fromRestrictionClass: readiness.fromFund.restriction_class,
        toFundCode: readiness.toFund.code ?? readiness.toFund.name,
        toRestrictionClass: readiness.toFund.restriction_class,
        availableNetAssets: readiness.availableNetAssets,
      };
    }),
  );
}

async function postingReadiness(
  executor: SqlExecutor,
  release: FundRelease,
): Promise<ReleaseReadiness> {
  const readiness = await validateReadiness(executor, release, {
    checkAvailability: true,
    lockAvailability: true,
  });
  if (cmpMoney(release.amount, readiness.availableNetAssets) > 0) {
    throw new NonprofitPostingError({
      message: `Fund "${readiness.fromFund.code ?? readiness.fromFund.name}" has ${readiness.availableNetAssets} of available net assets; this release requests ${release.amount}.`,
      status: 422,
      code: "fund_release_over_available",
      remedy: "Book qualifying support to the fund first, or reduce the release to the available amount shown.",
    });
  }
  return readiness;
}

function postingRefusal(error: unknown, releaseNumber: string): NonprofitPostingError | null {
  if (error instanceof NonprofitError) return null;
  if (!(error instanceof PostingError)) return null;
  return new NonprofitPostingError({
    message: `Fund release ${releaseNumber} could not post: ${error.message}`,
    status: 409,
    code: "fund_release_posting_refused",
    remedy: "Resolve the named ledger refusal, then submit the release again.",
  });
}

async function selectedPostingContext(
  executor: SqlExecutor,
  orgId: string,
): Promise<{ bookId: string; subsidiaryId: string; currency: string }> {
  const row = (await executor.execute<{
    book_id: string;
    subsidiary_id: string;
    currency: string;
  }>(sql`
    select b.id as book_id, s.id as subsidiary_id, s.base_currency as currency
      from accounting_books b
      join subsidiaries s on s.org_id = b.org_id
     where b.org_id = ${orgId}
       and b.is_primary and b.is_active and b.posts_gl
       and s.is_active and not s.is_elimination and s.parent_id is null
     order by b.created_at, b.id, s.created_at, s.id
     limit 1
     for share of b, s
  `)).rows[0];
  if (!row) {
    throw refusal({
      message: "No active primary accounting book and root subsidiary are available for the release.",
      code: "fund_release_posting_context_missing",
      remedy: "Set an active primary book and root subsidiary in Company Settings → Accounting.",
      status: 409,
    });
  }
  return {
    bookId: row.book_id,
    subsidiaryId: row.subsidiary_id,
    currency: row.currency,
  };
}

async function postRelease(
  executor: SqlExecutor,
  release: FundRelease,
  actorId: string,
  expectedStatus: "draft" | "pending_approval",
  reason: string,
): Promise<FundRelease> {
  await lockFundReleaseBalance(executor, release.orgId, release.fromFundId);
  await postingReadiness(executor, release);
  const period = await resolveCoveringPeriod(executor, release.orgId, release.releaseDate);
  if (!period) {
    throw refusal({
      message: `No active accounting period covers ${release.releaseDate} for fund release ${release.releaseNumber}.`,
      code: "fund_release_period_missing",
      remedy: "Choose a release date covered by the active posting calendar.",
      status: 409,
    });
  }
  const context = await selectedPostingContext(executor, release.orgId);
  const entryNumber = await nextFreeEntryNumber(
    executor as Parameters<typeof nextFreeEntryNumber>[0],
    release.orgId,
    `${release.releaseNumber}-RELEASE`,
  );
  const memo = `Fund release ${release.releaseNumber}: ${release.purpose}`;
  let postedEntryId: string;
  try {
    const posted = await postEntry(executor, {
      orgId: release.orgId,
      bookId: context.bookId,
      subsidiaryId: context.subsidiaryId,
      entryNumber,
      postingDate: release.releaseDate,
      periodId: period.id,
      currency: context.currency,
      memo,
      origin: "release",
      actorId,
      auditAction: "fund_release_posted",
      auditChanges: {
        fundReleaseId: release.id,
        releaseNumber: release.releaseNumber,
        fromFundId: release.fromFundId,
        toFundId: release.toFundId,
        satisfactionRef: release.satisfactionRef,
      },
      lines: [
        {
          accountId: release.releaseAccountId,
          amount: release.amount,
          extraDims: { fund: release.fromFundId },
          memo,
        },
        {
          accountId: release.releaseAccountId,
          amount: negMoney(release.amount),
          extraDims: { fund: release.toFundId },
          memo,
        },
      ],
    });
    postedEntryId = posted.entryId;
  } catch (error) {
    const mapped = postingRefusal(error, release.releaseNumber);
    if (mapped) throw mapped;
    throw error;
  }

  const updated = (await executor.execute<FundReleaseRow>(sql`
    update fund_releases
       set status = 'posted', posted_entry_id = ${postedEntryId},
           submitted_by = coalesce(submitted_by, ${actorId}),
           submitted_at = coalesce(submitted_at, now()),
           updated_at = now(), updated_by = ${actorId}
     where org_id = ${release.orgId} and id = ${release.id}
       and status = ${expectedStatus}
     returning id, org_id, release_number, from_fund_id, to_fund_id,
               release_account_id, release_date::text, amount::text, purpose,
               satisfaction_ref, status, submitted_by::text, submitted_at::text,
               flow_run_id::text, posted_entry_id::text, void_entry_id::text,
               created_by::text, updated_by::text
  `)).rows[0];
  if (!updated) {
    throw refusal({
      message: `Fund release ${release.releaseNumber} changed before its posting was recorded.`,
      code: "fund_release_post_state_changed",
      remedy: "Reload the release and review its current lifecycle status.",
      status: 409,
    });
  }
  const result = toFundRelease(updated);
  await recordAudit(executor, {
    orgId: release.orgId,
    releaseId: release.id,
    actorId,
    action: "update",
    before: {
      status: expectedStatus,
      submittedBy: release.submittedBy ?? actorId,
      postedEntryId: null,
    },
    after: {
      status: result.status,
      submittedBy: result.submittedBy,
      postedEntryId,
      flowRunId: result.flowRunId,
    },
    reason,
  });
  return result;
}

export async function submitFundRelease(input: {
  orgId: string;
  releaseId: string;
  actorId: string;
}): Promise<FundRelease> {
  requireActor(input.actorId);
  return withOrgTransaction(input.orgId, () =>
    inDbTransaction(async (tx) => {
      await assertFeatureLocked(tx, input.orgId);
      const row = await loadRelease(tx, input.orgId, input.releaseId, true);
      const release = toFundRelease(row);
      if (release.status !== "draft") {
        throw refusal({
          message: `Fund release ${release.releaseNumber} is ${release.status} and cannot be submitted.`,
          code: "fund_release_state_conflict",
          remedy: "Reload the release and submit it only while it is in draft.",
          status: 409,
        });
      }
      await validateReadiness(tx, release, {
        checkAvailability: true,
        lockAvailability: false,
      });
      const beforeSubmitter = release.submittedBy;

      const markedForSubmission = (await tx.execute<{ id: string }>(sql`
        update fund_releases
           set submitted_by = ${input.actorId}, submitted_at = now(),
               updated_at = now(), updated_by = ${input.actorId}
         where org_id = ${input.orgId} and id = ${release.id} and status = 'draft'
         returning id
      `)).rows[0];
      if (!markedForSubmission) {
        throw refusal({
          message: `Fund release ${release.releaseNumber} changed before submission began.`,
          code: "fund_release_submit_state_changed",
          remedy: "Reload the release and review its current lifecycle status.",
          status: 409,
        });
      }

      const dispatched = await runRecordFlows(
        { kind: "on_submit", source: "api" },
        FUND_RELEASE_SUBJECT_KIND,
        release.id,
        { orgId: input.orgId, userId: input.actorId },
      );
      if (dispatched.failed) {
        await cancelDispatchRuns(input.orgId, dispatched.runs.map((item) => item.runId), {
          actorId: input.actorId,
        });
        const cause = dispatchFailureReason(dispatched) ?? "approval routing failed";
        throw refusal({
          message: `Fund release approval routing failed: ${cause}.`,
          code: "fund_release_approval_routing_failed",
          remedy: "Fix or disable the named flow, then submit the release again.",
          status: 409,
        });
      }

      const gatingRun = findGatingRun(dispatched);
      if (dispatched.gatesCreated > 0 && !gatingRun) {
        await cancelDispatchRuns(input.orgId, dispatched.runs.map((item) => item.runId), {
          actorId: input.actorId,
        });
        throw refusal({
          message: "Fund release approval routing created gates without a resolvable approval run.",
          code: "fund_release_approval_run_missing",
          remedy: "Review the configured fund release approval flows and submit again.",
          status: 409,
        });
      }

      if (!gatingRun) {
        try {
          return await postRelease(tx, release, input.actorId, "draft", release.purpose);
        } catch (error) {
          if (dispatched.runs.length > 0) {
            await cancelDispatchRuns(input.orgId, dispatched.runs.map((item) => item.runId), {
              actorId: input.actorId,
            });
          }
          throw error;
        }
      }

      try {
        await lockFundReleaseBalance(tx, input.orgId, release.fromFundId);
        await validateReadiness(tx, release, {
          checkAvailability: true,
          lockAvailability: false,
        });
      } catch (error) {
        await cancelDispatchRuns(input.orgId, dispatched.runs.map((item) => item.runId), {
          actorId: input.actorId,
        });
        throw error;
      }
      const pending = (await tx.execute<FundReleaseRow>(sql`
        update fund_releases
           set status = 'pending_approval', submitted_by = ${input.actorId},
               submitted_at = now(), flow_run_id = ${gatingRun.runId},
               updated_at = now(), updated_by = ${input.actorId}
         where org_id = ${input.orgId} and id = ${release.id} and status = 'draft'
         returning id, org_id, release_number, from_fund_id, to_fund_id,
                   release_account_id, release_date::text, amount::text, purpose,
                   satisfaction_ref, status, submitted_by::text, submitted_at::text,
                   flow_run_id::text, posted_entry_id::text, void_entry_id::text,
                   created_by::text, updated_by::text
      `)).rows[0];
      if (!pending) {
        await cancelDispatchRuns(input.orgId, dispatched.runs.map((item) => item.runId), {
          actorId: input.actorId,
        });
        throw refusal({
          message: `Fund release ${release.releaseNumber} changed before approval was requested.`,
          code: "fund_release_submit_state_changed",
          remedy: "Reload the release and review its current lifecycle status.",
          status: 409,
        });
      }
      const result = toFundRelease(pending);
      await recordAudit(tx, {
        orgId: input.orgId,
        releaseId: release.id,
        actorId: input.actorId,
        action: "update",
        before: { status: "draft", submittedBy: beforeSubmitter },
        after: {
          status: "pending_approval",
          submittedBy: result.submittedBy,
          flowRunId: result.flowRunId,
        },
        reason: release.purpose,
      });
      return result;
    }),
  );
}

export async function releaseFundReleaseApproval(input: {
  subjectId: string;
  outcome: "approved" | "rejected";
  comment?: string | null;
  ctx: { orgId: string; userId?: string | null };
}): Promise<void> {
  await withOrgTransaction(input.ctx.orgId, () =>
    inDbTransaction(async (tx) => {
      await assertFeatureLocked(tx, input.ctx.orgId);
      const row = await loadRelease(tx, input.ctx.orgId, input.subjectId, true);
      const release = toFundRelease(row);
      if (release.status !== "pending_approval") {
        throw refusal({
          message: `Fund release ${release.releaseNumber} is ${release.status} and cannot receive an approval decision.`,
          code: "fund_release_state_conflict",
          remedy: "Approve or reject a release only while it is pending approval in Flows.",
          status: 409,
        });
      }
      if (!input.ctx.userId) {
        throw refusal({
          message: "A signed-in approver is required to decide a fund release.",
          code: "fund_release_approver_required",
          remedy: "Have an authorized approver decide the release through Flows.",
          status: 409,
        });
      }
      if (input.outcome === "rejected") {
        const comment = input.comment?.trim() || "Approval was rejected.";
        const rejected = (await tx.execute<{ id: string }>(sql`
          update fund_releases
             set status = 'draft', submitted_by = null, submitted_at = null,
                 flow_run_id = null, updated_at = now(), updated_by = ${input.ctx.userId}
           where org_id = ${input.ctx.orgId} and id = ${release.id}
             and status = 'pending_approval'
           returning id
        `)).rows[0];
        if (!rejected) {
          throw refusal({
            message: `Fund release ${release.releaseNumber} could not be returned to draft after rejection.`,
            code: "fund_release_rejection_write_missing",
            remedy: "Reload the release and review its lifecycle status.",
            status: 409,
          });
        }
        await recordAudit(tx, {
          orgId: input.ctx.orgId,
          releaseId: release.id,
          actorId: input.ctx.userId,
          action: "update",
          before: {
            status: "pending_approval",
            submittedBy: release.submittedBy,
            flowRunId: release.flowRunId,
          },
          after: { status: "draft", submittedBy: null, flowRunId: null },
          reason: comment,
        });
        return;
      }
      await postRelease(
        tx,
        release,
        input.ctx.userId,
        "pending_approval",
        input.comment?.trim() || "Approved through Flows.",
      );
    }),
  );
}

interface ReversalLine extends Record<string, unknown> {
  account_id: string;
  amount: string;
  subsidiary_id: string;
  currency: string;
  txn_amount: string;
  fx_rate: string;
  memo: string | null;
  party_id: string | null;
  department_id: string | null;
  project_id: string | null;
  location_id: string | null;
  class_id: string | null;
  equipment_unit_id: string | null;
  payment_card_id: string | null;
  tax_code_id: string | null;
  extra_dims: Record<string, unknown>;
  quantity: string | null;
  unit: string | null;
  due_date: string | null;
  is_open_item: boolean | null;
}

export async function voidFundRelease(input: {
  orgId: string;
  releaseId: string;
  actorId: string;
  voidDate: string;
  reason: string;
}): Promise<FundRelease> {
  requireActor(input.actorId);
  const voidDate = requireDate(input.voidDate, "voidDate");
  const reason = requireText(input.reason, "reason");
  return withOrgTransaction(input.orgId, () =>
    inDbTransaction(async (tx) => {
      await assertFeatureLocked(tx, input.orgId);
      const row = await loadRelease(tx, input.orgId, input.releaseId, true);
      const release = toFundRelease(row);
      if (release.status !== "posted" || !release.postedEntryId) {
        throw refusal({
          message: `Fund release ${release.releaseNumber} is ${release.status} and cannot be voided.`,
          code: "fund_release_state_conflict",
          remedy: "Void a posted release; submit a draft through its approval lifecycle first.",
          status: 409,
        });
      }
      const original = (await tx.execute<{
        id: string;
        entry_number: string;
        status: string;
        book_id: string;
        subsidiary_id: string;
        period_id: string;
      }>(sql`
        select id, entry_number, status, book_id, subsidiary_id, period_id
          from journal_entries
         where org_id = ${input.orgId} and id = ${release.postedEntryId}
         for update
      `)).rows[0];
      if (!original || original.status !== "posted") {
        throw refusal({
          message: `Fund release ${release.releaseNumber} does not reference a posted journal entry that can be reversed.`,
          code: "fund_release_posted_entry_invalid",
          remedy: "Review the linked journal entry before changing the release.",
          status: 409,
        });
      }
      const lines = (await tx.execute<ReversalLine>(sql`
        select account_id, amount::text, subsidiary_id, currency,
               txn_amount::text, fx_rate::text, memo, party_id, department_id,
               project_id, location_id, class_id, equipment_unit_id,
               payment_card_id, tax_code_id, extra_dims, quantity::text, unit,
               due_date::text, is_open_item
          from journal_lines
         where org_id = ${input.orgId} and entry_id = ${original.id}
         order by line_number
      `)).rows;
      if (lines.length === 0) {
        throw refusal({
          message: `Posted journal entry ${original.entry_number} has no lines to reverse.`,
          code: "fund_release_posted_entry_lines_missing",
          remedy: "Have an administrator investigate the journal entry before voiding this release.",
          status: 409,
        });
      }
      const period = await resolveCoveringPeriod(tx, input.orgId, voidDate);
      if (!period) {
        throw refusal({
          message: `No active accounting period covers ${voidDate} for this release reversal.`,
          code: "fund_release_void_period_missing",
          remedy: "Choose a void date covered by the active posting calendar.",
          status: 409,
        });
      }
      const entryNumber = await nextFreeEntryNumber(
        tx as Parameters<typeof nextFreeEntryNumber>[0],
        input.orgId,
        `${original.entry_number}-VOID`,
      );
      let reversalEntryId: string;
      try {
        const reversal = await postEntry(tx, {
          orgId: input.orgId,
          bookId: original.book_id,
          subsidiaryId: original.subsidiary_id,
          entryNumber,
          postingDate: voidDate,
          periodId: period.id,
          memo: `Void fund release ${release.releaseNumber}: ${reason}`,
          origin: "release",
          reversesEntryId: original.id,
          actorId: input.actorId,
          auditAction: "fund_release_voided",
          auditChanges: {
            fundReleaseId: release.id,
            releaseNumber: release.releaseNumber,
            reversesEntryId: original.id,
            reason,
          },
          lines: lines.map((line) => ({
            accountId: line.account_id,
            amount: negMoney(line.amount),
            subsidiaryId: line.subsidiary_id,
            currency: line.currency,
            txnAmount: negMoney(line.txn_amount),
            fxRate: line.fx_rate,
            memo: line.memo,
            partyId: line.party_id,
            departmentId: line.department_id,
            projectId: line.project_id,
            locationId: line.location_id,
            classId: line.class_id,
            equipmentUnitId: line.equipment_unit_id,
            paymentCardId: line.payment_card_id,
            taxCodeId: line.tax_code_id,
            extraDims: line.extra_dims,
            quantity: line.quantity,
            unit: line.unit,
            dueDate: line.due_date,
            isOpenItem: line.is_open_item ?? false,
          })),
        });
        reversalEntryId = reversal.entryId;
        await markEntryReversed(tx, {
          orgId: input.orgId,
          entryId: original.id,
          actorId: input.actorId,
        });
      } catch (error) {
        const mapped = postingRefusal(error, release.releaseNumber);
        if (mapped) throw mapped;
        throw error;
      }

      const updated = (await tx.execute<FundReleaseRow>(sql`
        update fund_releases
           set status = 'void', void_entry_id = ${reversalEntryId},
               updated_at = now(), updated_by = ${input.actorId}
         where org_id = ${input.orgId} and id = ${release.id} and status = 'posted'
         returning id, org_id, release_number, from_fund_id, to_fund_id,
                   release_account_id, release_date::text, amount::text, purpose,
                   satisfaction_ref, status, submitted_by::text, submitted_at::text,
                   flow_run_id::text, posted_entry_id::text, void_entry_id::text,
                   created_by::text, updated_by::text
      `)).rows[0];
      if (!updated) {
        throw refusal({
          message: `Fund release ${release.releaseNumber} changed before its void was recorded.`,
          code: "fund_release_void_state_changed",
          remedy: "Reload the release and review its current lifecycle status.",
          status: 409,
        });
      }
      const result = toFundRelease(updated);
      await recordAudit(tx, {
        orgId: input.orgId,
        releaseId: release.id,
        actorId: input.actorId,
        action: "update",
        before: { status: "posted", postedEntryId: release.postedEntryId },
        after: { status: "void", voidEntryId: reversalEntryId },
        reason,
      });
      return result;
    }),
  );
}

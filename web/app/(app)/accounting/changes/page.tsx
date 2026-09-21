import { redirect } from "next/navigation";
import { accessDeniedHref } from "@/lib/gate-targets";
import Link from "next/link";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import type { FinancialChange } from "@openbooks/engine/src/platform/financial-changes.ts";
import { PageHeader, UrlDrawer, Badge } from "@openbooks/ui";
import { ListPageLayout } from "@/components/page-layout";
import { EntityListView } from "@/components/entity-list-view";
import { ModuleHomeTabs } from "@/components/module-home/ui";
import { groupTabs } from "@/components/module-home/group-tabs";
import { can, getAuthz } from "@/lib/authz";
import { isUuid } from "@/lib/list-params";
import { subsidiaryVisibleFilter } from "@/lib/subsidiaries";
import { ChangeEvidence } from "./ChangeEvidence";
import { ReverseAssetChange } from "./ReverseAssetChange";
import { ChangeActions } from "./ChangeActions";
export const dynamic = "force-dynamic";
const fieldNames: Record<string, string> = {
  groupCarryingBefore: "Group carrying amount before valuation",
  groupCarryingAfter: "Group carrying amount after valuation",
  groupValuationDelta: "Group valuation adjustment",
  netAssets: "Consolidated net assets removed",
  nci: "Non-controlling interests removed",
  parentGain: "Separate-book gain or loss",
  groupGain: "Group disposal gain or loss",
  recycledOci: "OCI reclassified to profit or loss",
  transferredOci: "OCI transferred to retained earnings",
  totalGroupGain: "Total group gain or loss",
  retainedFairValue: "Retained interest fair value",
  carryingLiability: "Liability before change",
  carryingRou: "ROU before change",
  stubInterest: "Elapsed-period interest",
  stubRou: "Elapsed-period ROU expense",
  prepaidCarrying: "Prepaid expense carried forward",
  newLiability: "Revised unpaid liability",
  newRou: "Revised ROU carrying amount",
  liabilityDelta: "Liability adjustment",
  rouDelta: "ROU adjustment",
  removedLiability: "Liability removed",
  removedRou: "ROU removed",
  gain: "Gain (negative = loss)",
  settlement: "Settlement payment",
  scopeReductionPercent: "Scope reduction (%)",
  settlementPayment: "Settlement payment",
  payment: "Revised payment",
  periods: "Remaining periods",
  annualRatePercent: "Annual discount rate (%)",
  paymentTiming: "Contractual timing",
  paymentFrequency: "Payment frequency",
  assessment: "Accounting assessment",
  dayCountPolicy: "Accrual basis",
  transfersOwnership: "Ownership transfers",
  purchaseOptionReasonablyCertain: "Purchase option reasonably certain",
  specializedAsset: "Specialized asset with no alternative use",
  economicLifeMonths: "Remaining economic life (months)",
  leaseTermMonths: "Remaining lease term (months)",
  termThresholdPercent: "Major part threshold (%)",
  pvOfPayments: "Assessed present value of payments",
  fairValue: "Asset fair value",
  pvThresholdPercent: "Substantially all threshold (%)",
};
function Facts({ value }: { value: Record<string, unknown> }) {
  return (
    <dl className="grid grid-cols-2 gap-2">
      {Object.entries(value)
        .filter(
          ([key, v]) =>
            fieldNames[key] &&
            (typeof v === "string" ||
              typeof v === "number" ||
              typeof v === "boolean"),
        )
        .map(([key, v]) => (
          <div key={key}>
            <dt className="text-sm text-slate-500">{fieldNames[key]}</dt>
            <dd>
              {typeof v === "boolean"
                ? v
                  ? "Yes"
                  : "No"
                : String(v).replaceAll("_", " ")}
            </dd>
          </div>
        ))}
    </dl>
  );
}
export default async function AccountingChanges({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const auth = await getAuthz();
  if (!auth) redirect("/login");
  const domains = can(auth, "gl.read")
    ? ["lease", "asset", "revenue", "consolidation"]
    : [
        ...(can(auth, "assets.read") ? ["lease", "asset"] : []),
        ...(can(auth, "ar.read") ? ["revenue"] : []),
        ...(can(auth, "close.read") ? ["consolidation"] : []),
      ];
  if (!domains.length) redirect(accessDeniedHref({ permission: "gl.read" }));
  const scopePredicate = sql`fc.domain in (${sql.join(
    domains.map((domain) => sql`${domain}`),
    sql`, `,
  )}) ${auth.allowedSubsidiaryIds ? sql`and not exists(select 1 from jsonb_array_elements_text(coalesce(fc.payload->'requiredSubsidiaryIds','[]'::jsonb)) required(id) where required.id not in(select jsonb_array_elements_text(${JSON.stringify([...auth.allowedSubsidiaryIds])}::jsonb)))` : sql``}`;
  const sp = await searchParams,
    orgId = auth.user.orgId;
  const id =
    typeof sp.change === "string" && isUuid(sp.change) ? sp.change : null;
  const row = id
    ? (
        await db.execute<
          FinancialChange & {
            subsidiary_name: string;
            proposer_name: string;
            approver_name: string | null;
          }
        >(sql`
    select fc.*,fc.effective_on::text as effective_on,s.name as subsidiary_name,u.name as proposer_name,a.name as approver_name
    from financial_changes fc join subsidiaries s on s.id=fc.subsidiary_id and s.org_id=fc.org_id
      left join users u on u.id=fc.submitted_by left join users a on a.id=fc.approved_by
    where fc.org_id=${orgId} and fc.id=${id} and ${scopePredicate} ${subsidiaryVisibleFilter(sql`fc.subsidiary_id`, auth.allowedSubsidiaryIds)}`)
      ).rows[0]
    : null;
  const referenceIds = new Set<string>();
  const collect = (v: unknown): void => {
    if (typeof v === "string" && isUuid(v)) referenceIds.add(v);
    else if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === "object") Object.values(v).forEach(collect);
  };
  if (row) {
    collect(row.payload);
    collect(row.before_state.preview);
    collect(row.before_state.previews);
  }
  const references = referenceIds.size
    ? (
        await db.execute<{ id: string; label: string }>(sql`
    select id,number||' — '||name as label from accounts where org_id=${orgId} and id in(select jsonb_array_elements_text(${JSON.stringify([...referenceIds])}::jsonb)::uuid)
    union all select id,name from accounting_books where org_id=${orgId} and id in(select jsonb_array_elements_text(${JSON.stringify([...referenceIds])}::jsonb)::uuid)
    union all select id,name from recognition_rules where org_id=${orgId} and id in(select jsonb_array_elements_text(${JSON.stringify([...referenceIds])}::jsonb)::uuid)
    union all select id,description from performance_obligations where org_id=${orgId} and id in(select jsonb_array_elements_text(${JSON.stringify([...referenceIds])}::jsonb)::uuid)
    union all select id,name from subsidiaries where org_id=${orgId} and id in(select jsonb_array_elements_text(${JSON.stringify([...referenceIds])}::jsonb)::uuid)
  `)
      ).rows
    : [];
  const referenceNames = Object.fromEntries(
    references.map((r) => [r.id, r.label]),
  );
  const permission =
    row?.domain === "revenue"
      ? "ar.post"
      : row?.domain === "consolidation"
        ? "close.run"
        : "assets.manage";
  const tabs = await groupTabs("accounting", "/accounting/changes", { orgId });
  return (
    <ListPageLayout
      header={
        <PageHeader
          title="Accounting changes"
          description="Approved changes retain the original accounting and append an auditable adjustment."
          actions={<ModuleHomeTabs tabs={tabs} />}
        />
      }
    >
      <EntityListView
        recordType="financial_change"
        scopePredicate={scopePredicate}
        orgId={orgId}
        userId={auth.user.id}
        canManage={false}
        sp={sp}
        drawer={
          row ? (
            <UrlDrawer
              open
              closeHref="/accounting/changes"
              title={`${row.domain}: ${row.operation.replaceAll("_", " ")}`}
              description={row.subsidiary_name}
              size="2xl"
            >
              <div className="space-y-5">
                <Badge>{row.status}</Badge>
                <p>
                  Effective {row.effective_on} · Proposed by {row.proposer_name}
                </p>
                <p>{row.reason}</p>
                {row.approver_name ? (
                  <p>Independent decision by {row.approver_name}</p>
                ) : null}
                {row.before_state.preview &&
                typeof row.before_state.preview === "object" &&
                !Array.isArray(row.before_state.preview) ? (
                  <section className="space-y-2">
                    <h3 className="font-semibold">
                      Proposed accounting impact
                    </h3>
                    <Facts
                      value={
                        row.before_state.preview as Record<string, unknown>
                      }
                    />
                  </section>
                ) : null}
                <section className="space-y-2">
                  <h3 className="font-semibold">
                    Proposed terms and assessment
                  </h3>
                  <ChangeEvidence value={row.payload} names={referenceNames} />
                </section>
                {["revenue", "asset", "consolidation"].includes(row.domain) ? (
                  <section className="space-y-2">
                    <h3 className="font-semibold">Book-specific allocations</h3>
                    <ChangeEvidence
                      value={
                        row.before_state.preview ?? row.before_state.previews
                      }
                      names={referenceNames}
                    />
                  </section>
                ) : null}
                {row.result ? (
                  <section className="space-y-2">
                    <h3 className="font-semibold">Applied result</h3>
                    <Facts value={row.result} />
                    {Array.isArray(row.result.entryIds)
                      ? row.result.entryIds.map((entry) => (
                          <p key={String(entry)}>
                            <Link
                              className="underline"
                              href={`/journal?entry=${String(entry)}`}
                            >
                              Adjustment journal
                            </Link>
                          </p>
                        ))
                      : null}
                  </section>
                ) : null}
                {row.domain === "revenue" ? (
                  <Link
                    className="underline"
                    href={`/revenue?contract=${row.subject_id}`}
                  >
                    Open revenue contract
                  </Link>
                ) : null}
                {row.domain === "asset" ? (
                  <Link
                    className="underline"
                    href={`/assets?asset=${row.subject_id}`}
                  >
                    Open asset and depreciation history
                  </Link>
                ) : null}
                {row.domain === "lease" ? (
                  <Link
                    className="underline"
                    href={`/assets/leases?lease=${row.subject_id}`}
                  >
                    Open lease and schedule history
                  </Link>
                ) : null}
                {row.domain === "asset" &&
                row.status === "applied" &&
                ["partial_disposal", "intercompany_transfer"].includes(
                  row.operation,
                ) &&
                can(auth, "assets.manage") ? (
                  <ReverseAssetChange
                    id={row.id}
                    effectiveOn={row.effective_on}
                  />
                ) : null}
                {row.domain === "consolidation" &&
                row.operation === "loss_of_control" &&
                row.status === "applied" &&
                can(auth, "close.run") ? (
                  <ReverseAssetChange id={row.id} domain="consolidation" />
                ) : null}
                {row.domain === "consolidation" ? (
                  <Link
                    className="underline"
                    href={`/admin/setup/subsidiary-ownership-interests?row=${row.subject_id}`}
                  >
                    Open ownership policy
                  </Link>
                ) : null}
                <ChangeActions
                  id={row.id}
                  status={row.status}
                  canSubmit={
                    can(auth, permission) && row.submitted_by === auth.user.id
                  }
                  canApply={can(auth, permission)}
                />
              </div>
            </UrlDrawer>
          ) : undefined
        }
      />
    </ListPageLayout>
  );
}

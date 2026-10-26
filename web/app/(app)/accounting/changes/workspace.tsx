import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import type { FinancialChange } from "@openbooks/engine/platform/financial-changes";
import { UrlDrawer, Badge } from "@openbooks/ui";
import { EntityListView } from "@/components/entity-list-view";
import { JournalEntryLink } from "@/components/journal-entry-link";
import { can } from "@/lib/authz";
import { isAccountingChangeFeatureAllowed } from "@/lib/accounting-change-authority";
import { isUuid, mergeHref } from "@/lib/list-params";
import { subsidiaryVisibleFilter } from "@/lib/subsidiaries";
import {
  financialChangeSubjectExpr,
  manufacturingChangeResourcesVisible,
} from "@/lib/customization/entity-list-query/accounting-lifecycles";
import {
  BomRevisionEvidence,
  ChangeEvidence,
  ChangeFacts,
  RoutingRevisionEvidence,
} from "./ChangeEvidence";
import { ReverseAssetChange } from "./ReverseAssetChange";
import { ChangeActions } from "./ChangeActions";
import { ChangeGateDecision } from "./ChangeGateDecision";
import type { DelegateOption } from "../../inbox/GateActions";
import { gateDelegateOptions } from "@/lib/gate-delegates";
import { gateDecisionCapability } from "@openbooks/engine/flows/module";
import type { AccountingChangesWorkspaceData } from "./view";

export async function AccountingChangesWorkspace({
  data,
}: {
  data: AccountingChangesWorkspaceData;
}) {
  const t = await getTranslations("accounting");
  const { auth, domains, allowNetInvestmentOciReversal, sp } = data;
  const domainPredicate = domains.length
    ? sql`fc.domain in (${sql.join(
        domains.map((domain) => sql`${domain}`),
        sql`, `,
      )})`
    : sql`false`;
  const reversalPredicate = allowNetInvestmentOciReversal
    ? sql` or (fc.domain = 'consolidation' and fc.operation = 'net_investment_oci_reversal')`
    : sql``;
  const scopePredicate = sql`(${domainPredicate}${reversalPredicate}) ${auth.allowedSubsidiaryIds ? sql`and not exists(select 1 from jsonb_array_elements_text(coalesce(fc.payload->'requiredSubsidiaryIds','[]'::jsonb)) required(id) where required.id not in(select jsonb_array_elements_text(${JSON.stringify([...auth.allowedSubsidiaryIds])}::jsonb)))` : sql``} ${manufacturingChangeResourcesVisible(auth.allowedSubsidiaryIds)}`;
  const orgId = auth.user.orgId;
  const id = typeof sp.change === "string" && isUuid(sp.change) ? sp.change : null;
  const row = id
    ? (
        await db.execute<
          FinancialChange & {
            subsidiary_name: string;
            proposer_name: string;
            approver_name: string | null;
            subject_label: string;
          }
        >(
          sql`
    select fc.*,fc.effective_on::text as effective_on,s.name as subsidiary_name,u.name as proposer_name,a.name as approver_name,
      ${financialChangeSubjectExpr("fc")} as subject_label
    from financial_changes fc join subsidiaries s on s.id=fc.subsidiary_id and s.org_id=fc.org_id
      left join users u on u.id=fc.submitted_by left join users a on a.id=fc.approved_by
    where fc.org_id=${orgId} and fc.id=${id} and ${scopePredicate} ${subsidiaryVisibleFilter(sql`fc.subsidiary_id`, auth.allowedSubsidiaryIds)}`,
          "objects",
        )
      )[0]
    : null;
  const referenceIds = new Set<string>();
  const collect = (v: unknown): void => {
    if (typeof v === "string" && isUuid(v)) referenceIds.add(v);
    else if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === "object") Object.values(v).forEach(collect);
  };
  if (row) {
    collect(row.payload);
    collect(row.before_state);
    collect(row.before_state.preview);
    collect(row.before_state.previews);
  }
  const references = referenceIds.size
    ? await db.execute<{ id: string; label: string }>(
        sql`
    select id,number||' — '||name as label from accounts where org_id=${orgId} and id in(select jsonb_array_elements_text(${JSON.stringify([...referenceIds])}::jsonb)::uuid)
    union all select id,name from accounting_books where org_id=${orgId} and id in(select jsonb_array_elements_text(${JSON.stringify([...referenceIds])}::jsonb)::uuid)
    union all select id,name from recognition_rules where org_id=${orgId} and id in(select jsonb_array_elements_text(${JSON.stringify([...referenceIds])}::jsonb)::uuid)
    union all select id,description from performance_obligations where org_id=${orgId} and id in(select jsonb_array_elements_text(${JSON.stringify([...referenceIds])}::jsonb)::uuid)
    union all select id,name from subsidiaries where org_id=${orgId} and id in(select jsonb_array_elements_text(${JSON.stringify([...referenceIds])}::jsonb)::uuid)
    union all select id,code||' — '||name as label from items where org_id=${orgId} and id in(select jsonb_array_elements_text(${JSON.stringify([...referenceIds])}::jsonb)::uuid)
    union all select id,code||' — '||name as label from mfg_work_centers where org_id=${orgId} and id in(select jsonb_array_elements_text(${JSON.stringify([...referenceIds])}::jsonb)::uuid)
    union all select id,code||' — '||name as label from mfg_routings where org_id=${orgId} and id in(select jsonb_array_elements_text(${JSON.stringify([...referenceIds])}::jsonb)::uuid)
    union all select id,number as label from mfg_work_orders where org_id=${orgId} and id in(select jsonb_array_elements_text(${JSON.stringify([...referenceIds])}::jsonb)::uuid)
    union all select id,name from provision_obligations where org_id=${orgId} and id in(select jsonb_array_elements_text(${JSON.stringify([...referenceIds])}::jsonb)::uuid)
    union all select id,name from users where org_id=${orgId} and id in(select jsonb_array_elements_text(${JSON.stringify([...referenceIds])}::jsonb)::uuid)
  `,
        "objects",
      )
    : [];
  const referenceNames = Object.fromEntries(references.map((r) => [r.id, r.label]));
  const permission =
    row?.domain === "manufacturing"
      ? "manufacturing.manage"
      : row?.domain === "payroll"
        ? "payroll.run"
        : row?.domain === "provision"
          ? "gl.post"
          : row?.domain === "revenue" || row?.domain === "sales"
            ? "ar.post"
            : row?.domain === "consolidation"
              ? "close.run"
              : "assets.manage";
  // The pending decision for this change, for the current approver: every
  // pending gate on the change with the native capability resolved, so the
  // drawer offers Approve/Reject through the same decision path as the
  // Inbox — or names that another approver must act (SoD), never an action
  // that refuses on click.
  const pendingGates =
    row?.status === "pending" && id
      ? await db.execute<{
          id: string;
          assigneeUserId: string | null;
          signatureRequired: boolean;
        }>(
          sql`
        select g.id::text as id, g.assignee_user_id::text as "assigneeUserId",
               g.signature_required as "signatureRequired"
          from flow_gates g
         where g.org_id = ${orgId} and g.subject_kind = 'financial_change'
           and g.subject_id = ${id} and g.status = 'pending'
         order by g.created_at, g.id`,
          "objects",
        )
      : [];
  const gateDecisions = await Promise.all(
    pendingGates.map(async (gate) => ({
      ...gate,
      ...(await gateDecisionCapability(gate.id, auth.user.id)),
    })),
  );
  const actionableGate = gateDecisions.find((gate) => gate.canAct) ?? null;
  const awaitingGate =
    actionableGate == null ? (gateDecisions.find((gate) => gate.sodBlocked) ?? null) : null;
  const decisionGate = actionableGate ?? awaitingGate;
  // Delegate is offered only where the hand-off is accepted (the gate's
  // direct assignee or an organization admin), never on flows.manage alone.
  const delegateUsers: DelegateOption[] = await gateDelegateOptions(
    orgId,
    auth.user.id,
    decisionGate?.id ?? null,
  );
  const eventTitle = row
    ? t.has(`lifecycle.operations.${row.operation}`)
      ? t(`lifecycle.operations.${row.operation}`)
      : row.operation.replaceAll("_", " ")
    : "";
  const featureAllowed = row
    ? isAccountingChangeFeatureAllowed(
        row.domain,
        row.operation,
        domains,
        allowNetInvestmentOciReversal,
      )
    : false;
  const statusLabel = row
    ? t.has(`lifecycle.${row.status}`)
      ? t(`lifecycle.${row.status}`)
      : row.status.replaceAll("_", " ")
    : "";
  return (
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
            closeHref={mergeHref("/accounting/changes", sp, {
              change: undefined,
              drawerReturn: undefined,
            })}
            title={eventTitle}
            description={`${row.subject_label} · ${row.subsidiary_name}`}
            size="2xl"
          >
            <div className="space-y-5">
              <Badge>{statusLabel}</Badge>
              <p>
                {t("lifecycle.effectiveOn", { date: row.effective_on })} ·{" "}
                {t("lifecycle.proposedBy", { name: row.proposer_name })}
              </p>
              <p>{row.reason}</p>
              {row.approver_name ? (
                <p>
                  {t("lifecycle.independentDecision", {
                    name: row.approver_name,
                  })}
                </p>
              ) : null}
              {row.before_state.preview &&
              typeof row.before_state.preview === "object" &&
              !Array.isArray(row.before_state.preview) ? (
                <section className="space-y-2">
                  <h3 className="font-semibold">{t("lifecycle.proposedImpact")}</h3>
                  <ChangeFacts value={row.before_state.preview as Record<string, unknown>} />
                </section>
              ) : null}
              {row.domain === "sales" ? (
                <section className="space-y-2">
                  <h3 className="font-semibold">{t("lifecycle.proposedImpact")}</h3>
                  <ChangeEvidence value={row.before_state} names={referenceNames} />
                </section>
              ) : null}
              <section className="space-y-2">
                <h3 className="font-semibold">{t("lifecycle.proposedTerms")}</h3>
                {row.operation === "bom_revision_activation" ? (
                  <BomRevisionEvidence
                    before={row.before_state}
                    after={row.payload}
                    names={referenceNames}
                  />
                ) : row.operation === "routing_revision_activation" ? (
                  <RoutingRevisionEvidence evidence={row.before_state} names={referenceNames} />
                ) : (
                  <ChangeEvidence value={row.payload} names={referenceNames} />
                )}
              </section>
              {["revenue", "asset", "consolidation"].includes(row.domain) ? (
                <section className="space-y-2">
                  <h3 className="font-semibold">{t("lifecycle.bookAllocations")}</h3>
                  <ChangeEvidence
                    value={row.before_state.preview ?? row.before_state.previews}
                    names={referenceNames}
                  />
                </section>
              ) : null}
              {row.result ? (
                <section className="space-y-2">
                  <h3 className="font-semibold">{t("lifecycle.appliedResult")}</h3>
                  <ChangeFacts value={row.result} />
                  {Array.isArray(row.result.entryIds)
                    ? row.result.entryIds.map((entry) => (
                        <p key={String(entry)}>
                          <JournalEntryLink className="underline" entryId={String(entry)}>
                            {t("lifecycle.adjustmentJournal")}
                          </JournalEntryLink>
                        </p>
                      ))
                    : null}
                </section>
              ) : null}
              {row.domain === "revenue" ? (
                <Link className="underline" href={`/revenue?contract=${row.subject_id}`}>
                  {t("lifecycle.openContract")}
                </Link>
              ) : null}
              {row.domain === "asset" ? (
                <Link className="underline" href={`/assets?asset=${row.subject_id}`}>
                  {t("lifecycle.openAsset")}
                </Link>
              ) : null}
              {row.domain === "lease" ? (
                <Link className="underline" href={`/assets/leases?lease=${row.subject_id}`}>
                  {t("lifecycle.openLease")}
                </Link>
              ) : null}
              {row.domain === "asset" &&
              row.status === "applied" &&
              ["partial_disposal", "intercompany_transfer"].includes(row.operation) &&
              can(auth, "assets.manage") ? (
                <ReverseAssetChange id={row.id} effectiveOn={row.effective_on} />
              ) : null}
              {row.domain === "consolidation" &&
              ["loss_of_control", "net_investment_oci"].includes(row.operation) &&
              row.status === "applied" &&
              can(auth, "close.run") ? (
                <ReverseAssetChange
                  id={row.id}
                  domain="consolidation"
                  operation={row.operation}
                  effectiveOn={row.effective_on}
                />
              ) : null}
              {row.domain === "consolidation" ? (
                <Link
                  className="underline"
                  href={`/admin/setup/subsidiary-ownership-interests?row=${row.subject_id}`}
                >
                  {t("lifecycle.openOwnership")}
                </Link>
              ) : null}
              {decisionGate ? (
                <ChangeGateDecision
                  gateId={decisionGate.id}
                  canAct={decisionGate.canAct}
                  awaitingAnother={decisionGate.sodBlocked}
                  signatureRequired={decisionGate.signatureRequired}
                  canDelegate={delegateUsers.length > 0}
                  users={delegateUsers}
                />
              ) : null}
              <ChangeActions
                id={row.id}
                status={row.status}
                canSubmit={
                  featureAllowed &&
                  can(auth, row.domain === "provision" ? "gl.manage" : permission) &&
                  row.submitted_by === auth.user.id
                }
                canApply={
                  featureAllowed &&
                  can(auth, permission) &&
                  (row.domain !== "manufacturing" ||
                    (row.operation === "work_order_loss_disposition" && can(auth, "items.post")) ||
                    (auth.allowedSubsidiaryIds === null &&
                      ((row.operation === "bom_revision_activation" &&
                        can(auth, "admin.setup.manage")) ||
                        row.operation === "routing_revision_activation" ||
                        (row.operation === "standard_cost_rollup" &&
                          can(auth, "items.post") &&
                          can(auth, "items.manage")))))
                }
              />
            </div>
          </UrlDrawer>
        ) : undefined
      }
    />
  );
}

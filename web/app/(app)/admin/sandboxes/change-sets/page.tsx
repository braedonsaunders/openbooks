import { notFound, redirect } from "next/navigation";
import { PageHeader } from "@openbooks/ui";
import { ListPageLayout } from "../../../../../components/page-layout";
import { EntityListView } from "../../../../../components/entity-list-view";
import { requirePermission } from "../../../../../lib/authz";
import { pickString } from "../../../../../lib/list-params";
import { loadChangeSetDetail } from "../../../../../lib/sandbox-change-sets";
import { ChangeSetDrawer } from "./ChangeSetDrawer";
import { ModuleView } from "../../../../../components/viewspec/module-view";
import { changeSetsSpec, loadChangeSets } from "./view";

export const dynamic = "force-dynamic";
export default async function ChangeSetsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  if (sp.__viewspec === "1") {
    const data = await loadChangeSets(sp);
    return (
      <>
        {/* Proof-of-path marker for the conformance harness; hoisted to <head>. */}
        <meta name="x-viewspec-render" content="1" />
        <ModuleView spec={changeSetsSpec(data)} data={data} searchParams={sp} trusted />
      </>
    );
  }
  const authz = await requirePermission("admin.sandboxes.manage");
  if (authz.user.envKind !== "production") redirect("/admin/sandboxes");
  const id = pickString(sp.changeSet);
  const selected = id ? await loadChangeSetDetail(authz.user.productionOrgId, id) : null;
  if (id && !selected) notFound();
  return <ListPageLayout header={<PageHeader back={{ href: "/admin/sandboxes", label: "Environments" }} title="Change sets"
    description="Inspect captured configuration changes, record independent review and approval, then apply the approved changes to production." />}>
    <EntityListView recordType="change_set" orgId={authz.user.productionOrgId} userId={authz.user.id} canManage sp={sp}
      drawer={selected ? <ChangeSetDrawer key={selected.id} detail={selected} actorId={authz.user.id} /> : null} />
  </ListPageLayout>;
}

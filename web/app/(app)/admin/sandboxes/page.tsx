import { PageHeader } from "@openbooks/ui";
import { listSandboxes } from "@openbooks/engine/src/sandbox/index.ts";
import { ListPageLayout } from "../../../../components/page-layout";
import { requirePermission } from "../../../../lib/authz";
import { SandboxManager, type SandboxRow } from "./SandboxManager";

export const dynamic = "force-dynamic";

export default async function SandboxesPage() {
  const authz = await requirePermission("admin.sandboxes.manage");
  // Always manage sandboxes against the home production org.
  const rows = (await listSandboxes(authz.user.productionOrgId)) as unknown as SandboxRow[];

  return (
    <ListPageLayout
      header={
        <PageHeader
          title="Environments"
          description="Create and manage sandbox copies of your production books — instant to clone, isolated, refreshable, and promotable back to production."
        />
      }
    >
      {authz.user.envKind !== "production" ? (
        <p className="text-sm text-amber-700 dark:text-amber-400">
          You are currently inside a sandbox. Exit to production to manage environments.
        </p>
      ) : (
        <SandboxManager sandboxes={rows} />
      )}
    </ListPageLayout>
  );
}

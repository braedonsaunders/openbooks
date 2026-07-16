import { PageHeader } from "@openbooks/ui";
import { ListPageLayout } from "../../../../components/page-layout";
import { requireSuperAdmin, superAdminData } from "../../../../lib/super-admin";
import { SuperAdminConsole } from "./SuperAdminConsole";

export const dynamic = "force-dynamic";

export default async function SuperAdminPage() {
  await requireSuperAdmin();
  const data = await superAdminData();

  return (
    <ListPageLayout
      header={
        <PageHeader
          title="Super admin"
          description="Cross-tenant operations: every organization and sandbox, who can access what, and who holds super admin."
        />
      }
    >
      <SuperAdminConsole orgs={data.orgs} users={data.users} grants={data.grants} />
    </ListPageLayout>
  );
}

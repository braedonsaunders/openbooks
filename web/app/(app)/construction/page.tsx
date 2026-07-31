import { redirect } from "next/navigation";
import { requirePermission } from "../../../lib/authz";
import { requireProjectsFeature } from "../../../lib/projects-gate";

export const dynamic = "force-dynamic";

/**
 * Backward-compatible route for bookmarks and audit evidence created before
 * Applications for Payment moved into the project record's Billing tab.
 */
export default async function ConstructionPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const authz = await requirePermission("ar.read").catch(() => null);
  if (!authz) redirect("/dashboard");
  await requireProjectsFeature(authz.user.orgId);

  const params = await searchParams;
  const projectId = typeof params.projectId === "string" ? params.projectId : null;
  if (projectId) {
    redirect(`/projects?project=${encodeURIComponent(projectId)}&projectTab=billing`);
  }
  redirect("/projects");
}

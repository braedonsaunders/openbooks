import { redirect } from "next/navigation";
import { getAuthz } from "../../../../lib/authz";
import { accessDeniedHref } from "../../../../lib/gate-targets";
import { resolvedFeatureState } from "../../../../lib/features";
import { setupRail } from "../../../../lib/setup/rail";
import { setupRailFlags } from "../../../../lib/setup/rail-flags";

export const dynamic = "force-dynamic";

/** Open the existing configuration workspace through its authorized rail. */
export default async function SetupPage() {
  const authz = await getAuthz();
  if (!authz) redirect("/login");
  const features = await resolvedFeatureState(authz.user.orgId);
  const flags = await setupRailFlags(authz, features);
  if (flags.canManageSetup && authz.allowedSubsidiaryIds === null) {
    redirect("/admin/setup/company");
  }
  const target = setupRail(flags)
    .groups.filter((group) => group.key !== "company")
    .flatMap((group) => group.items)[0];
  if (target) redirect(target.href);
  redirect(accessDeniedHref({ permission: "admin.setup.manage" }));
}

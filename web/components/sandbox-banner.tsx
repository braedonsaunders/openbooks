import { getTranslations } from "next-intl/server";
import { SandboxExitButton } from "./sandbox-exit-button";

/**
 * Persistent sandbox banner. Rendered by the app layout whenever the session is
 * inside a sandbox, so a user can never mistake a sandbox for production. The
 * exit button switches back to the production organization the sandbox was
 * cloned from.
 */
export async function SandboxBanner({
  name,
  productionOrgId,
  kind = "sandbox",
}: {
  name?: string;
  productionOrgId: string;
  kind?: "sandbox" | "preview";
}) {
  // Sample companies are independent tenants, with no production sandbox to exit.
  if (kind === "preview") return null;
  const t = await getTranslations("shell.sandboxBanner");
  const environment = t("sandbox");
  return (
    <div className="flex items-center justify-center gap-3 bg-amber-500 px-4 py-1.5 text-center text-sm font-medium text-amber-950">
      <span>{name ? t("withName", { environment, name }) : t("withoutName", { environment })}</span>
      <SandboxExitButton productionOrgId={productionOrgId} label={t("exit")} />
    </div>
  );
}

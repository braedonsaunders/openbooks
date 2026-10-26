"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button } from "@openbooks/ui";
import { readApiErrorMessage } from "@/lib/api-error";

/**
 * One pack's install action for the Agents library card footer (the
 * InstallListingButton precedent): installing PUTs the engine default policy
 * the loader hands over with enabled flipped on, so install and configure
 * share the same command and audit shape. Copy resolves here via hooks on
 * the existing `setup.agents` keys.
 */
export function AgentsPackInstallButton({
  agentKey,
  policy,
  packTitle,
  installed,
  featureEnabled,
}: {
  agentKey: string;
  policy: Record<string, unknown>;
  packTitle: string;
  installed: boolean;
  featureEnabled: boolean;
}) {
  const t = useTranslations("admin");
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function install() {
    if (pending || installed) return;
    setPending(true);
    try {
      const res = await fetch(`/api/admin/setup/agents/${agentKey}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...policy, enabled: true }),
      });
      if (!res.ok) {
        // The body parses from a clone so the feature_disabled code keeps
        // its mapped copy while every other refusal reads through the
        // shared helper with message, remedy and code.
        const payload = (await res
          .clone()
          .json()
          .catch(() => ({}))) as { error?: string };
        throw new Error(
          payload.error === "feature_disabled"
            ? t("setup.agents.overview.featureOffError")
            : await readApiErrorMessage(res, t("setup.agents.library.installFailed")),
        );
      }
      toast.success(t("setup.agents.library.installedToast", { name: packTitle }));
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  if (installed) return null;
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={!featureEnabled || pending}
      onClick={() => void install()}
    >
      {t("setup.agents.library.install")}
    </Button>
  );
}

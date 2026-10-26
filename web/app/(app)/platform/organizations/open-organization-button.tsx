"use client";

import { useTransition } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { ExternalLink } from "lucide-react";
import { Button } from "@openbooks/ui";
import { switchWorkspace, workspaceSwitchMessageKey } from "../../../../lib/workspace-switch";

/** Opens the organization as the active workspace; the server decides access. */
export function OpenOrganizationButton({ orgId }: { orgId: string }) {
  const tSwitch = useTranslations("shell.accountMenu");
  const t = useTranslations("platform.tenants");
  const [pending, start] = useTransition();
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        start(async () => {
          try {
            await switchWorkspace(orgId);
          } catch (error) {
            toast.error(tSwitch(workspaceSwitchMessageKey(error)));
          }
        })
      }
    >
      {t("open")} <ExternalLink size={14} />
    </Button>
  );
}

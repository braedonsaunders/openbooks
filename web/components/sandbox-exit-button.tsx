"use client";

import { useTransition } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { switchWorkspace, workspaceSwitchMessageKey } from "../lib/workspace-switch";

/** Returns from a sandbox to the production organization it was cloned from. */
export function SandboxExitButton({
  productionOrgId,
  label,
}: {
  productionOrgId: string;
  label: string;
}) {
  const tSwitch = useTranslations("shell.accountMenu");
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        start(async () => {
          try {
            await switchWorkspace(productionOrgId);
          } catch (error) {
            toast.error(tSwitch(workspaceSwitchMessageKey(error)));
          }
        })
      }
      className="rounded border border-amber-950/30 px-2 py-0.5 text-xs font-semibold hover:bg-amber-950/10 disabled:opacity-60"
    >
      {label}
    </button>
  );
}

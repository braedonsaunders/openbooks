"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Button, type ButtonProps } from "@openbooks/ui";
import type { PlatformMutationResult } from "../actions";

export function PlatformMutationButton({
  action,
  success,
  children,
  ...props
}: Omit<ButtonProps, "onClick"> & {
  // Server actions resolve their refusal as { ok: false }: a thrown error
  // would surface in production as a generic React Flight digest, so the
  // action never throws and the named message toasts here instead.
  action: () => Promise<PlatformMutationResult>;
  success: string;
}) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      {...props}
      disabled={pending || props.disabled}
      onClick={() =>
        startTransition(async () => {
          try {
            const result = await action();
            if (result.ok) toast.success(success);
            else toast.error(result.message);
          } catch {
            toast.error("The platform change could not be completed");
          }
        })
      }
    >
      {pending ? "Working…" : children}
    </Button>
  );
}

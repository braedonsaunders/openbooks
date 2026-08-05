"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Button, type ButtonProps } from "@openbooks/ui";

export function PlatformMutationButton({
  action,
  success,
  children,
  ...props
}: Omit<ButtonProps, "onClick"> & {
  action: () => Promise<void>;
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
            await action();
            toast.success(success);
          } catch (error) {
            toast.error(
              error instanceof Error
                ? error.message
                : "The platform change could not be completed",
            );
          }
        })
      }
    >
      {pending ? "Working…" : children}
    </Button>
  );
}

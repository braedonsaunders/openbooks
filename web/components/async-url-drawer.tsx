"use client";

import type { ComponentProps, ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Button, Drawer, EmptyState, Skeleton, UrlDrawer } from "@openbooks/ui";

type AsyncDrawerState = {
  pending: boolean;
  error?: string | null;
  onRetry?: () => void;
  children: ReactNode;
};

function AsyncDrawerBody({ pending, error, onRetry, children }: AsyncDrawerState) {
  const t = useTranslations("common");
  return error ? (
    <EmptyState
      title={t("feedback.loadFailed")}
      description={error}
      action={
        onRetry ? (
          <Button variant="outline" onClick={onRetry}>
            {t("actions.retry")}
          </Button>
        ) : undefined
      }
    />
  ) : pending ? (
    <div aria-busy="true" className="space-y-3">
      {Array.from({ length: 5 }, (_, index) => (
        <Skeleton key={index} className="h-12 w-full" />
      ))}
    </div>
  ) : (
    children
  );
}

/** Locally controlled commands retain the same native dialog through loading,
 * refusal and retry, with dismissal owned by their command host. */
export function AsyncDrawer({
  pending,
  error,
  onRetry,
  children,
  ...drawer
}: Omit<ComponentProps<typeof Drawer>, "children"> & AsyncDrawerState) {
  return (
    <Drawer {...drawer}>
      <AsyncDrawerBody pending={pending} error={error} onRetry={onRetry}>
        {children}
      </AsyncDrawerBody>
    </Drawer>
  );
}

/** One dialog owns the complete request lifecycle. Only its body changes
 * when data arrives, so focus, scroll lock and the entrance animation persist. */
export function AsyncUrlDrawer({
  pending,
  error,
  onRetry,
  children,
  ...drawer
}: Omit<ComponentProps<typeof UrlDrawer>, "children" | "openKey"> & {
  /** The requested record's identity; never a loading or error phase. */
  openKey: string;
} & AsyncDrawerState) {
  return (
    <UrlDrawer {...drawer}>
      <AsyncDrawerBody pending={pending} error={error} onRetry={onRetry}>
        {children}
      </AsyncDrawerBody>
    </UrlDrawer>
  );
}

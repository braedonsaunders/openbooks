"use client";

import {
  Component,
  Suspense,
  useCallback,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import {
  UrlDrawerPresentationContext,
  type UrlDrawerProps,
  Skeleton,
  Button,
  EmptyState,
} from "@openbooks/ui";
import { useTranslations } from "next-intl";
import { AsyncUrlDrawer } from "./async-url-drawer";

/** Existing native record renderers supply their chrome and body to one
 * persistent shell, including records assembled by server components. */
export function AsyncServerDrawer({
  children,
  resourceKey,
  ...props
}: ComponentProps<typeof AsyncUrlDrawer> & { resourceKey?: string }) {
  const t = useTranslations("common");
  const [record, setRecord] = useState<{ key: string; props: UrlDrawerProps } | null>(null);
  const present = useCallback(
    (next: UrlDrawerProps | null) => {
      setRecord(next ? { key: props.openKey, props: next } : null);
    },
    [props.openKey],
  );
  const presentation = record?.key === props.openKey ? record.props : null;
  return (
    <AsyncUrlDrawer
      {...props}
      {...presentation}
      open={props.open}
      openKey={props.openKey}
      closeHref={props.closeHref}
      pending={props.pending}
      error={props.error}
      onRetry={props.onRetry}
    >
      <UrlDrawerPresentationContext.Provider value={present}>
        <DrawerRenderBoundary
          key={resourceKey ?? props.openKey}
          fallback={
            <EmptyState
              title={t("feedback.loadFailed")}
              action={
                props.onRetry ? (
                  <Button variant="outline" onClick={props.onRetry}>
                    {t("actions.retry")}
                  </Button>
                ) : undefined
              }
            />
          }
        >
          <Suspense fallback={<PendingBody />}>{children}</Suspense>
        </DrawerRenderBoundary>
      </UrlDrawerPresentationContext.Provider>
    </AsyncUrlDrawer>
  );
}

function PendingBody(): ReactNode {
  return (
    <div aria-busy="true" className="space-y-3 animate-pulse">
      {Array.from({ length: 5 }, (_, index) => (
        <Skeleton key={index} className="h-12 w-full" />
      ))}
    </div>
  );
}

/** A refusal while streaming a record stays inside its owning dialog. */
class DrawerRenderBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error("[drawer] record rendering failed", error);
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

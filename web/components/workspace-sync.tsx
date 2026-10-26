"use client";

import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { confirmDialog } from "../lib/confirm";
import {
  isSwitchingWorkspace,
  reloadWorkspaceDocument,
  WORKSPACE_CHANNEL,
} from "../lib/workspace-switch";

/**
 * Keeps an open tab honest about which workspace it acts in. The active
 * workspace is a session cookie, so switching in one tab moves every tab's
 * requests; a tab still showing the previous workspace must not keep accepting
 * input. A switch announced on WORKSPACE_CHANNEL, or found when the tab becomes
 * visible again, prompts before anything else happens in this tab; both answers
 * load a fresh document in the current workspace, and the page stays visible
 * behind the prompt until the person chooses. A page reached through history
 * after a switch is reloaded.
 */
export function WorkspaceSync({ orgId, name }: { orgId: string; name: string }) {
  const t = useTranslations("shell");
  const prompted = useRef(false);

  useEffect(() => {
    let disposed = false;
    const markStale = (activeOrgId: unknown) => {
      if (disposed || isSwitchingWorkspace()) return;
      if (typeof activeOrgId !== "string" || activeOrgId === orgId || prompted.current) return;
      prompted.current = true;
      void confirmDialog({
        title: t("workspaceSync.title"),
        message: t("workspaceSync.description", { name }),
        confirmLabel: t("workspaceSync.reload"),
        cancelLabel: t("routeState.backToDashboard"),
      }).then((reload) => {
        reloadWorkspaceDocument(reload ? undefined : "/dashboard");
      });
    };
    const channel =
      typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(WORKSPACE_CHANNEL);
    if (channel)
      channel.onmessage = (event: MessageEvent<{ orgId?: unknown }>) =>
        markStale(event.data?.orgId);

    const activeOrgId = async (): Promise<unknown> => {
      const response = await fetch("/api/me/workspace", { cache: "no-store" });
      return response.ok ? ((await response.json()) as { orgId?: unknown }).orgId : undefined;
    };
    const check = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        markStale(await activeOrgId());
      } catch {
        // Offline or mid-deploy: the next visibility change checks again.
      }
    };
    // A page reached through history can be the document rendered for
    // whichever workspace was active when it was left, restored from the
    // back/forward cache or the HTTP cache. Going back is a navigation, so a
    // page from another workspace is simply loaded afresh.
    const reloadIfOtherWorkspace = async () => {
      try {
        const current = await activeOrgId();
        if (!disposed && typeof current === "string" && current !== orgId)
          reloadWorkspaceDocument();
      } catch {
        // Offline: the visibility check covers the next return to this tab.
      }
    };
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) void reloadIfOtherWorkspace();
    };
    const [navigation] = performance.getEntriesByType(
      "navigation",
    ) as PerformanceNavigationTiming[];
    if (navigation?.type === "back_forward") void reloadIfOtherWorkspace();
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
    window.addEventListener("pageshow", restored);
    return () => {
      disposed = true;
      channel?.close();
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("focus", check);
      window.removeEventListener("pageshow", restored);
    };
  }, [orgId, name, t]);

  return null;
}

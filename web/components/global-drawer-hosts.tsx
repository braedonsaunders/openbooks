"use client";

import dynamic from "next/dynamic";
import { useEffect, useState, type ComponentProps } from "react";
import { useSearchParams } from "next/navigation";
import { useReportOverlay } from "./navigation-provider";

/**
 * The shell's URL-driven overlays. Their record drawers compose most of the
 * party, transaction and report UI, so the shell mounts each host only once
 * the URL first asks for it and fetches the code while the browser is idle.
 * A host stays mounted after its first open so its close transition runs.
 */

const loadPartyHost = () => import("./global-party-drawer-host");
const loadReportHost = () => import("./global-report-drawer-host");

const PartyDrawerHost = dynamic(() => loadPartyHost().then((m) => m.GlobalPartyDrawerHost), {
  ssr: false,
});
const ReportDrawerHost = dynamic(() => loadReportHost().then((m) => m.GlobalReportDrawerHost), {
  ssr: false,
});

function useOpenedOnce(requested: boolean, preload: () => Promise<unknown>): boolean {
  const [opened, setOpened] = useState(requested);
  if (requested && !opened) setOpened(true);
  useEffect(() => {
    if (opened) return;
    const idle =
      window.requestIdleCallback ?? ((callback: () => void) => window.setTimeout(callback, 1));
    const cancel = window.cancelIdleCallback ?? window.clearTimeout;
    const handle = idle(() => void preload());
    return () => cancel(handle);
  }, [opened, preload]);
  return opened;
}

export function GlobalPartyDrawer(props: ComponentProps<typeof PartyDrawerHost>) {
  const opened = useOpenedOnce(useSearchParams().has("relatedParty"), loadPartyHost);
  return opened ? <PartyDrawerHost {...props} /> : null;
}

/**
 * Every URL key whose overlay the report host renders: the drill list, a
 * native record drawer, a posted journal entry (`txn`, set by TxnLink and
 * JournalEntryLink) and an account register.
 */
const REPORT_HOST_KEYS = ["reportDrill", "reportRecord", "txn", "accountRegister"] as const;

/** Whether the URL asks for an overlay the shell-level report host renders. */
export function reportDrawerRequested(search: string): boolean {
  const params = new URLSearchParams(search);
  return REPORT_HOST_KEYS.some((key) => params.has(key));
}

export function GlobalReportDrawer() {
  const { search } = useReportOverlay();
  const opened = useOpenedOnce(reportDrawerRequested(search), loadReportHost);
  return opened ? <ReportDrawerHost /> : null;
}

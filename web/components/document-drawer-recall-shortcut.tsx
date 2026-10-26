"use client";

import { useState } from "react";
import { useShortcuts } from "./shortcuts/shortcut-provider";

/**
 * Ctrl+Alt+L (⌃⌥L) fills the open document from the party's last one, while
 * the recall offer is showing. Scoped to the drawer the offer renders in.
 */
export function RecallShortcut({
  enabled,
  onRecall,
  label,
}: {
  enabled: boolean;
  onRecall: () => void;
  label: string;
}) {
  const [marker, setMarker] = useState<HTMLSpanElement | null>(null);
  useShortcuts([
    {
      id: "formRecallLast",
      label,
      binding: { modifier: "chord", code: "KeyL" },
      scope: "form",
      allowInEditable: true,
      container: () => marker?.closest('[role="dialog"]') ?? marker?.parentElement ?? null,
      enabled: () => enabled,
      run: onRecall,
    },
  ]);
  return <span ref={setMarker} hidden />;
}

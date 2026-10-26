"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";

/**
 * Opens a body-owned drawer from the page header's primary action.
 *
 * The header and the workspace render in separate slots, so the action is a
 * link to the same page with `?<param>=1`; the workspace follows that request
 * into its own drawer state, keeping drafts and picker state intact. Closing
 * the drawer withdraws the parameter from the address without a reload, so a
 * refresh or Back never reopens a drawer the operator dismissed, and the next
 * header click opens it again.
 */
export function useHeaderAction(param: string): [boolean, (open: boolean) => void] {
  const params = useSearchParams();
  const requested = params?.get(param) === "1";
  const [open, setOpen] = useState(requested);
  const [seen, setSeen] = useState(requested);
  if (requested !== seen) {
    setSeen(requested);
    if (requested) setOpen(true);
  }
  function change(next: boolean) {
    setOpen(next);
    if (!next && requested) {
      const url = new URL(window.location.href);
      url.searchParams.delete(param);
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }
  }
  return [open, change];
}

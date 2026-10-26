"use client";

import Link from "next/link";
import type { ComponentProps } from "react";
import { hasDrawerRouteGuard, queryDrawerRouteGuard } from "@openbooks/ui";
import { isListDrawerHrefChange } from "../lib/list/drawer-routes";

/** Retain normal link behavior for modified clicks, new tabs and full-page
 * records. Only an existing record over the same list uses native history.
 *
 * A switch underneath an open drawer asks the drawer's dirty-draft guard
 * first: a denied confirm keeps the current record (no silent loss), an
 * allowed one retargets the URL and the drawer remounts onto the new
 * record. The consult is async after a synchronous preventDefault, so the
 * browser never follows the href itself.
 */
export function ListDrawerLink(props: ComponentProps<typeof Link>) {
  return (
    <Link
      {...props}
      prefetch={false}
      onClick={(event) => {
        props.onClick?.(event);
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey ||
          props.target === "_blank"
        )
          return;
        const href = typeof props.href === "string" ? props.href : null;
        if (!href || !isListDrawerHrefChange(window.location.href, href)) return;
        event.preventDefault();
        // Unguarded lists keep the historic synchronous switch; only a drawer
        // with a dirty-draft guard takes the async confirm path.
        if (!hasDrawerRouteGuard()) {
          window.history.pushState(null, "", href);
          return;
        }
        void (async () => {
          let allowed = false;
          try {
            allowed = await queryDrawerRouteGuard();
          } catch {
            // A guard that errors fails closed: stay on the current record
            // rather than risk discarding an unconfirmed draft.
            allowed = false;
          }
          if (allowed) window.history.pushState(null, "", href);
        })();
      }}
    />
  );
}

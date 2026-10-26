"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, Plus } from "lucide-react";
import { Button, Popover } from "@openbooks/ui";
import { documentCreateHref, isDocumentCreateKind } from "../lib/document-kinds";

export interface NewDocumentItem {
  kind: string;
  label: string;
  /** A related record created on its own surface (for example Receive
   *  payment on the receivables cockpit): the item navigates here instead
   *  of opening the document drawer for `kind`. */
  href?: string;
}

/**
 * "New <transaction>" dropdown: URL-only navigation to `?doc=new&kind=`,
 * which renders the tenant-customizable DocumentDrawer in createMode over
 * an in-memory payload. Opening New allocates nothing — no document, no
 * number, no lines, no audit row; the first write happens on explicit Save
 * (POST /api/documents), and Cancel/close writes nothing.
 */
export function NewDocumentButton({
  items,
  basePath,
  triggerLabel,
}: {
  items: NewDocumentItem[];
  basePath: string;
  triggerLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  function create(item: NewDocumentItem) {
    setOpen(false);
    // A blank href is absent, not a target: pushing '' would reload the list
    // in place — a dead click with no drawer and no error.
    router.push(item.href || documentCreateHref(basePath, item.kind));
  }

  // Only navigable items survive: a misconfigured kind must withdraw its
  // control rather than render a button that throws on click (a dead New
  // with no drawer and no error). Href items navigate elsewhere, so they
  // are kept regardless of kind.
  const navigable = items.filter(
    (item) => (item.href ?? "") !== "" || isDocumentCreateKind(item.kind),
  );

  // No creatable kind → no control: never a dropdown that opens empty.
  if (navigable.length === 0) return null;

  // Single kind → plain button (no dropdown).
  if (navigable.length === 1) {
    const only = navigable[0]!;
    return (
      <Button type="button" onClick={() => create(only)}>
        <Plus size={15} /> {only.label}
      </Button>
    );
  }

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      trigger={
        <Button type="button" onClick={() => setOpen((v) => !v)}>
          <Plus size={15} /> {triggerLabel}
          <ChevronDown size={14} className="opacity-60" />
        </Button>
      }
    >
      <div className="p-1">
        {navigable.map((item) => (
          <button
            // Href entries share their kind with the plain create entry — key
            // on the destination so the menu keeps every fast path.
            key={item.href ?? item.kind}
            type="button"
            onClick={() => create(item)}
            className="flex w-full items-center rounded px-2.5 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-50 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            {item.label}
          </button>
        ))}
      </div>
    </Popover>
  );
}

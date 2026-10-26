import Link from "next/link";
import { RemittancesView } from "./RemittancesView";

/**
 * The remittance list's shared sections.
 *
 * The page body is one client list — the period filter on the shared list
 * toolbar, one row per destination (each with its conditional filing-account
 * badge, existing-bill links, and create-bill vs assign-vendor action), and
 * the empty state. Rows carry conditional pairs a spec cannot express, so the
 * spec places the list through a widget and the page and the widget registry
 * share this one implementation. Display strings resolve inside the client
 * component via useTranslations/useMoney, identically wherever it renders.
 */

export { RemittancesView };

/** The AP footnote under the list. A link over static copy is a composite cell, so it lives here. */
export function RemittanceApNote({ note, linkLabel }: { note: string; linkLabel: string }) {
  return (
    <p className="mt-4 text-xs text-slate-400 dark:text-slate-500">
      {note}{" "}
      <Link className="underline" href={"/ap/bills" as never}>
        {linkLabel}
      </Link>
    </p>
  );
}

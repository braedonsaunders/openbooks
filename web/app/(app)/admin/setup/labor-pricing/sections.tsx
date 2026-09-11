import { BookOpen } from "lucide-react";
import { Button } from "@openbooks/ui";
import Link from "next/link";
import { LaborBillRateCards } from "../labor-costing/LaborBillRateCards";

/**
 * Pieces of the labor-pricing page that the page and the widget registry share.
 *
 * The whole page is one client island: the toolbar (search, two selects,
 * create button), the hand-rolled rate-book table, the pager and the drawer
 * all live inside `LaborBillRateCards`, whose selects navigate with
 * `router.push`, whose rows open on click, and whose drawer edits drafts in
 * local state before PUT-ing them. None of that is expressible as spec
 * blocks — no table variant matches the hand-rolled markup, and `Select`
 * navigation plus row-click routing are client behavior. So the spec places
 * one `labor-pricing-view` widget and the loader binds every prop verbatim
 * from the native page: rows, pickers, currencies, the resolved form layout,
 * and the customization flag.
 *
 * The header above the island (h2 + description + docs ghost button) uses
 * the same docs-button treatment as the customization designer header, so it
 * goes through the existing `docs-link-button` widget rather than a new one.
 */

export type LaborPricingViewProps = Omit<
  Parameters<typeof LaborBillRateCards>[0],
  "currentParams"
> & {
  currentParams: Record<string, string | string[] | undefined>;
};

/** The rate-book list, toolbar, pager and drawer — the page's only body. */
export function LaborPricingView(props: LaborPricingViewProps) {
  return <LaborBillRateCards {...props} />;
}

/**
 * The page heading: hand-rolled h2 + description with the ghost docs action.
 * Not the shared `PageHeader` (whose title row, back-link slot and sticky
 * geometry are a different element) and not `docs-link-button` (outline, no
 * space after the icon). The ghost treatment with the spaced icon is the
 * labor pages' own header — labor-costing renders the same shape — so it
 * stays a page-owned component shared by the page and the widget registry.
 */
export function LaborPricingHeading({
  title,
  description,
  docsHref,
  docsLabel,
}: {
  title: string;
  description: string;
  docsHref: string;
  docsLabel: string;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
          {title}
        </h2>
        <p className="max-w-4xl text-sm text-slate-500 dark:text-slate-400">
          {description}
        </p>
      </div>
      <Button asChild variant="ghost" size="sm">
        <Link href={docsHref as never}>
          <BookOpen size={14} aria-hidden /> {docsLabel}
        </Link>
      </Button>
    </div>
  );
}

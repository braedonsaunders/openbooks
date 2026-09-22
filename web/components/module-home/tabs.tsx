"use client";

import { useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { ChevronDown } from "lucide-react";
import { cn, Popover } from "@openbooks/ui";
import { visibleTopNavGroupCount } from "../../lib/top-nav-overflow";
import type { ModuleHomeTab } from "./tab-types";

/**
 * THE subtab strip. One component for every tabbed switch in the product —
 * the nav-group route strip in a page header (Purchasing · Accounts Payable ·
 * Expenses), and the in-page view switch above a list (Requests · Calendar).
 * There is deliberately no second implementation: a page that grows tabs
 * renders this, or it does not have tabs.
 *
 * Two things it must do that a plain row of links cannot:
 *
 *   • FIT. The HRM group carries fourteen routes. Rendered as a rigid strip
 *     it measured 1358px and crushed the page title to ZERO width on every
 *     page in the module — the title element was still there, still 32px
 *     tall, and 0px wide. So the strip measures itself, shows the leading
 *     tabs that fit, and folds the rest into a More menu. The overflow
 *     arithmetic is `visibleTopNavGroupCount`, shared with the top nav, so
 *     the two strips cannot drift on the one calculation either could get
 *     wrong.
 *
 *   • MATCH THE BUTTONS BESIDE IT. The track is 40px, the same as a
 *     page-header primary button, and the pills are 36px — a 2px inset
 *     rather than the 4px that made the active pill read as visibly shorter
 *     than the button next to it.
 *
 * An active tab that lands in the overflow is pulled forward to the last
 * visible slot, so "where am I" is never hidden behind a menu.
 *
 * The strip is always the last item in a page-header action rail. This makes
 * the product rule structural: primary create/action buttons stay to its left
 * even when a page's JSX or ViewSpec happens to list the tabs first.
 */

/** Rounding headroom, in CSS pixels, for the fit test. See `recompute`. */
const SUBPIXEL_SLACK = 1;

const PILL =
  "inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-sm font-medium whitespace-nowrap transition-colors";
const PILL_ACTIVE =
  "bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-100";
const PILL_IDLE =
  "text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100";

function Count({ count, active }: { count: number; active: boolean }) {
  return (
    <span
      className={cn(
        "rounded-full px-1.5 text-xs tabular-nums",
        active
          ? "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
          : "bg-slate-200/70 text-slate-500 dark:bg-slate-700 dark:text-slate-400",
      )}
    >
      {count}
    </span>
  );
}

function Pill({ tab }: { tab: ModuleHomeTab }) {
  const active = tab.active === true;
  return (
    <Link
      href={tab.href as never}
      aria-current={active ? "page" : undefined}
      className={cn(PILL, active ? PILL_ACTIVE : PILL_IDLE)}
    >
      {tab.label}
      {typeof tab.count === "number" ? (
        <Count count={tab.count} active={active} />
      ) : null}
    </Link>
  );
}

export function ModuleHomeTabs({ tabs }: { tabs: ModuleHomeTab[] }) {
  const t = useTranslations("shell.topNav");
  const moreLabel = t("more");
  const trackRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(tabs.length);
  const [open, setOpen] = useState(false);

  useLayoutEffect(() => {
    const track = trackRef.current;
    const measure = measureRef.current;
    if (!track || !measure) return;
    let live = true;

    function recompute() {
      if (!live || !track || !measure) return;
      const widths = Array.from(
        measure.querySelectorAll<HTMLElement>('[data-tab-measure="tab"]'),
        (element) => element.getBoundingClientRect().width,
      );
      const moreWidth =
        measure
          .querySelector<HTMLElement>('[data-tab-measure="more"]')
          ?.getBoundingClientRect().width ?? 0;
      const gap =
        Number.parseFloat(window.getComputedStyle(measure).columnGap) || 0;
      // The track's own padding is not available to the pills. Measure with
      // getBoundingClientRect, not clientWidth: clientWidth is rounded to an
      // integer while the pill widths are fractional, so a strip that fits
      // EXACTLY could come up a fraction of a pixel short and fold its last
      // tab into a More menu on a page with half the row still empty — which
      // is what a two-tab view switch did.
      const style = window.getComputedStyle(track);
      const padding =
        (Number.parseFloat(style.paddingLeft) || 0) +
        (Number.parseFloat(style.paddingRight) || 0);
      const next = visibleTopNavGroupCount({
        availableWidth:
          track.getBoundingClientRect().width - padding + SUBPIXEL_SLACK,
        groupWidths: widths,
        moreWidth,
        gap,
      });
      setVisibleCount((current) => (current === next ? current : next));
    }

    recompute();
    const frame = window.requestAnimationFrame(recompute);
    const observer = new ResizeObserver(recompute);
    observer.observe(track);
    observer.observe(measure);
    window.addEventListener("resize", recompute);
    void document.fonts?.ready.then(recompute);
    return () => {
      live = false;
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", recompute);
      observer.disconnect();
    };
  }, [tabs, moreLabel]);

  if (tabs.length < 2) return null;

  // A tab the viewer is ON must never be the one hidden behind More. When the
  // active tab overflows it takes the last visible slot and the tab it
  // displaces joins the menu — the order of everything else is preserved.
  let visible = tabs.slice(0, visibleCount);
  let overflow = tabs.slice(visibleCount);
  const activeIndex = tabs.findIndex((tab) => tab.active === true);
  const activeTab = activeIndex >= 0 ? tabs[activeIndex] : undefined;
  if (activeTab && activeIndex >= visibleCount && visibleCount > 0) {
    visible = [...tabs.slice(0, visibleCount - 1), activeTab];
    overflow = tabs.filter(
      (_, i) => i >= visibleCount - 1 && i !== activeIndex,
    );
  }

  return (
    <div
      ref={trackRef}
      data-subtabs
      className={cn(
        "relative order-last flex h-10 min-w-0 max-w-full items-center gap-1 overflow-hidden rounded-lg bg-slate-100 p-0.5 dark:bg-slate-800",
        // A large route group is navigation, not the whole header. Cap it at
        // half the desktop viewport and let the component's existing,
        // measured More menu own the overflow. Small view switches keep
        // their natural width; narrow screens still get the full row.
        tabs.length >= 8 ? "w-full md:w-[min(50vw,48rem)] md:flex-none" : null,
      )}
    >
      {/* Off-screen copy at full width: the only honest source for "how wide
          would every tab be", since the rendered strip is already clipped. */}
      <div
        ref={measureRef}
        aria-hidden
        className="pointer-events-none invisible absolute flex w-max items-center gap-1"
      >
        {tabs.map((tab) => (
          <span
            key={tab.href}
            data-tab-measure="tab"
            className={cn(PILL, PILL_ACTIVE)}
          >
            {tab.label}
            {typeof tab.count === "number" ? (
              <Count count={tab.count} active />
            ) : null}
          </span>
        ))}
        <span data-tab-measure="more" className={cn(PILL, PILL_IDLE)}>
          {moreLabel}
          <ChevronDown size={14} />
        </span>
      </div>
      {visible.map((tab) => (
        <Pill key={tab.href} tab={tab} />
      ))}
      {overflow.length > 0 ? (
        <Popover
          open={open}
          onOpenChange={setOpen}
          align="end"
          className="min-w-[13rem] p-1"
          trigger={
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
              className={cn(PILL, PILL_IDLE)}
            >
              {moreLabel}
              <ChevronDown size={14} />
            </button>
          }
        >
          <div role="menu" className="flex flex-col">
            {overflow.map((tab) => (
              <Link
                key={tab.href}
                role="menuitem"
                href={tab.href as never}
                onClick={() => setOpen(false)}
                aria-current={tab.active ? "page" : undefined}
                className={cn(
                  "flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-sm transition-colors",
                  tab.active
                    ? "bg-slate-100 font-medium text-slate-900 dark:bg-slate-800 dark:text-slate-100"
                    : "text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800",
                )}
              >
                {tab.label}
                {typeof tab.count === "number" ? (
                  <span className="text-xs tabular-nums text-slate-400 dark:text-slate-500">
                    {tab.count}
                  </span>
                ) : null}
              </Link>
            ))}
          </div>
        </Popover>
      ) : null}
    </div>
  );
}

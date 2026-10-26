"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  Activity,
  AlertTriangle,
  Award,
  BadgeCheck,
  Banknote,
  BanknoteArrowUp,
  BellRing,
  BookOpen,
  BriefcaseBusiness,
  Building2,
  CalendarCheck,
  CalendarClock,
  CalendarDays,
  CalendarRange,
  ChartNoAxesCombined,
  ChartScatter,
  CheckCircle2,
  ChevronRight,
  CircleDollarSign,
  CircleHelp,
  CircleUser,
  ClipboardCheck,
  ClipboardList,
  Code2,
  Coins,
  Construction,
  Database,
  Download,
  FileText,
  Files,
  Folder,
  Gauge,
  Gift,
  GitBranch,
  GraduationCap,
  Handshake,
  HardHat,
  HeartHandshake,
  HeartPulse,
  History,
  Inbox,
  KeyRound,
  Landmark,
  Layers,
  LayoutGrid,
  LibraryBig,
  Link2,
  ListChecks,
  Mail,
  MapPin,
  Megaphone,
  MessageSquare,
  MessagesSquare,
  Network,
  NotebookPen,
  Package,
  PanelLeft,
  Plus,
  QrCode,
  Radiation,
  Rss,
  Scale,
  ScrollText,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Split,
  Star,
  Tag,
  Target,
  Timer,
  TrendingUp,
  Truck,
  Upload,
  UserRoundCheck,
  UserRoundCog,
  UserRoundMinus,
  UserRoundSearch,
  Users,
  Wallet,
  Workflow,
  Wrench,
  Clock,
  Factory,
  Map as MapIcon,
  Percent,
  Receipt,
  RotateCcw,
  Search,
  Warehouse,
  type LucideIcon,
} from "lucide-react";
import { cn, useHydrated } from "@openbooks/ui";
import { findActiveNavHref, findNavWorkspace } from "./sidebar-nav-active";
import { NavCountBadge } from "./nav-count-badge";

// Map string keys → icon components. RSCs can't serialise function references,
// so the parent server component passes us a key and we resolve client-side.
const ICONS: Record<string, LucideIcon> = {
  "badge-check": BadgeCheck,
  banknote: Banknote,
  "banknote-arrow-up": BanknoteArrowUp,
  "briefcase-business": BriefcaseBusiness,
  "calendar-check": CalendarCheck,
  "calendar-clock": CalendarClock,
  "calendar-days": CalendarDays,
  "calendar-range": CalendarRange,
  "chart-no-axes-combined": ChartNoAxesCombined,
  "chart-scatter": ChartScatter,
  "circle-dollar-sign": CircleDollarSign,
  coins: Coins,
  files: Files,
  gift: Gift,
  "git-branch": GitBranch,
  handshake: Handshake,
  "heart-handshake": HeartHandshake,
  landmark: Landmark,
  megaphone: Megaphone,
  "messages-square": MessagesSquare,
  network: Network,
  scale: Scale,
  "sliders-horizontal": SlidersHorizontal,
  split: Split,
  "user-check": UserRoundCheck,
  "user-cog": UserRoundCog,
  "user-minus": UserRoundMinus,
  "user-search": UserRoundSearch,

  activity: Activity,
  "heart-pulse": HeartPulse,
  alert: AlertTriangle,
  award: Award,
  bell: BellRing,
  book: BookOpen,
  building: Building2,
  check: CheckCircle2,
  "circle-help": CircleHelp,
  "circle-user": CircleUser,
  "clipboard-check": ClipboardCheck,
  clipboard: ClipboardList,
  code: Code2,
  construction: Construction,
  database: Database,
  download: Download,
  upload: Upload,
  history: History,
  file: FileText,
  folder: Folder,
  gauge: Gauge,
  // HR-15: inbox badge entry icon.
  inbox: Inbox,
  grad: GraduationCap,
  "graduation-cap": GraduationCap,
  clock: Clock,
  factory: Factory,
  map: MapIcon,
  percent: Percent,
  receipt: Receipt,
  "rotate-ccw": RotateCcw,
  search: Search,
  warehouse: Warehouse,
  grid: LayoutGrid,
  "hard-hat": HardHat,
  layers: Layers,
  library: LibraryBig,
  link: Link2,
  "list-checks": ListChecks,
  mail: Mail,
  pin: MapPin,
  message: MessageSquare,
  journal: NotebookPen,
  key: KeyRound,
  "panel-left": PanelLeft,
  plus: Plus,
  "qr-code": QrCode,
  radiation: Radiation,
  rss: Rss,
  scroll: ScrollText,
  settings: Settings,
  shield: ShieldCheck,
  sparkles: Sparkles,
  star: Star,
  tag: Tag,
  target: Target,
  package: Package,
  timer: Timer,
  truck: Truck,
  "trending-up": TrendingUp,
  users: Users,
  wallet: Wallet,
  workflow: Workflow,
  wrench: Wrench,
  "chevron-right": ChevronRight,
};

export type SidebarNavItem = {
  href: string;
  label: string;
  iconKey: keyof typeof ICONS | string;
  /** When set, the item is active ONLY on an exact path match (no greedy
   * prefix). Used for hub/overview links that are a prefix of their siblings. */
  exact?: boolean;
  /** Nested sub-menu this item belongs to. Contiguous items sharing a subgroup
   * render under one collapsible header in the desktop sidebar. */
  subgroup?: string;
  /** When set, the subgroup header itself navigates here (a landing hub for
   * the section) in addition to expanding its children. */
  subgroupHref?: string;
  /** Icon for the subgroup header (rendered like a regular item's icon). */
  subgroupIconKey?: string;
  /** Tenant-selected shortcut in the four-item mobile tab bar. */
  mobile?: boolean;
  /** HR-15: when set, the shell renders a live count badge on this entry,
   *  polled from this route (which must self-scope to the actor). */
  badgeCountHref?: string;
  /**
   * Short label for the mobile tab bar, where the full module label collides
   * when truncated (es "Cuentas por cobrar/pagar" both became "Cuentas
   * por…"). Unset items fall back to label.
   */
  shortLabel?: string;
  /** Localized search synonyms for the page (global search only). */
  keywords?: string[];
};

export type SidebarNavGroup = {
  /** Stable workspace id; labels may be translated or tenant-customized. */
  id: string;
  label: string;
  iconKey: string;
  /** When set, the group header itself navigates to the workspace's module
   * home (exact-match active state) while the chevron keeps toggling. */
  groupHref?: string;
  items: SidebarNavItem[];
};

const EXPANDED_STORAGE_KEY = "openbooks.nav.expanded-workspaces";

/**
 * Pathname-aware accordion nav: every workspace in one scrolling list (the
 * mobile drawer). The desktop sidebar composes the same pieces as two layers.
 *
 *   • 2px left accent rail on active + hover
 *   • teal-tinted background + label color on active
 *   • smooth colour transitions on hover
 *   • keyboard focus ring tuned to the teal palette
 *
 * The "active" check is greedy: /equipment/123 highlights the /equipment
 * top-level nav item. Sub-routes therefore keep the parent illuminated.
 */
export function SidebarNav({ groups }: { groups: SidebarNavGroup[] }) {
  const { activeHref, activeGroupId } = useActiveNav(groups);
  const navRef = useRef<HTMLElement>(null);
  const [openGroupIds, setOpenGroupIds] = useState<Set<string>>(
    () => new Set([groups[0]?.id, activeGroupId].filter((id): id is string => Boolean(id))),
  );
  const openGroupKey = useMemo(() => [...openGroupIds].sort().join("|"), [openGroupIds]);

  // Restore the persisted expansion on mount and when the navigation inputs
  // change, during render (same committed values, no extra render). Gated on
  // hydration so the server and the first client render agree on the default
  // expansion, exactly like the previous mount effect.
  const hydrated = useHydrated();
  const [prevNavKeys, setPrevNavKeys] = useState(() => ({
    activeGroupId,
    groups,
    restored: false,
  }));
  if (
    hydrated &&
    (!prevNavKeys.restored ||
      prevNavKeys.activeGroupId !== activeGroupId ||
      prevNavKeys.groups !== groups)
  ) {
    setPrevNavKeys({ activeGroupId, groups, restored: true });
    try {
      const raw = localStorage.getItem(EXPANDED_STORAGE_KEY);
      if (raw !== null) {
        const saved = JSON.parse(raw) as unknown;
        if (Array.isArray(saved)) {
          const valid = saved.filter(
            (id): id is string => typeof id === "string" && groups.some((group) => group.id === id),
          );
          setOpenGroupIds(
            new Set([...valid, activeGroupId].filter((id): id is string => Boolean(id))),
          );
        }
      }
    } catch {
      // Corrupt or unavailable storage falls back to Home + the active workspace.
    }
  }

  // Reveal the active workspace, during render (same committed values, no
  // extra render). The updater persists only when it actually expands.
  const [prevActiveGroupId, setPrevActiveGroupId] = useState(activeGroupId);
  if (prevActiveGroupId !== activeGroupId) {
    setPrevActiveGroupId(activeGroupId);
    if (activeGroupId) {
      setOpenGroupIds((current) => {
        if (current.has(activeGroupId)) return current;
        const next = new Set(current).add(activeGroupId);
        persistExpandedGroups(next);
        return next;
      });
    }
  }

  useScrollActiveIntoView(navRef, `${openGroupKey}|${activeHref}`);

  function toggleGroup(id: string) {
    setOpenGroupIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      persistExpandedGroups(next);
      return next;
    });
  }

  // Navigating to a workspace home from its header should also reveal the
  // section (mirror of SubgroupSection's linked-header behaviour).
  function openGroup(id: string) {
    setOpenGroupIds((current) => {
      if (current.has(id)) return current;
      const next = new Set(current).add(id);
      persistExpandedGroups(next);
      return next;
    });
  }

  return (
    <nav ref={navRef} className="app-scroll flex-1 overflow-y-auto px-2 py-3">
      {groups.map((group) => {
        const open = openGroupIds.has(group.id);
        const active = group.id === activeGroupId;
        const panelId = `nav-workspace-${group.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
        const headerCls = cn(
          "group flex w-full items-center text-xs font-semibold tracking-wide transition-colors",
          active
            ? "bg-teal-50/80 text-teal-800 dark:bg-teal-950/40 dark:text-teal-200"
            : "text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100",
          "rounded-md focus-visible:ring-2 focus-visible:ring-teal-500/40 focus-visible:outline-none",
        );
        return (
          <section key={group.id} className="mb-1">
            {group.groupHref ? (
              // Linked header: the label navigates to the workspace's
              // module home; the chevron stays a separate toggle target.
              <div className={headerCls}>
                <Link
                  href={group.groupHref as never}
                  aria-current={activeHref === group.groupHref ? "page" : undefined}
                  data-walkthrough={`nav:${group.groupHref}`}
                  onClick={() => openGroup(group.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 rounded-l-md px-2 py-1.5"
                >
                  <NavIcon iconKey={group.iconKey} size={14} className="shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-left uppercase">{group.label}</span>
                </Link>
                <button
                  type="button"
                  aria-expanded={open}
                  aria-controls={panelId}
                  aria-label={group.label}
                  onClick={() => toggleGroup(group.id)}
                  className="grid shrink-0 place-items-center self-stretch rounded-r-md pr-2 pl-1.5 hover:bg-slate-200/60 focus-visible:ring-2 focus-visible:ring-teal-500/40 focus-visible:outline-none dark:hover:bg-slate-700/60"
                >
                  <ChevronRight
                    size={13}
                    className={cn(
                      "shrink-0 opacity-60 transition-transform duration-150",
                      open && "rotate-90",
                    )}
                  />
                </button>
              </div>
            ) : (
              <button
                type="button"
                aria-expanded={open}
                aria-controls={panelId}
                onClick={() => toggleGroup(group.id)}
                className={cn(headerCls, "gap-2 px-2 py-1.5")}
              >
                <NavIcon iconKey={group.iconKey} size={14} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate text-left uppercase">{group.label}</span>
                <ChevronRight
                  size={13}
                  className={cn(
                    "shrink-0 opacity-60 transition-transform duration-150",
                    open && "rotate-90",
                  )}
                />
              </button>
            )}
            {open ? (
              <div id={panelId} className="mt-0.5 space-y-0.5">
                <WorkspaceItems items={group.items} activeHref={activeHref} />
              </div>
            ) : null}
          </section>
        );
      })}
    </nav>
  );
}

/** The current location, its nav entry and the workspace that owns it. */
export function useActiveNav(groups: SidebarNavGroup[]) {
  const pathname = usePathname() ?? "";
  const query = useSearchParams().toString();
  const location = query ? `${pathname}?${query}` : pathname;
  const activeHref = findActiveNavHref(location, groups);
  const activeGroupId = findNavWorkspace(location, groups)?.id ?? null;
  return { location, activeHref, activeGroupId };
}

/** Keep the current page's entry visible in a scrolling nav whenever `key` changes. */
export function useScrollActiveIntoView(
  ref: React.RefObject<HTMLElement | null>,
  key: string,
  enabled = true,
) {
  useEffect(() => {
    if (!enabled) return;
    const frame = window.requestAnimationFrame(() => {
      ref.current
        ?.querySelector<HTMLElement>('[aria-current="page"]')
        ?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [ref, key, enabled]);
}

function persistExpandedGroups(ids: Set<string>) {
  try {
    localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // Storage is an enhancement; navigation remains fully functional without it.
  }
}

function WorkspaceItems({
  items,
  activeHref,
}: {
  items: SidebarNavItem[];
  activeHref: string | null;
}) {
  return toBlocks(items).map((block, bi) =>
    block.kind === "item" ? (
      <NavLink key={block.item.href} item={block.item} active={activeHref === block.item.href} />
    ) : (
      <SubgroupSection
        key={`sub-${block.label}-${bi}`}
        label={block.label}
        href={block.href}
        iconKey={block.iconKey}
        items={block.items}
        activeHref={activeHref}
      />
    ),
  );
}

// --- nested-menu helpers (shared with the top nav's flyout sub-menus) ------

export type NavBlock =
  | { kind: "item"; item: SidebarNavItem }
  | {
      kind: "subgroup";
      label: string;
      href?: string;
      iconKey?: string;
      items: SidebarNavItem[];
    };

/** Fold a flat item list into blocks, coalescing every item that shares a
 * subgroup. A workspace's explicit module order can interleave declarations
 * without fragmenting one logical section into repeated headings. */
export function toBlocks(items: SidebarNavItem[]): NavBlock[] {
  const blocks: NavBlock[] = [];
  for (const item of items) {
    if (item.subgroup) {
      const existing = blocks.find(
        (block): block is Extract<NavBlock, { kind: "subgroup" }> =>
          block.kind === "subgroup" && block.label === item.subgroup,
      );
      if (existing) {
        existing.items.push(item);
        if (!existing.href) existing.href = item.subgroupHref;
        if (!existing.iconKey) existing.iconKey = item.subgroupIconKey;
      } else {
        blocks.push({
          kind: "subgroup",
          label: item.subgroup,
          href: item.subgroupHref,
          iconKey: item.subgroupIconKey,
          items: [item],
        });
      }
    } else {
      blocks.push({ kind: "item", item });
    }
  }
  return blocks;
}

/** A single nav link. `nested` indents it under a subgroup header; `dense`
 *  tightens the row for the desktop panel, where pointer targets suffice. */
export function NavLink({
  item,
  active,
  nested = false,
  dense = false,
}: {
  item: SidebarNavItem;
  active: boolean;
  nested?: boolean;
  dense?: boolean;
}) {
  const Icon = ICONS[item.iconKey] ?? Gauge;
  const className = cn(
    "group relative flex items-center rounded-md",
    dense ? "py-[5px] text-[13px]" : "py-1.5 text-sm",
    "transition-colors duration-150 ease-out",
    nested ? "gap-2.5 pr-2 pl-8" : "gap-2.5 px-2",
    "before:absolute before:top-1/2 before:left-0 before:h-5 before:w-[2px] before:-translate-y-1/2 before:rounded-full",
    "before:transition-all before:duration-150 before:ease-out",
    active
      ? "bg-teal-50 text-teal-900 before:h-6 before:bg-teal-700 dark:bg-teal-950/50 dark:text-teal-100 dark:before:bg-teal-400"
      : "text-slate-700 before:bg-transparent hover:bg-slate-100 hover:text-slate-900 hover:before:bg-slate-300 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-slate-100 dark:hover:before:bg-slate-600",
    "focus-visible:ring-2 focus-visible:ring-teal-500/40 focus-visible:outline-none",
  );
  const content = (
    <>
      <Icon
        size={dense ? 14 : 15}
        className={cn(
          "shrink-0 transition-colors duration-150",
          active
            ? "text-teal-700 dark:text-teal-300"
            : "text-slate-500 group-hover:text-slate-700 dark:text-slate-400 dark:group-hover:text-slate-200",
        )}
      />
      <span className={dense ? "min-w-0 flex-1 truncate" : undefined}>{item.label}</span>
      {item.badgeCountHref ? <NavCountBadge source={item.badgeCountHref} /> : null}
    </>
  );
  return item.href.startsWith("https://") ? (
    <a href={item.href} data-walkthrough={`nav:${item.href}`} className={className}>
      {content}
    </a>
  ) : (
    <Link
      href={item.href as never}
      aria-current={active ? "page" : undefined}
      data-walkthrough={`nav:${item.href}`}
      className={className}
    >
      {content}
    </Link>
  );
}

/** Collapsible nested section. Auto-opens when a child (or its own landing
 *  page) is active. When `href` is set the label navigates to the section's
 *  landing hub while the chevron keeps toggling the children. */
function SubgroupSection({
  label,
  href,
  iconKey,
  items,
  activeHref,
}: {
  label: string;
  href?: string;
  iconKey?: string;
  items: SidebarNavItem[];
  activeHref: string | null;
}) {
  const selfActive = href != null && activeHref === href;
  const hasActiveChild = items.some((i) => i.href === activeHref) || selfActive;
  const [open, setOpen] = useState(hasActiveChild);
  // Navigating into a child from elsewhere should reveal the section, during
  // render (same committed value, no extra render). Navigating away leaves
  // the section as it was, like before.
  if (hasActiveChild && !open) setOpen(true);

  const headerClass = cn(
    "group flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-sm",
    "transition-colors duration-150 ease-out",
    selfActive
      ? "bg-teal-50 text-teal-900 dark:bg-teal-950/50 dark:text-teal-100"
      : hasActiveChild && !open
        ? "text-teal-800 dark:text-teal-200"
        : "text-slate-700 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-slate-100",
    "focus-visible:ring-2 focus-visible:ring-teal-500/40 focus-visible:outline-none",
  );
  const chevron = (
    <ChevronRight
      size={15}
      className={cn(
        "shrink-0 text-slate-400 transition-transform duration-150 dark:text-slate-500",
        open && "rotate-90",
      )}
    />
  );

  return (
    <div>
      {href ? (
        // Linked header: the label navigates to the section's landing hub;
        // the chevron is a sibling click target so the section can be
        // toggled without navigating.
        <div className={cn(headerClass, "p-0")}>
          <button
            type="button"
            aria-expanded={open}
            aria-label={label}
            onClick={() => setOpen((o) => !o)}
            className="grid shrink-0 place-items-center self-stretch rounded-l-md pl-2 hover:bg-slate-200/60 dark:hover:bg-slate-700/60"
          >
            {chevron}
          </button>
          <Link
            href={href}
            aria-current={selfActive ? "page" : undefined}
            data-walkthrough={`nav:${href}`}
            onClick={() => setOpen(true)}
            className="flex flex-1 items-center gap-2.5 rounded-r-md py-1.5 pr-2"
          >
            {iconKey ? (
              <NavIcon iconKey={iconKey} className="shrink-0 text-slate-500 dark:text-slate-400" />
            ) : null}
            {label}
          </Link>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className={headerClass}
        >
          {chevron}
          {iconKey ? (
            <NavIcon iconKey={iconKey} className="shrink-0 text-slate-500 dark:text-slate-400" />
          ) : null}
          <span>{label}</span>
        </button>
      )}
      {open ? (
        <div className="mt-0.5 space-y-0.5">
          {items.map((item) => (
            <NavLink key={item.href} item={item} active={activeHref === item.href} nested />
          ))}
        </div>
      ) : null}
    </div>
  );
}

// --- Shared icon helpers (consumed by the /admin/navigation editor) -------

/** Stable, sorted list of icon keys offered by the nav editor's icon picker. */
export const ICON_KEYS = Object.keys(ICONS).sort();

/** Render a nav icon by its string key (falls back to a neutral gauge). */
export function NavIcon({
  iconKey,
  size = 15,
  className,
}: {
  iconKey: string;
  size?: number;
  className?: string;
}) {
  const Icon = ICONS[iconKey] ?? Gauge;
  return <Icon size={size} className={className} />;
}

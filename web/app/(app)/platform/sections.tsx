import Link from "next/link";
import { Building2, KeyRound, Mail, ShieldCheck, Users, type LucideIcon } from "lucide-react";
import { Card, CardContent } from "@openbooks/ui";

export type PlatformTileIconKey = "building-2" | "users" | "key-round" | "mail";

const TILE_ICONS: Record<PlatformTileIconKey, LucideIcon> = {
  "building-2": Building2,
  users: Users,
  "key-round": KeyRound,
  mail: Mail,
};

/**
 * The static amber banner above the tiles.
 *
 * A widget rather than spec blocks: the banner composes a lucide icon with
 * amber-scoped Tailwind classes the grid vocabulary cannot name, and it
 * carries no data — so the registry entry takes no props.
 */
export function PlatformNotice() {
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-4 dark:border-amber-900/60 dark:bg-amber-950/25">
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-amber-100 text-amber-800 ring-1 ring-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-800">
          <ShieldCheck size={20} />
        </span>
        <div>
          <p className="text-sm font-semibold text-amber-950 dark:text-amber-100">
            Platform workspace
          </p>
          <p className="mt-0.5 text-sm text-amber-800 dark:text-amber-300">
            This workspace bypasses organization boundaries for authorized
            operators. Every access-control mutation is validated and
            written to the immutable audit trail.
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * One platform-hub navigation tile: a Next Link composing a per-tile lucide
 * icon, a loader-formatted stat, and a loader-built detail line. The stat
 * (`toLocaleString`) and the detail strings (production/non-production split,
 * the super-administrator plural) are built in the loader, so the spec
 * carries only serializable strings — the same rule that keeps money and
 * date formatting out of every other converted spec.
 */
export function PlatformTile({
  href,
  iconKey,
  title,
  description,
  stat,
  detail,
}: {
  href: string;
  iconKey: PlatformTileIconKey;
  title: string;
  description: string;
  stat: string;
  detail: string;
}) {
  const Icon = TILE_ICONS[iconKey];
  return (
    <Link href={href as never} className="group">
      <Card
        interactive
        className="h-full hover:border-amber-300 dark:hover:border-amber-800"
      >
        <CardContent className="flex h-full flex-col p-4">
          <div className="flex items-start justify-between gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-lg bg-amber-50 text-amber-700 ring-1 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-800/60">
              <Icon size={19} />
            </span>
            <span className="text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">
              {stat}
            </span>
          </div>
          <h2 className="mt-4 text-sm font-semibold text-slate-900 dark:text-slate-100">
            {title}
          </h2>
          <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
            {description}
          </p>
          <p className="mt-auto pt-4 text-xs font-medium text-amber-700 dark:text-amber-300">
            {detail}
          </p>
        </CardContent>
      </Card>
    </Link>
  );
}

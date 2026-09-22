// UiLink rather than a bare <a>: back-links are in-app routes, and a plain
// anchor forces a full document reload — which replays the boot splash and
// refetches the whole shell on every record → list hop. The app injects its
// client-side Link via UiLinkProvider (see link-context.tsx).
import { UiBackLink } from "./link-context";
import { DocumentTitle } from "./document-title";
import { cn } from "./utils";

export function PageHeader({
  title,
  description,
  actions,
  back,
  className,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  back?: { href: string; label: string };
  className?: string;
}) {
  return (
    <div className={cn("space-y-2", className)}>
      <DocumentTitle title={title} />
      {back ? (
        <UiBackLink
          href={back.href}
          label={back.label}
          className="text-xs text-slate-500 hover:text-teal-700 dark:text-slate-400 dark:hover:text-teal-300"
        />
      ) : null}
      {/* Title on the left (truncates to make room), actions pinned right.
          Phones drop the description to keep the header to a single line and
          let a wide action strip (route tabs + a button) wrap UNDER the title
          instead of squeezing it to one letter — the title keeps a 10rem
          floor. sm+ stays one row and actions TOP-align to the (single-line)
          title so their position never depends on whether the description
          wraps — route-tab strips must not move between sibling pages.

          The sm+ floor is a HARD 14rem, not `min-w-0`. With min-w-0 a wide
          action strip won a shrink race outright: the HRM group's fourteen
          route tabs measured 1358px and left the <h1> rendered at ZERO width
          on every page in the module — present, 32px tall, invisible. The
          strip is the thing that must give, and it can: it folds its tail
          into a More menu once it stops fitting. */}
      <header className="flex flex-wrap items-center justify-between gap-3 sm:flex-nowrap sm:items-start sm:gap-4">
        <div className="min-w-0 flex-1 basis-40 space-y-1 sm:min-w-56">
          <h1 className="truncate text-xl font-semibold text-slate-900 sm:text-2xl dark:text-slate-100">
            {title}
          </h1>
          {description ? (
            <p className="hidden text-sm text-slate-500 sm:block dark:text-slate-400">
              {description}
            </p>
          ) : null}
        </div>
        {/* Primary page actions keep stable geometry when sibling routes use
            different implementations (for example, a client create button on
            one tab and an asChild link on another).

            `data-page-actions` is what lets a subtab strip shrink instead of
            overrunning the row. A flex item's default `min-width: auto`
            refuses to go below its content, and specs wrap their actions in
            one more flex div of their own (actionsClassName), so the
            permission has to reach two levels — see the rule in
            web/app/globals.css. Buttons still hold their width: they set
            `whitespace-nowrap` and the rule leaves their own min-width alone
            at the level it stops, so the strip is the only item with slack
            to give. */}
        {actions ? (
          <div
            data-page-actions
            className="flex max-w-full flex-wrap items-center justify-end gap-2 [&_[data-slot=button][data-variant=default]]:h-10 [&_[data-slot=button][data-variant=default]]:px-4"
          >
            {actions}
          </div>
        ) : null}
      </header>
    </div>
  );
}

export function DetailHeader({
  back,
  title,
  subtitle,
  badge,
  actions,
}: {
  back?: { href: string; label: string };
  title: string;
  subtitle?: string;
  badge?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <header className="space-y-2">
      <DocumentTitle title={title} />
      {back ? (
        <UiBackLink
          href={back.href}
          label={back.label}
          className="text-sm text-teal-700 hover:underline dark:text-teal-300"
        />
      ) : null}
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
          <h1 className="text-xl font-semibold text-slate-900 sm:truncate sm:text-2xl dark:text-slate-100">
            {title}
          </h1>
          {badge}
        </div>
        {actions ? (
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </div>
      {subtitle ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">{subtitle}</p>
      ) : null}
    </header>
  );
}

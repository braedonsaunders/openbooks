/**
 * The one tab shape. Lives apart from both the server kit (`./ui`) and the
 * client strip (`./tabs`) so a server loader can name it without pulling the
 * client component into its module graph.
 *
 * `count` is optional and renders as a bubble on the pill — the approvals
 * hub needs it, a route strip does not. It is the reason the inbox no longer
 * has a tab strip of its own.
 */
export type ModuleHomeTab = {
  href: string;
  label: string;
  active?: boolean;
  count?: number | null;
};

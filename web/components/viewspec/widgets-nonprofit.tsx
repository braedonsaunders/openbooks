import { EncumbranceDrawer, FundDrawer, GrantDrawer, ReleaseDrawer } from "./native-widgets.client";
import type { EncumbranceDrawerData } from "../../app/(app)/nonprofit/encumbrances/view";
import type { FundDrawerState } from "../../app/(app)/nonprofit/funds/view";
import type { GrantDrawerData } from "../../app/(app)/nonprofit/grants/view";
import type { ReleaseDrawerState } from "../../app/(app)/nonprofit/releases/view";
import { type WidgetRenderer } from "./widget-props";

/** Nonprofit record drawers. Compose native drawers without changing their props or boundaries. */
export const NONPROFIT_WIDGETS = {
  "encumbrance-drawer": (props) => {
    const drawer = props.drawer as EncumbranceDrawerData | null;
    if (!drawer) return null;
    return <EncumbranceDrawer key={drawer.remountKey} drawer={drawer} />;
  },
  "fund-drawer": (props) => {
    const drawer = props.drawer as FundDrawerState | null;
    if (!drawer) return null;
    return <FundDrawer key={drawer.remountKey} drawer={drawer} />;
  },
  "grant-drawer": (props) => {
    const drawer = props.drawer as GrantDrawerData | null;
    if (!drawer) return null;
    return <GrantDrawer key={drawer.remountKey} drawer={drawer} />;
  },
  "release-drawer": (props) => {
    const drawer = props.drawer as ReleaseDrawerState | null;
    if (!drawer) return null;
    return <ReleaseDrawer key={drawer.remountKey} drawer={drawer} />;
  },
} satisfies Record<string, WidgetRenderer>;

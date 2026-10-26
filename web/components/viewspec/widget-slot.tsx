import { Fragment } from "react";
import type { WidgetRef } from "@braedonsaunders/appkit-viewspec";
import { resolvePath } from "@braedonsaunders/appkit-viewspec";
import { renderWidget } from "./widget-loader";
import { resolveWidgetProps } from "./widget-props";

/**
 * Render a slot's widgets. A `when` reference that resolves falsy omits the
 * widget entirely — that is how a spec expresses the native pages' conditional
 * `{x ? <Button/> : null}` without gaining a conditional operator.
 */
export function WidgetSlot({
  widgets,
  scope,
}: {
  widgets: WidgetRef[] | undefined;
  scope: unknown;
}) {
  if (!widgets || widgets.length === 0) return null;
  return (
    <>
      {widgets.map((ref, index) => {
        if (ref.when && !resolvePath(scope, ref.when.$)) return null;
        // A Fragment, not a wrapper element: the native pages place these
        // widgets as direct children of the slot, and any real element here
        // (even display:contents) is markup the native render does not have.
        return (
          <Fragment key={`${ref.widget}-${index}`}>
            {renderWidget(ref.widget, resolveWidgetProps(ref.props, scope), scope)}
          </Fragment>
        );
      })}
    </>
  );
}

/** Render one widget by name — the `widget` block's renderer. */
export function WidgetBlockView({
  name,
  props,
  scope,
  searchParams,
}: {
  name: string;
  props: Record<string, unknown>;
  scope: unknown;
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  return <>{renderWidget(name, resolveWidgetProps(props, scope), scope, searchParams)}</>;
}

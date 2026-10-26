import type { ComponentProps } from "react";
import type { ListToolbar } from "../list-toolbar";
import { resolveWidgetProps } from "./widget-props";

type ToolbarProps = ComponentProps<typeof ListToolbar>;

/** Resolve the native toolbar's structured controls without interpreting row or table definitions. */
export function resolveListToolbarProps(
  props: Record<string, unknown>,
  scope: unknown,
): ToolbarProps {
  const resolved = resolveWidgetProps(props, scope);
  const control = (value: unknown) =>
    value == null ? null : resolveWidgetProps(value as Record<string, unknown>, scope);
  const filters = resolved.filters as Record<string, unknown>[] | undefined;
  return {
    basePath: resolved.basePath as string,
    currentParams: resolved.currentParams as ToolbarProps["currentParams"],
    search: control(resolved.search) as ToolbarProps["search"],
    filters: filters?.map((filter) => control(filter)) as ToolbarProps["filters"],
    date: control(resolved.date) as ToolbarProps["date"],
  };
}

import {
  table,
  widgetBlock,
  type WidgetRef,
} from '@braedonsaunders/appkit-viewspec'
import {
  preparedListSource,
  type PreparedListSourceKey,
} from './prepared-sources'

/** Typed domain cells on the registered shared list composition. */
export function registeredListTable(
  source: PreparedListSourceKey,
  config: Parameters<typeof table>[0],
  toolbar?: WidgetRef[],
) {
  preparedListSource(source)
  return widgetBlock('registered-record-list', {
    source,
    table: table(config),
    ...(toolbar ? { toolbar } : {}),
  })
}

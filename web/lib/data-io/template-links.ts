/** Download location of a resource's blank import template. Client-safe. */
export function templateHref(resourceKey: string, format: 'csv' | 'xlsx' = 'xlsx'): string {
  return `/api/data/templates/${encodeURIComponent(resourceKey)}?format=${format}`
}

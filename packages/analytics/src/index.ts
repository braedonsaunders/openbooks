// @openbooks/analytics — the Insights query engine (query model → SQL → viz).
//
// This entry is PURE (no `pg`, no React): types, the authored catalog, the
// semantic layer, the SQL compiler, the runtime validator and the viz-spec
// builder. Safe to import from server components and client bundles alike.
//
//   ./         — this file (pure)
//   ./server   — runInsightQuery (opens the pool; server only)
//   ./viz      — <InsightChart/> React renderer (echarts; client only)

export * from './types'
export * from './semantic'
export * from './catalog'
export * from './compile'
export * from './validate'
export * from './viz'

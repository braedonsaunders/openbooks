#!/usr/bin/env node
/**
 * Write `web/components/viewspec/widget-contracts.ts` from the widget registry.
 *
 * Run after changing a widget's props:
 *   node scripts/generate-widget-contracts.mjs
 *
 * The parsing lives in `./widget-contracts-source.mjs` so the drift test can
 * reuse it without regenerating the file it is checking.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { generate, registryContracts } from './widget-contracts-source.mjs'

const ROOT = process.cwd()
const SOURCE = join(ROOT, 'web', 'components', 'viewspec', 'widgets.tsx')
const OUT = join(ROOT, 'web', 'components', 'viewspec', 'widget-contracts.ts')

const contracts = registryContracts(readFileSync(SOURCE, 'utf8'), 'WIDGET_REGISTRY')
writeFileSync(OUT, generate(contracts))
const open = Object.values(contracts).filter((c) => c.open).length
console.log(
  `wrote ${relative(ROOT, OUT)} — ${Object.keys(contracts).length} widgets, ${open} open (unchecked)`,
)

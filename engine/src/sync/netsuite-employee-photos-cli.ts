import { writeFileSync } from 'node:fs'
import { pool, longPool } from '../platform/db.ts'
import { importNetSuiteEmployeePhotos } from './netsuite-employee-photos.ts'

const args = process.argv.slice(2)
const read = (key: string) => { const index = args.indexOf(key); return index < 0 ? undefined : args[index + 1] }
async function main() {
  const orgId = read('--org'), connectionId = read('--connection'), actorId = read('--actor')
  if (!orgId || !connectionId || !actorId) throw new Error('--org, --connection and --actor UUIDs are required')
  const employeeRefs = args.flatMap((value, index) => value === '--employee' ? [args[index + 1] ?? ''] : [])
  if (employeeRefs.some(ref => !/^-?\d+$/.test(ref))) throw new Error('--employee requires a numeric NetSuite employee ID')
  const summary = await importNetSuiteEmployeePhotos({ orgId, connectionId, actorId, employeeRefs, execute: args.includes('--execute') })
  const report = read('--report')
  if (report) writeFileSync(report, JSON.stringify(summary, null, 2)+'\n', { mode: 0o600 })
  const { details: _details, ...counts } = summary
  console.log(JSON.stringify(counts, null, 2))
  if (summary.errors || summary.unmatched) process.exitCode = 1
}
try { await main() }
catch (error) { console.error(error instanceof Error ? error.message : 'Employee photo import failed'); process.exitCode = 1 }
finally { await Promise.allSettled([pool.end(), longPool.end()]) }

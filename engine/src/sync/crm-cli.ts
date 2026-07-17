import { importNetSuiteCrm } from './netsuite-crm.ts'

const orgId = process.argv[2]
const connectionId = process.argv[3]
if (!orgId) {
  console.error('Usage: npx tsx engine/src/sync/crm-cli.ts <org-id> [connection-id]')
  process.exit(2)
}

try {
  const report = await importNetSuiteCrm(orgId, connectionId)
  console.log(JSON.stringify(report, null, 2))
  if (report.warnings.length) process.exitCode = 3
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}

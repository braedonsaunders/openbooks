import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const joined = (...parts) => parts.join('')

const vendorPatterns = [
  new RegExp(joined('Net', 'Suite'), 'i'),
  new RegExp(joined('Quick', 'Books'), 'i'),
  new RegExp(`\\b${joined('Q', 'BO')}\\b`),
  new RegExp(`\\b${joined('Q', 'BD')}\\b`),
  new RegExp(`\\b${joined('Xe', 'ro')}\\b`, 'i'),
  new RegExp(`\\b${joined('Od', 'oo')}\\b`, 'i'),
  new RegExp(joined('ERP', 'Next'), 'i'),
  new RegExp(joined('Sage ', 'Intacct'), 'i'),
  new RegExp(joined('Microsoft ', 'Dynamics(?: 365)?'), 'i'),
  new RegExp(joined('Dynamics ', '365'), 'i'),
  new RegExp(joined('Oracle ', 'Financials'), 'i'),
  new RegExp(`\\b${joined('S', 'AP')}\\b`),
  new RegExp(joined('Suite', 'Analytics'), 'i'),
  new RegExp(joined('Suite', 'Flow'), 'i'),
  new RegExp(joined('Suite', 'Script'), 'i'),
  new RegExp(joined('Suite', 'App'), 'i'),
  new RegExp(joined('Suite', 'QL'), 'i'),
  new RegExp(joined('One', 'World'), 'i'),
]

const organizationPatterns = [new RegExp(['Ras', 'saun'].join(''), 'i')]

const connectorPaths = [
  /^\.gitignore$/,
  /^scripts\/check-product-neutrality\.mjs$/,
  /^engine\/src\/(?:netsuite|qbo\.ts$|xero\.ts$|odoo\.ts$|erpnext\.ts$|dynamics\.ts$|qbd\/|sync\/)/,
  /^engine\/src\/worker\/migration-worker\.ts$/,
  /^extraction\//,
  /^integrations\//,
  /^schema\/src\/(?:extension|qbd)\.ts$/,
  /^web\/app\/\(app\)\/sync\//,
  /^web\/app\/api\/(?:platform\/connections|qbd)\//,
  /^web\/lib\/docs\/articles\/(?:netsuite-bridge|quickbooks-desktop-connector)\.ts$/,
  /^web\/lib\/docs\/index\.ts$/,
  /^web\/messages\/[^/]+\/sync\.json$/,
]

function isConnectorPath(filePath) {
  return connectorPaths.some((pattern) => pattern.test(filePath))
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = pattern.exec(text)
    if (match) return match
  }
  return null
}

const trackedFiles = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)

const violations = []

for (const filePath of trackedFiles) {
  const organizationPathMatch = firstMatch(filePath, organizationPatterns)
  if (organizationPathMatch) {
    violations.push(`${filePath}: organization name in path`)
  }

  const vendorPathMatch = firstMatch(filePath, vendorPatterns)
  if (vendorPathMatch && !isConnectorPath(filePath)) {
    violations.push(`${filePath}: accounting-vendor name in non-connector path`)
  }

  let source
  try {
    source = readFileSync(filePath, 'utf8')
  } catch {
    continue
  }
  if (source.includes('\0')) continue

  const organizationMatch = firstMatch(source, organizationPatterns)
  if (organizationMatch) {
    const line = source.slice(0, organizationMatch.index).split('\n').length
    violations.push(`${filePath}:${line}: organization name in tracked content`)
  }

  if (!isConnectorPath(filePath)) {
    const vendorMatch = firstMatch(source, vendorPatterns)
    if (vendorMatch) {
      const line = source.slice(0, vendorMatch.index).split('\n').length
      violations.push(`${filePath}:${line}: accounting-vendor name outside connector scope`)
    }
  }
}

if (violations.length > 0) {
  console.error('Product-neutrality audit failed:')
  for (const violation of violations) console.error(`- ${violation}`)
  process.exit(1)
}

console.log('Product-neutrality audit passed.')

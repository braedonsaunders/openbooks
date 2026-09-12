// Run the shipped standalone server behind loopback-only TLS. Production
// session cookies and Origin/CSRF checks remain enabled in browser tests.
import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdtempSync, readFileSync, rmSync, cpSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { forwardResponse } from './e2e-proxy-response.mjs'

const root = resolve(import.meta.dirname, '..')
const standalone = join(root, 'web/.next/standalone/web')
if (!existsSync(join(standalone, 'server.js'))) throw new Error('Build web before starting production E2E')
cpSync(join(root, 'web/.next/static'), join(standalone, '.next/static'), { recursive: true })
if (existsSync(join(root, 'web/public'))) cpSync(join(root, 'web/public'), join(standalone, 'public'), { recursive: true })
const directory = mkdtempSync(join(tmpdir(), 'openbooks-e2e-tls-'))
const log = createWriteStream(join(root, 'e2e-server.log'), { flags: 'w', mode: 0o600 })
let app = null
let proxy = null
let stopping = false
async function stop(code) {
  if (stopping) return
  stopping = true
  proxy?.closeAllConnections()
  proxy?.close()
  if (app && app.exitCode === null && app.signalCode === null) {
    const exited = new Promise((done) => app.once('exit', done))
    app.kill('SIGTERM')
    const timer = setTimeout(() => app.kill('SIGKILL'), 5_000)
    await exited
    clearTimeout(timer)
  }
  rmSync(directory, { recursive: true, force: true })
  await new Promise((done) => log.end(done))
  process.exit(code)
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void stop(0))
process.on('uncaughtException', (error) => { console.error(error); void stop(1) })
process.on('unhandledRejection', (error) => { console.error(error); void stop(1) })

const cert = spawnSync('openssl', [
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
  '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
  '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'),
], { stdio: 'pipe' })
if (cert.status !== 0) throw new Error(`Ephemeral TLS certificate creation failed: ${cert.error ?? cert.stderr}`)
app = spawn(process.execPath, [join(standalone, 'server.js')], {
  cwd: standalone,
  env: { ...process.env, NODE_ENV: 'production', HOSTNAME: '127.0.0.1', PORT: '4781' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
for (const stream of [app.stdout, app.stderr]) stream.on('data', (data) => { log.write(data); process.stdout.write(data) })
app.on('error', (error) => { console.error(error); void stop(1) })
app.on('exit', (code, signal) => {
  if (!stopping) { console.error(`Production E2E server exited: ${code ?? signal}`); void stop(1) }
})
proxy = https.createServer({
  key: readFileSync(join(directory, 'key.pem')),
  cert: readFileSync(join(directory, 'cert.pem')),
}, (request, response) => {
  const upstream = http.request({
    hostname: '127.0.0.1', port: 4781, path: request.url, method: request.method,
    headers: { ...request.headers, 'x-forwarded-proto': 'https', 'x-forwarded-host': request.headers.host },
  }, (result) => {
    forwardResponse(result, response)
  })
  upstream.on('error', (error) => {
    log.write(`TLS upstream: ${error.message}\n`)
    if (!response.headersSent) response.writeHead(502)
    response.end()
  })
  response.on('close', () => upstream.destroy())
  request.pipe(upstream)
})
proxy.listen(4780, 'localhost', () => console.log('Production E2E TLS proxy listening at https://localhost:4780'))

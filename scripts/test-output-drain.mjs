// Node's forced test shutdown can exit while serialized child test events are
// still buffered on stdout. The parent then reports fewer tests with exit 0.
// Preserve forced shutdown, but first drain both output streams using their
// public write callbacks. This preload belongs only to the test runner.
if (process.execArgv.includes('--test-force-exit')) {
  if (process.env.NODE_ENV !== 'test') throw new Error('Test output drain requires NODE_ENV=test')
  const exit = process.exit.bind(process)
  let exiting = false
  let exitCode = 0
  process.exit = (code = process.exitCode ?? 0) => {
    if (exiting) {
      if (!exitCode && code) { process.exitCode = code; exitCode = process.exitCode }
      return
    }
    process.exitCode = code
    exitCode = process.exitCode ?? 0
    exiting = true
    // A broken or permanently blocked reporter must fail, never produce a
    // smaller successful test receipt. Keep shutdown finite on that path.
    const timer = setTimeout(() => exit(exitCode || process.exitCode || 1), 10_000)
    const drain = (stream) => new Promise((resolve, reject) => {
      if (stream.destroyed) return reject(new Error('Test output stream is closed'))
      stream.write('', (error) => error ? reject(error) : resolve())
    })
    Promise.all([drain(process.stdout), drain(process.stderr)]).then(
      () => { clearTimeout(timer); exit(exitCode || process.exitCode || 0) },
      () => { clearTimeout(timer); exit(exitCode || process.exitCode || 1) },
    )
  }
}

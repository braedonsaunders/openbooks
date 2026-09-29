/** Keep a disconnected test worker from terminating the shared fixture owner. */
export function observeFixtureOwnerSocket(socket, onData, reportError = (error) => {
  process.stderr.write(`[fixture-owner] client connection failed: ${String(error)}\n`);
}) {
  socket.on('error', reportError);
  socket.on('data', onData);
}

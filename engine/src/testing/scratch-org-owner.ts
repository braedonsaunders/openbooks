import { createConnection } from "node:net";

export function fixtureOwnerPort(): number | undefined {
  const raw = process.env.OPENBOOKS_TEST_FIXTURE_OWNER_PORT;
  if (!raw) return undefined;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`OPENBOOKS_TEST_FIXTURE_OWNER_PORT is invalid: ${raw}`);
  }
  return port;
}

export async function fixtureOwnerRequest<T>(request: Record<string, string>): Promise<T> {
  const port = fixtureOwnerPort();
  if (!port) throw new Error("fixture owner is not configured");
  return await new Promise<T>((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let buffer = "";
    let settled = false;
    const finish = (error?: Error, value?: T) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value as T);
    };
    socket.setTimeout(120_000, () => finish(new Error("fixture owner request timed out")));
    socket.on("error", (error) => finish(error));
    socket.once("end", () => finish(new Error("fixture owner closed without a complete response")));
    socket.once("close", () =>
      finish(new Error("fixture owner closed without a complete response")),
    );
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        if (!response.ok) throw new Error(String(response.error ?? "fixture owner request failed"));
        finish(undefined, response as T);
      } catch (error) {
        finish(error as Error);
      }
    });
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
  });
}

// Keep process-local lease ids so exit hooks can release outstanding tenants.
export const outstandingFixtureOwnerLeases = new Set<string>();

export const completedFixtureOwnerLeases = new Set<string>();

export const outstandingFixturePoolLeases = new Set<string>();

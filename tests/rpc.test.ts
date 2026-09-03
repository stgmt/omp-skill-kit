import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { rpcCall } from "../src/rpc.js";

describe("bridge RPC", () => {
  it("requires the matching response id", async () => {
    const server = createServer((socket) => {
      socket.on("data", () => socket.write('{"id":"wrong","ok":true}\n'));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    const port = (server.address() as { port: number }).port;
    await expect(
      rpcCall(
        { id: "right", op: "ping", token: "secret" },
        { port, token: "secret", timeoutMs: 1000 },
      ),
    ).rejects.toThrow("response id mismatch");
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

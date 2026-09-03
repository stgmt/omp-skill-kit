import { connect } from "node:net";
import type { BridgeRequest, BridgeResponse } from "./bridge-protocol.js";
import { MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES } from "./shared/constants.js";

export interface JsonlClientOptions {
  host?: string;
  port: number;
  token: string;
  timeoutMs?: number;
}

export async function rpcCall(
  req: BridgeRequest,
  opts: JsonlClientOptions,
): Promise<BridgeResponse> {
  const { port, host = "127.0.0.1", token, timeoutMs = 3000 } = opts;
  const wire = JSON.stringify({ ...req, token });
  if (Buffer.byteLength(wire, "utf8") > MAX_REQUEST_BYTES)
    throw new Error("request exceeds max size");
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = connect({ host, port });
    let buffer = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.destroy();
        rejectPromise(new Error("rpc timeout"));
      }
    }, timeoutMs);
    const finish = (err?: Error, response?: BridgeResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) rejectPromise(err);
      else if (response) resolvePromise(response);
      else rejectPromise(new Error("rpc response missing"));
    };
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_RESPONSE_BYTES) {
        finish(new Error("response exceeds max size"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      try {
        const response = JSON.parse(line) as BridgeResponse;
        if (response.id !== req.id) {
          finish(new Error("response id mismatch"));
          return;
        }
        finish(undefined, response);
      } catch {
        finish(new Error("malformed response"));
      }
    });
    socket.on("error", (error) => finish(error));
    socket.on("close", () => finish(new Error("connection closed")));
    socket.write(`${wire}\n`);
  });
}

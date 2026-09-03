import { createHash } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

export interface RequestReceipt {
  turn: number;
  promptHash: string;
  hasHintsBlock: boolean;
  hintNames: string[];
  hasDescription: boolean;
  hasPath: boolean;
  hasBody: boolean;
  hasToolResult: boolean;
  toolResultText?: string;
  receivedAt: string;
}

export interface OpenAIStubServer {
  port: number;
  url: string;
  receipts: RequestReceipt[];
  stop: () => Promise<void>;
  reset: () => void;
}

export function startOpenAIStub(port = 0): Promise<OpenAIStubServer> {
  return new Promise((resolvePromise, rejectPromise) => {
    const receipts: RequestReceipt[] = [];
    let turnCounter = 0;

    const server: Server = createServer(
      async (req: IncomingMessage, res: ServerResponse) => {
        // Loopback-only security guard
        const remoteIp = req.socket.remoteAddress;
        if (
          remoteIp !== "127.0.0.1" &&
          remoteIp !== "::1" &&
          remoteIp !== "::ffff:127.0.0.1"
        ) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Forbidden: loopback only" }));
          return;
        }

        const url = req.url || "";
        if (
          req.method === "GET" &&
          (url === "/v1/models" || url === "/models")
        ) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              object: "list",
              data: [
                {
                  id: "test-model",
                  object: "model",
                  created: 1700000000,
                  owned_by: "omp-skill-kit-e2e",
                },
              ],
            }),
          );
          return;
        }

        if (
          req.method === "POST" &&
          (url === "/v1/chat/completions" || url === "/chat/completions")
        ) {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
          }
          const bodyRaw = Buffer.concat(chunks).toString("utf8");
          let body: any;
          try {
            body = JSON.parse(bodyRaw);
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid JSON" }));
            return;
          }

          turnCounter++;
          const messages = Array.isArray(body.messages) ? body.messages : [];
          let systemText = "";
          let lastUserPrompt = "";
          let hasToolResult = false;
          let toolResultText: string | undefined;

          for (const msg of messages) {
            if (msg.role === "system" && typeof msg.content === "string") {
              systemText += `${msg.content}\n`;
            }
            if (msg.role === "user") {
              lastUserPrompt =
                typeof msg.content === "string"
                  ? msg.content
                  : JSON.stringify(msg.content);
            }
            if (
              msg.role === "tool" ||
              (msg.role === "assistant" && msg.tool_call_id)
            ) {
              hasToolResult = true;
              toolResultText =
                typeof msg.content === "string"
                  ? msg.content
                  : JSON.stringify(msg.content);
            }
          }

          const match = systemText.match(
            /<omp-skill-kit>Relevant skills: (.*?)<\/omp-skill-kit>/,
          );
          const hasHintsBlock = Boolean(match);
          const hintsBlockText = match ? match[0] : "";
          const hintNames = match
            ? match[1]
                .split(",")
                .map((s: string) => s.trim())
                .filter(Boolean)
            : [];

          // Privacy verification: check the hints block itself
          const hasDescription =
            hintsBlockText.includes("Comprehensive corporate accounting") ||
            hintsBlockText.includes("financial ledgers") ||
            hintsBlockText.includes("Deep ocean marine biology");
          const hasPath =
            hintsBlockText.includes("tests/e2e/fixtures") ||
            hintsBlockText.includes("e2e-valid-skill/SKILL.md");
          const hasBody =
            hintsBlockText.includes("Detailed accounting guide") ||
            hintsBlockText.includes("Marine ecosystems guide");

          const promptHash = createHash("sha256")
            .update(lastUserPrompt)
            .digest("hex");

          const receipt: RequestReceipt = {
            turn: turnCounter,
            promptHash,
            hasHintsBlock,
            hintNames,
            hasDescription,
            hasPath,
            hasBody,
            hasToolResult,
            toolResultText: toolResultText
              ? toolResultText.slice(0, 100)
              : undefined,
            receivedAt: new Date().toISOString(),
          };
          receipts.push(receipt);

          const isStream = Boolean(body.stream);
          const shouldCallRead =
            !hasToolResult && hintNames.includes("e2e-valid-skill");

          if (isStream) {
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            });

            if (shouldCallRead) {
              const callId = `call_read_${Date.now()}`;
              const chunk1 = {
                id: `chatcmpl-${Date.now()}`,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: body.model || "test-model",
                choices: [
                  {
                    index: 0,
                    delta: {
                      role: "assistant",
                      tool_calls: [
                        {
                          index: 0,
                          id: callId,
                          type: "function",
                          function: {
                            name: "read",
                            arguments: JSON.stringify({
                              path: "skill://e2e-valid-skill",
                            }),
                          },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              };
              res.write(`data: ${JSON.stringify(chunk1)}\n\n`);
              const chunk2 = {
                id: `chatcmpl-${Date.now()}`,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: body.model || "test-model",
                choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
              };
              res.write(`data: ${JSON.stringify(chunk2)}\n\n`);
            } else {
              const reply = hasToolResult
                ? "Read tool result verified: " +
                  (toolResultText ? toolResultText.slice(0, 50) : "")
                : "Standard response without skills";
              const chunk1 = {
                id: `chatcmpl-${Date.now()}`,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: body.model || "test-model",
                choices: [
                  {
                    index: 0,
                    delta: { role: "assistant", content: reply },
                    finish_reason: null,
                  },
                ],
              };
              res.write(`data: ${JSON.stringify(chunk1)}\n\n`);
              const chunk2 = {
                id: `chatcmpl-${Date.now()}`,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: body.model || "test-model",
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              };
              res.write(`data: ${JSON.stringify(chunk2)}\n\n`);
            }

            res.write("data: [DONE]\n\n");
            res.end();
          } else {
            res.writeHead(200, { "Content-Type": "application/json" });
            if (shouldCallRead) {
              res.end(
                JSON.stringify({
                  id: `chatcmpl-${Date.now()}`,
                  object: "chat.completion",
                  created: Math.floor(Date.now() / 1000),
                  model: body.model || "test-model",
                  choices: [
                    {
                      index: 0,
                      message: {
                        role: "assistant",
                        content: null,
                        tool_calls: [
                          {
                            id: `call_read_${Date.now()}`,
                            type: "function",
                            function: {
                              name: "read",
                              arguments: JSON.stringify({
                                path: "skill://e2e-valid-skill",
                              }),
                            },
                          },
                        ],
                      },
                      finish_reason: "tool_calls",
                    },
                  ],
                }),
              );
            } else {
              const reply = hasToolResult
                ? "Read tool result verified: " +
                  (toolResultText ? toolResultText.slice(0, 50) : "")
                : "Standard response without skills";
              res.end(
                JSON.stringify({
                  id: `chatcmpl-${Date.now()}`,
                  object: "chat.completion",
                  created: Math.floor(Date.now() / 1000),
                  model: body.model || "test-model",
                  choices: [
                    {
                      index: 0,
                      message: { role: "assistant", content: reply },
                      finish_reason: "stop",
                    },
                  ],
                }),
              );
            }
          }
          return;
        }

        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
      },
    );

    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      const url = `http://127.0.0.1:${actualPort}/v1`;
      resolvePromise({
        port: actualPort,
        url,
        receipts,
        reset: () => {
          receipts.length = 0;
          turnCounter = 0;
        },
        stop: () =>
          new Promise((res) => {
            server.close(() => res());
          }),
      });
    });

    server.on("error", rejectPromise);
  });
}

export const BRIDGE_OPS = ["ping", "warmup", "rank", "shutdown"] as const;
export type BridgeOp = (typeof BRIDGE_OPS)[number];
export interface BridgeRequest<T = unknown> {
  id: string;
  op: BridgeOp;
  token: string;
  payload?: T;
}
export interface BridgeResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}
export interface RankPayload {
  prompt: string;
  promptHash: string;
  catalogHash: string;
  catalogPath: string;
  topK: number;
  sessionId: string;
}
export interface RankResult {
  candidates: Array<{ name: string; score: number }>;
}

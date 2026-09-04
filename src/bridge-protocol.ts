export const BRIDGE_OPS = [
  "ping",
  "warmup",
  "rank",
  "feedback",
  "shutdown",
] as const;
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
  routeId?: string;
  projectId?: string;
  projectName?: string;
}
export interface RankResult {
  candidates: Array<{ name: string; score: number }>;
  feedbackApplied?: boolean;
  feedbackAdjusted?: number;
}
export interface FeedbackPayload {
  routeId: string;
  projectId: string;
  skillNames: string[];
  verdict: "helpful" | "harmful" | "neutral";
}

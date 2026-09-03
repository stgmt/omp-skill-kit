export const PLUGIN_NAME = "omp-skill-kit";
export const PROTOCOL_VERSION = 1;
export const ROUTE_TIMEOUT_MS = Number(
  process.env.OMP_SKILL_KIT_ROUTE_TIMEOUT_MS || 2500,
);
export const MAX_CANDIDATES = 3;
export const MAX_CANDIDATE_HINT_BYTES = 512;
export const MAX_REQUEST_BYTES = 64 * 1024;
export const MAX_RESPONSE_BYTES = 16 * 1024;
export const BRIDGE_IDLE_SHUTDOWN_MS = 30 * 60 * 1000;
export const ROUTE_RESTART_CAP = 1;
export const MANIFEST_SCHEMA_VERSION = 1;
export const STATE_SCHEMA_VERSION = 1;
export const RETRY_BACKOFF_MS = [60_000, 300_000, 1_800_000];
export const PORT_PREFERRED = 7531;
export const UNDEFINED_NAME = "unknown";

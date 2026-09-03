import { join } from "node:path";

export function buildXdgEnv(home: string): Record<string, string> {
  return {
    OMP_SKILL_KIT_HOME: home,
    XDG_CONFIG_HOME: join(home, "xdg", "config"),
    XDG_DATA_HOME: join(home, "xdg", "data"),
    XDG_CACHE_HOME: join(home, "xdg", "cache"),
    HF_HOME: join(home, "models"),
    SENTENCE_TRANSFORMERS_HOME: join(home, "models", "sentence-transformers"),
  };
}

import { describe, expect, it } from "vitest";
import { safeSkillName } from "../../src/shared/fsx.js";

describe("mutation guards", () => {
  it.each(["../escape", "/absolute", "C:\\escape", "", "a/../b"])(
    "rejects unsafe skill name %s",
    (name) => {
      expect(safeSkillName(name)).toBe(false);
    },
  );
  it("keeps valid names accepted", () =>
    expect(safeSkillName("mega-tron.dashboard")).toBe(true));
});

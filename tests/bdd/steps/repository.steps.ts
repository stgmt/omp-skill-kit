import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Given, Then, When } from "@cucumber/cucumber";

const root = join(fileURLToPath(new URL("../../../", import.meta.url)));
let text = "";

Given("the omp-skill-kit repository exists", async () => {
  await readFile(join(root, "package.json"), "utf8");
});
When("I inspect the plugin manifest", async () => {
  text = await readFile(join(root, "package.json"), "utf8");
});
When("I inspect the skill catalog fixture", async () => {
  text = await readFile(
    join(root, "skills", "mega-tron-dashboard", "SKILL.md"),
    "utf8",
  );
});
When("I inspect the bridge protocol", async () => {
  text = await readFile(join(root, "src", "bridge-protocol.ts"), "utf8");
});
When("I inspect the routing constants", async () => {
  text = await readFile(join(root, "src", "shared", "constants.ts"), "utf8");
});
When("I inspect the runtime manifest", async () => {
  text = await readFile(join(root, "runtime-manifest.json"), "utf8");
});
When("I inspect the extension source", async () => {
  text = await readFile(join(root, "src", "extension.ts"), "utf8");
});
When("I inspect package metadata", async () => {
  text = await readFile(join(root, "package.json"), "utf8");
});
Then("it declares the extension bundle", () =>
  assert.match(text, /dist\/extension\.js/),
);
Then("the fixture contains only a name and description", () => {
  assert.match(text, /name:/);
  assert.match(text, /description:/);
});
Then("the protocol exposes ping warmup rank and shutdown", () => {
  for (const op of ["ping", "warmup", "rank", "shutdown"])
    assert.match(text, new RegExp(op));
});
Then("routing has a 750 millisecond deadline", () =>
  assert.match(text, /ROUTE_TIMEOUT_MS = 750/),
);
Then("the manifest pins uv and mega-tron digests", () => {
  assert.match(text, /sha256/);
  assert.match(text, /0ed290a1df1739af5cf4291d0ad8155afc7af16b/);
});
Then("it registers status setup doctor purge and dashboard", () => {
  for (const command of ["status", "setup", "doctor", "purge", "dashboard"])
    assert.match(text, new RegExp(`registerCommand\\(\\"${command}`));
});
Then("npm publication is disabled", () =>
  assert.equal(JSON.parse(text).private, true),
);

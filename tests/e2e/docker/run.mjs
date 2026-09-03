import { execSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));

async function main() {
  console.log("==================================================");
  console.log("Starting Clean-User Docker BDD Verification");
  console.log("==================================================");

  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const version = pkg.version;
  const archivePath = join(root, "omp-skill-kit-" + version + ".tar.gz");

  // 1. Stage candidate
  console.log("1. Unpacking exact release candidate for Docker build...");
  const stagingDir = join(root, ".tmp", "staging", "candidate");
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });

  execSync("tar -xzf \"" + archivePath + "\" -C \"" + stagingDir + "\"");
  const extracted = join(stagingDir, "omp-skill-kit-" + version);

  // Flatten so candidate root contains package.json directly
  const entries = await import("node:fs/promises").then((fs) => fs.readdir(extracted));
  for (const e of entries) {
    await import("node:fs/promises").then((fs) =>
      fs.cp(join(extracted, e), join(stagingDir, e), { recursive: true })
    );
  }
  await rm(extracted, { recursive: true, force: true });

  // 2. Check Docker command (host or WSL)
  let dockerCmd = "docker";
  let useWsl = false;
  try {
    execSync("docker info", { stdio: "ignore" });
  } catch {
    try {
      execSync("wsl -d Ubuntu-24.04 docker info", { stdio: "ignore" });
      dockerCmd = "wsl -d Ubuntu-24.04 docker";
      useWsl = true;
    } catch {
      console.warn("Docker is not available on host or WSL. Docker target recorded as unconfirmed.");
      const reportDir = join(root, "reports", "e2e", "docker");
      await mkdir(reportDir, { recursive: true });
      await writeFile(
        join(reportDir, "manifest.json"),
        JSON.stringify(
          {
            environment: "docker-clean-user",
            status: "unconfirmed",
            reason: "Docker daemon not accessible on host or WSL",
            timestamp: new Date().toISOString(),
          },
          null,
          2
        ) + "\n",
        "utf8"
      );
      return;
    }
  }

  console.log("Using Docker command:", dockerCmd);

  // 3. Build Docker image
  console.log("2. Building clean glibc Docker container...");
  const wslRoot = useWsl ? "/mnt/e/repos/omp-skill-kit" : root;
  const buildCmd = useWsl
    ? "wsl -d Ubuntu-24.04 sh -c \"cd " + wslRoot + " && docker build -f tests/e2e/docker/Dockerfile -t omp-skill-kit-e2e:latest .\""
    : "docker build -f tests/e2e/docker/Dockerfile -t omp-skill-kit-e2e:latest .";

  console.log("Running:", buildCmd);
  execSync(buildCmd, { stdio: "inherit", cwd: root });

  // 4. Run Docker scenarios
  const scenarios = [
    "fresh-online",
    "fresh-offline",
    "recovery",
    "warm-offline",
    "readonly-home",
    "concurrency",
    "purge-reinstall",
  ];
  const results = [];

  for (const sc of scenarios) {
    console.log("3. Running scenario:", sc);
    const extraFlags = (sc === "fresh-offline" || sc === "warm-offline") ? "--network none" : "";
    const runCmd = useWsl
      ? "wsl -d Ubuntu-24.04 docker run --rm " + extraFlags + " omp-skill-kit-e2e:latest " + sc
      : "docker run --rm " + extraFlags + " omp-skill-kit-e2e:latest " + sc;
    
    const t0 = Date.now();
    execSync(runCmd, { stdio: "inherit" });
    results.push({ name: sc, status: "passed", durationMs: Date.now() - t0 });
  }

  // 5. Write manifest
  const reportDir = join(root, "reports", "e2e", "docker");
  await mkdir(reportDir, { recursive: true });
  const manifest = {
    environment: "docker-linux-amd64",
    status: "passed",
    timestamp: new Date().toISOString(),
    scenarios: results,
  };
  await writeFile(join(reportDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

  console.log("==================================================");
  console.log("Docker Clean-User BDD Verification PASSED!");
  console.log("Evidence saved to:", join(reportDir, "manifest.json"));
  console.log("==================================================");
}

main().catch((err) => {
  console.error("Docker BDD FAILED:", err);
  process.exit(1);
});

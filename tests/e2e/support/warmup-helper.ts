import { join } from "node:path";
import { CatalogStore, loadEligibleCatalog } from "../../../src/catalog.js";
import { RouterClient } from "../../../src/router-client.js";
import { rpcCall } from "../../../src/rpc.js";

const home = process.argv[2];
const cwd = process.argv[3];

async function main() {
  const client = new RouterClient(home, process.cwd());
  const bridgeReady = await client.ensureBridge(15000);
  if (!bridgeReady) throw new Error("Could not ensure bridge in warmup helper");
  await client.loadEndpoint();
  const endpoint = (client as any).endpoint;
  if (!endpoint) throw new Error(`Bridge endpoint not found in home: ${home}`);

  const entries = await loadEligibleCatalog(cwd);
  const catalogs = new CatalogStore(join(home, "catalogs"));
  const snapshot = await catalogs.publish(entries);
  console.log(
    "Helper published revision:",
    snapshot.revision,
    "with entries:",
    entries.length,
  );

  const res = await rpcCall(
    {
      id: `warmup-${Date.now()}`,
      op: "warmup",
      token: endpoint.token,
      payload: {
        catalogHash: snapshot.revision,
        catalogPath: join(home, "catalogs", snapshot.revision, "catalog.json"),
      },
    },
    { port: endpoint.port, token: endpoint.token, timeoutMs: 60000 },
  );
  console.log("Bridge warmup response:", res);
}

main().catch((e) => {
  console.error("Warmup helper failed:", e);
  process.exit(1);
});

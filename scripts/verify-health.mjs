import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
const baseUrl = (process.env.NINEROUTER_URL || "http://127.0.0.1:20128").replace(/\/+$/, "");
const expectedCommit = process.env.NINEROUTER_EXPECTED_COMMIT || null;
const timeoutMs = Number(process.env.NINEROUTER_HEALTH_TIMEOUT_MS || 10000);

async function getJson(route) {
  const response = await fetch(`${baseUrl}${route}`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${route} returned HTTP ${response.status}: ${body.slice(0, 300)}`);
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`${route} returned invalid JSON`);
  }
}

try {
  const health = await getJson("/api/health");
  if (health?.ok !== true) throw new Error("/api/health did not report ok=true");
  console.log(`[verify-health] health: ready (${baseUrl})`);

  const version = await getJson("/api/version");
  if (version?.currentVersion !== packageJson.version) {
    throw new Error(
      `/api/version reports ${version?.currentVersion || "unknown"}; expected ${packageJson.version}`,
    );
  }
  console.log(`[verify-health] version: ${version.currentVersion}`);

  const buildCommit = version?.build?.commit || "unknown";
  if (expectedCommit && buildCommit !== expectedCommit && buildCommit !== `${expectedCommit}-dirty`) {
    throw new Error(`build commit ${buildCommit} does not match ${expectedCommit}`);
  }
  if (expectedCommit) console.log(`[verify-health] build: ${buildCommit}`);
  else if (buildCommit === "unknown") console.warn("[verify-health] WARNING: build commit is unknown");

  console.log("[verify-health] result: PASS");
} catch (error) {
  console.error(`[verify-health] ERROR: ${error.message}`);
  process.exitCode = 1;
}

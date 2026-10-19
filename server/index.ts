import { loadConfig, isLoopbackHost, envFileStatus } from "./config";
import { buildApp } from "./app";

function checkNode(): void {
  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj < 22 || (maj === 22 && min < 13)) {
    console.error(`Overround Lab needs Node.js 22.13 or newer (found ${process.versions.node}). Install the current LTS from https://nodejs.org/.`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  checkNode();
  const config = loadConfig();
  if (!isLoopbackHost(config.host)) {
    if (!config.allowRemote) {
      console.error(`HOST=${config.host} would expose the app to your network. Set ALLOW_REMOTE=1 (and INSTRUCTOR_PIN) only if you really intend that.`);
      process.exit(1);
    }
    if (!config.instructorPin) {
      console.error("Network exposure (ALLOW_REMOTE=1) requires INSTRUCTOR_PIN to be set.");
      process.exit(1);
    }
  }
  const ctx = await buildApp({ config, startScheduler: true, logger: false });
  try {
    await ctx.app.listen({ host: config.host, port: config.port });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "EADDRINUSE") console.error(`Port ${config.port} is already in use. Set PORT in .env or stop the other program.`);
    else console.error(`Could not start server: ${err.message}`);
    process.exit(1);
  }
  const url = `http://${config.host === "::1" ? "[::1]" : config.host}:${config.port}`;
  const s = ctx.settings.get();
  console.log("");
  console.log("  Overround Lab — sports market classroom (simulation points only)");
  console.log(`  Open ${url}`);
  console.log(`  Data folder: ${config.dataDir}`);
  console.log(`  Scheduler: ${s.scheduler.paused ? "paused" : "running"} — scheduled scans run only while this window stays open.`);
  const env = envFileStatus();
  console.log(`  Settings file: ${env?.path ?? ".env"} (${env?.found ? `found, ${env.keys.length} setting(s)` : "not found"})`);
  console.log(`  Odds API key: ${config.oddsApiKey ? "configured" : "not set (demo and keyless providers still work)"}`);
  console.log(`  balldontlie key: ${config.balldontlieApiKey ? "configured" : "not set"}`);
  for (const h of env?.hints ?? []) console.log(`  ! ${h}`);
  console.log("  Press Ctrl+C to stop.");
  console.log("");
  // Fit the models in the background right away so the first page load does not wait for them.
  setTimeout(() => ctx.warmup(), 50);

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(`\n${signal} received — stopping. Scheduled scans stop with the app.`);
    try {
      await ctx.app.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main();

// Starts the built server on a throw-away data directory for end-to-end tests.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const port = process.argv[2] ?? "5199";
const dataDir = mkdtempSync(path.join(tmpdir(), "overround-e2e-"));
const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "build/server.mjs"], {
  stdio: "inherit",
  env: { ...process.env, PORT: port, HOST: "127.0.0.1", OVERROUND_DATA_DIR: dataDir, ODDS_API_KEY: "", ANTHROPIC_API_KEY: "", INSTRUCTOR_PIN: "" },
});
const stop = () => child.kill();
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
child.on("exit", (code) => process.exit(code ?? 0));

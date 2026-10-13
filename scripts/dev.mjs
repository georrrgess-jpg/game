// Development: runs the API server (auto-restarting) and the Vite dev server together.
import { spawn } from "node:child_process";

const procs = [
  spawn("npx", ["tsx", "watch", "--clear-screen=false", "server/index.ts"], {
    stdio: "inherit",
    env: { ...process.env, NODE_OPTIONS: "--disable-warning=ExperimentalWarning", OVERROUND_DEV: "1" },
    shell: process.platform === "win32",
  }),
  spawn("npx", ["vite"], { stdio: "inherit", shell: process.platform === "win32" }),
];
const stop = () => { for (const p of procs) p.kill(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const p of procs) p.on("exit", (code) => { if (code) stop(); });

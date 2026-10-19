// Runs before `npm start`, `npm run serve`, `npm run build` and `npm run dev` to turn common setup
// problems into plain instructions instead of cryptic errors. Uses only Node built-ins.

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath handles Windows drive letters and spaces in folder names ("Betting Simulator").
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  problems.push(
    `Overround Lab needs Node.js 22.13 or newer, but this computer has ${process.versions.node}.\n` +
      "  Install the current LTS version from https://nodejs.org/, close this window, open a new one, and try again.",
  );
}

const needed = ["vite", "fastify", "react", "luxon"];
const missing = needed.filter((m) => !existsSync(path.join(root, "node_modules", m, "package.json")));
if (missing.length) {
  problems.push(
    "The project's dependencies are not installed yet (missing: " + missing.join(", ") + ").\n" +
      "  Run this once in this folder, wait for it to finish, then run npm start again:\n\n" +
      "      npm install\n",
  );
}

if (problems.length) {
  console.error("\nOverround Lab cannot start yet:\n");
  for (const p of problems) console.error("- " + p + "\n");
  process.exit(1);
}

if (/onedrive/i.test(root)) {
  console.warn(
    "\nNote: this folder is inside OneDrive. OneDrive syncing can lock or slow down the database and the\n" +
      "node_modules folder. If you see odd errors, move the folder somewhere not synced (for example\n" +
      "C:\\OverroundLab), run npm install there, and start it from there.\n",
  );
}

import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";

const PORT = 5199;
// Use the system's preinstalled Chromium when Playwright's own download is unavailable.
const preinstalled = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const launchOptions = existsSync(preinstalled) ? { executablePath: preinstalled } : {};

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "off", launchOptions },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1366, height: 900 }, launchOptions } },
    { name: "mobile", use: { ...devices["Pixel 7"], launchOptions } },
  ],
  webServer: {
    command: `node scripts/e2e-server.mjs ${PORT}`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    timeout: 120_000,
    reuseExistingServer: false,
  },
});

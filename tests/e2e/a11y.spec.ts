import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

// axe-core is injected into the page, so this file alone bypasses the app's strict CSP.
test.use({ bypassCSP: true });

const AXE = readFileSync(path.join(process.cwd(), "node_modules", "axe-core", "axe.min.js"), "utf8");

for (const theme of ["dark", "light"] as const) {
  test(`no accessibility violations on any page (${theme} theme)`, async ({ page }) => {
    await page.addInitScript((t) => localStorage.setItem("overround.prefs", JSON.stringify({ theme: t, motion: "reduce", textScale: 1, highContrast: false })), theme);
    await page.goto("/");
    await expect(page.locator(".game-card").first()).toBeVisible();
    const gameHref = await page.locator(".teams a").first().getAttribute("href");
    const pages = ["/", "/games", "/markets", "/evidence", "/lab", "/report", "/settings", gameHref!];
    const problems: string[] = [];
    for (const p of pages) {
      await page.goto(p);
      await expect(page.locator("h1")).toBeVisible();
      await page.waitForLoadState("networkidle");
      await page.addScriptTag({ content: AXE });
      const violations = await page.evaluate(async () => {
        const r = await (window as any).axe.run(document, { resultTypes: ["violations"] });
        return r.violations.map((v: any) => `${v.impact} ${v.id}: ${v.nodes.map((n: any) => n.target.join(" ")).slice(0, 3).join(" | ")}`);
      });
      problems.push(...violations.map((v: string) => `${p} ${v}`));
    }
    expect(problems).toEqual([]);
  });
}

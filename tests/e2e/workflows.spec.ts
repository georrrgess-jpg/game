import { test, expect, type Page } from "@playwright/test";

const consoleProblems: string[] = [];

test.beforeEach(async ({ page }) => {
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") consoleProblems.push(`${m.type()}: ${m.text()}`);
  });
  page.on("pageerror", (e) => consoleProblems.push(`pageerror: ${e.message}`));
  // Start each test from the demo dataset with default preferences.
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("e2e-init")) {
      localStorage.clear();
      sessionStorage.setItem("e2e-init", "1");
    }
  });
});

test.afterEach(() => {
  const problems = consoleProblems.splice(0);
  expect(problems, "browser console should stay clean").toEqual([]);
});

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test("Analyze Today: board, three views and visible status", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("status").filter({ hasText: "Demo · fictional data" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("2026");
  await page.getByRole("button", { name: /Analyze Today/ }).click();
  await expect(page.getByText(/Analysis complete/)).toBeVisible();
  await expect(page.getByText(/Recorded \d+ system forecast/)).toBeVisible();
  await expect(page.locator(".game-card").first()).toBeVisible();
  await noHorizontalOverflow(page);

  // Keyboard: arrow keys move between board views.
  await page.getByRole("tab", { name: "Most likely outcomes" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Highest quoted price" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText(/Highest quoted price among connected sources as of/).first()).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Model vs market" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText(/No credible model–market differences|research lead/).first()).toBeVisible();
  await noHorizontalOverflow(page);
});

test("Selected game: estimates, quotes, evidence and a hypothetical scenario", async ({ page }) => {
  await page.goto("/games");
  await page.getByLabel("Team or game").fill("Owls");
  // Today's Owls game: the scripted conflicting reports were published that morning.
  const today = page.locator("section").filter({ has: page.getByText("today", { exact: true }) });
  const link = today.getByRole("link", { name: /Owls/ }).first();
  await expect(link).toBeVisible();
  await link.click();
  await expect(page.getByRole("heading", { name: "Estimates" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Quote comparison" })).toBeVisible();
  await expect(page.getByText("Market reference").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "What is the current estimate?" })).toBeVisible();
  await expect(page.getByText(/Conflicting reports/).first()).toBeVisible();
  await page.getByRole("button", { name: /Show data table/ }).first().click();
  await expect(page.locator("figure table").first()).toBeVisible();
  await page.getByLabel(/Play at a neutral site/).check();
  await page.getByLabel("Hypothetical price").fill("+120");
  await page.getByRole("button", { name: "Compute scenario" }).click();
  await expect(page.getByRole("columnheader", { name: "Hypothetical scenario" })).toBeVisible();
  await expect(page.getByText(/Hypothetical price 2.20/)).toBeVisible();
  await expect(page.getByText(/Break-even probability 45.5%/)).toBeVisible();
  await noHorizontalOverflow(page);
});

test("Classroom: forecast first, advance the demo day, reveal and score", async ({ page }, info) => {
  const author = `Student ${info.project.name}`;
  await page.goto("/lab");
  await page.getByLabel("Your name or nickname").fill(author);
  const firstOpen = page.locator("article").filter({ has: page.getByRole("button", { name: "Save forecast" }) }).first();
  const cardId = await firstOpen.getAttribute("id");
  const card = page.locator(`article[id="${cardId}"]`);
  await card.getByRole("slider").first().fill("62");
  await card.getByRole("button", { name: "Save forecast" }).click();
  await expect(card.getByRole("button", { name: "Saved" })).toBeVisible();
  await expect(card.getByText(/Market reference:/)).toBeVisible(); // revealed only after saving

  await page.getByRole("tab", { name: "Results & scoring" }).click();
  await expect(page.getByRole("cell", { name: author }).first()).toBeVisible();
  await page.getByRole("tab", { name: "Instructor" }).click();
  await page.getByRole("button", { name: /Advance a day/ }).click();
  await expect(page.getByText(/Demo clock advanced/)).toBeVisible();
  await page.getByRole("tab", { name: "Results & scoring" }).click();
  await page.getByRole("button", { name: /Reveal results/ }).click();
  await expect(page.getByRole("heading", { name: /Scoreboard/ })).toBeVisible();
  await expect(page.getByText(/pick correct|pick wrong|void/).first()).toBeVisible();

  await page.getByRole("tab", { name: "Instructor" }).click();
  await page.getByRole("button", { name: /Reset demo clock/ }).click();
  await expect(page.getByText(/Demo clock reset/)).toBeVisible();
  await noHorizontalOverflow(page);
});

test("Historical replay and connected mode are clearly labelled", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Replay a past moment" }).click();
  const dialog = page.getByRole("dialog", { name: "Historical replay" });
  await dialog.getByLabel(/Information time/).fill("2026-05-20T11:00");
  await dialog.getByRole("button", { name: "Start replay" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Historical replay" })).toBeVisible();
  await expect(page.getByText(/Information frozen at/)).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("May 20");
  await page.getByRole("button", { name: "Exit replay" }).first().click();
  await expect(page.getByRole("status").filter({ hasText: "Demo · fictional data" })).toBeVisible();

  await page.getByRole("button", { name: "Connected", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Connected data" })).toBeVisible();
  await expect(page.getByText("No connected data yet.")).toBeVisible();
  await expect(page.getByText(/No games on this day/)).toBeVisible();
  await page.getByRole("button", { name: "Demo", exact: true }).click();
});

test("Every page renders without overflow, and keyboard focus is visible", async ({ page }) => {
  for (const path of ["/", "/value", "/lines", "/learn", "/games", "/markets", "/evidence", "/lab", "/report", "/settings"]) {
    await page.goto(path);
    await expect(page.locator("h1")).toBeVisible();
    await noHorizontalOverflow(page);
  }
  await page.goto("/report");
  await expect(page.getByRole("heading", { name: /Holdout results/ })).toBeVisible();
  await expect(page.getByText(/Calibration on the holdout season/)).toBeVisible();
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "The Odds API (v4)" })).toBeVisible();
  await expect(page.getByText(/Not configured \(no key\)/).first()).toBeVisible();
  // Skip link is the first focus stop and has a visible outline (keyboard users; not applicable to touch).
  if (test.info().project.name === "mobile") return;
  await page.goto("/");
  await expect(page.locator("h1")).toBeVisible(); // wait for the app to render before pressing Tab
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  const outline = await skip.evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outline).not.toBe("none");
});

test("Preferences: theme and reduced motion apply", async ({ page }) => {
  await page.goto("/settings");
  await page.getByRole("tab", { name: "Appearance & accessibility" }).click();
  await page.getByRole("button", { name: "Dark studio" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Reduce motion" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-motion", "reduce");
  await page.getByRole("button", { name: "Largest" }).click();
  await noHorizontalOverflow(page);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("Value Finder: likelihood and value are separate views, with an honest track record", async ({ page }) => {
  await page.goto("/value");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("2026");
  await expect(page.getByRole("heading", { name: "Highest estimated chance of winning" })).toBeVisible();
  await expect(page.locator("table").first()).toContainText("Break-even");
  await page.getByRole("tab", { name: "Price discrepancies" }).click();
  await expect(page.getByRole("heading", { name: "Prices that beat the consensus" })).toBeVisible();
  await page.getByRole("tab", { name: "Arbitrage" }).click();
  await expect(page.getByRole("heading", { name: "Arbitrage", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Track record" }).click();
  await expect(page.getByRole("heading", { name: "Price beats the consensus (grade B rule)" })).toBeVisible();
  await expect(page.getByText(/Closing line value, 95% interval/).first()).toBeVisible();
  await expect(page.getByText(/\block\b|guaranteed win/i)).toHaveCount(0);
  await noHorizontalOverflow(page);
  // Sport filter
  await page.getByRole("tab", { name: "Most likely" }).click();
  await page.getByLabel("Sport", { exact: true }).selectOption("demo_tennis");
  await expect(page.locator("tbody tr").first()).toContainText("Tennis (fictional)");
});

test("Average Lines lists average, best, worst and fair prices per game", async ({ page }) => {
  await page.goto("/lines");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("2026");
  const card = page.locator("article.card").filter({ hasText: "Football (fictional)" }).first();
  await expect(card).toBeVisible();
  await expect(card.getByText("Moneyline 2-way")).toBeVisible();
  await expect(card.getByText("Spread", { exact: true })).toBeVisible();
  await expect(card.getByText(/average across books/).first()).toBeVisible();
  await expect(card.locator("thead").first()).toContainText("Fair (no margin)");
  await noHorizontalOverflow(page);
  await page.getByRole("link", { name: "Average Lines" }).first().isVisible();
});

test("Knowledge Center: search topics and use the calculators", async ({ page }) => {
  await page.goto("/learn");
  await page.getByLabel("Search topics").fill("odds format");
  await expect(page.getByText("Odds formats: American, decimal, fractional")).toBeVisible();
  const conv = page.getByLabel("Price (American, decimal or fractional)");
  await conv.fill("+150");
  const calc = page.locator(".card-tight").filter({ hasText: "Odds converter" });
  await expect(calc.getByText("3/2", { exact: true })).toBeVisible();
  await expect(calc.getByText("40.00%", { exact: true })).toBeVisible();
  await conv.fill("+50");
  await expect(page.getByText(/at least \+100 or at most -100/)).toBeVisible();
  await page.getByLabel("Search topics").fill("arbitrage");
  await expect(page.getByText(/Arbitrage: a guaranteed/)).toBeVisible();
  await page.getByLabel("Search topics").fill("");
  await page.getByRole("button", { name: "Expand all" }).click();
  await expect(page.getByText(/1-800-GAMBLER/)).toBeVisible();
  await noHorizontalOverflow(page);
});

test("Football game page shows spreads and totals with push chances", async ({ page }) => {
  await page.goto("/games/demo-ft-2026-06-16-ELM-ISL");
  await expect(page.getByRole("heading", { name: "Spreads and totals" })).toBeVisible();
  await expect(page.locator("table").filter({ hasText: "Model win / push" }).first()).toBeVisible();
  await noHorizontalOverflow(page);
});

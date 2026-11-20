import { expect, test } from "@playwright/test";

// Uses the normal throwaway E2E instance. This checks the local setup entry,
// not account consent or a live Railway deployment.
test("Railway is hidden in Delegra's catalog and its OAuth setup remains available", async ({ page, request }) => {
  test.setTimeout(120000);
  const response = await request.post("/api/companies", { data: { name: `Railway catalog QA ${Date.now()}` } });
  expect(response.ok()).toBe(true);
  const company = await response.json();
  await page.goto(`/${company.issuePrefix}/apps`, { waitUntil: "domcontentloaded" });
  await page.getByRole("searchbox", { name: "Search connectors" }).fill("Railway");
  await expect(page.getByText("No connectors match “Railway”.", { exact: true })).toBeVisible();
  await page.goto(`/${company.issuePrefix}/apps/connect?source=railway`);
  await expect(page).toHaveURL(/\/apps\/connect\?/, { timeout: 20000 });
  await expect(page.getByRole("heading", { name: /Railway/ }).first()).toBeVisible();
  await expect(page.getByText(/Project tokens are not supported/)).toBeVisible();
  await expect(page.getByText(/Live Railway qualification is pending/)).toBeVisible();
  await page.screenshot({ path: "tests/e2e/test-results/railway-oauth-setup.png", fullPage: true });
});

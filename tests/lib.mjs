// Shared helpers for the test scripts.
import { chromium } from "playwright-core";

/** Fixture folder, created by `python3 make-fixtures.py`. */
export const FX = new URL("./fixtures/", import.meta.url).pathname;

/**
 * Launch Chromium. Uses CHROMIUM_PATH when set, otherwise the browser Playwright finds
 * through PLAYWRIGHT_BROWSERS_PATH (playwright-core 1.56 expects chromium-1194).
 */
export function launch(extraArgs = []) {
  return chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ["--no-sandbox", ...extraArgs],
  });
}

/**
 * Browser-style manual check for Pulse (Playwright Chromium).
 * Prerequisites: API :5050, Vite :5173, seeded alice/bob.
 *
 *   node scripts/browser-manual-check.mjs
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.BROWSER_BASE || 'http://127.0.0.1:5173';
const PW = process.env.SMOKE_PASSWORD || 'PulseCi_Test9x';
const SHOT = path.join(ROOT, 'logs', 'browser-check');
const results = [];
let failed = 0;

function ok(name, detail = '') {
  results.push({ name, pass: true, detail });
  console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`);
}
function fail(name, err) {
  failed += 1;
  const detail = err instanceof Error ? err.message : String(err);
  results.push({ name, pass: false, detail });
  console.error(`  ✗ ${name} — ${detail}`);
}

async function shot(page, name) {
  fs.mkdirSync(SHOT, { recursive: true });
  const file = path.join(SHOT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

async function main() {
  console.log(`\nPulse browser check → ${BASE}\n`);
  fs.mkdirSync(SHOT, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(err.message));

  // Clean session so /login is reachable
  try {
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.evaluate(() => {
      try {
        localStorage.clear();
        sessionStorage.clear();
      } catch {
        /* */
      }
    });
    await context.clearCookies();
  } catch {
    /* */
  }

  // ── 1. Login page ─────────────────────────────────────────
  try {
    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle', timeout: 30_000 });
    await page.getByText('Welcome back', { exact: false }).waitFor({ timeout: 15_000 });
    await page.getByPlaceholder('you@example.com').waitFor();
    await page.getByRole('button', { name: 'Sign in' }).waitFor();
    await page.getByRole('link', { name: /Forgot password/i }).waitFor();
    await shot(page, '01-login');
    ok('login page renders', 'Welcome back + form');
  } catch (e) {
    fail('login page renders', e);
  }

  // ── 2. Bad login toast ────────────────────────────────────
  try {
    await page.getByPlaceholder('you@example.com').fill('alice');
    await page.locator('#password').fill('WrongPassword999!');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForTimeout(800);
    // stay on login
    if (!page.url().includes('login')) throw new Error('left login on bad password: ' + page.url());
    await shot(page, '02-bad-login');
    ok('bad password stays on login');
  } catch (e) {
    fail('bad password stays on login', e);
  }

  // ── 3. Successful login ───────────────────────────────────
  try {
    await page.locator('#password').fill(PW);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL((u) => !u.pathname.includes('login'), { timeout: 20_000 });
    // Chat shell: header + icon (duplicate "New chat" buttons → use first icon)
    await page.locator('button[aria-label="New chat"]').first().waitFor({ timeout: 20_000 });
    await shot(page, '03-chat-shell');
    ok('login → chat shell', page.url());
  } catch (e) {
    fail('login → chat shell', e);
    await shot(page, '03-fail').catch(() => {});
  }

  // ── 4. Sidebar filters ────────────────────────────────────
  try {
    for (const label of ['Chats', 'Groups', 'Calls', 'Pinned']) {
      const tab = page.getByRole('button', { name: label }).first();
      if (await tab.count()) {
        await tab.click();
        await page.waitForTimeout(200);
      }
    }
    const chats = page.getByRole('button', { name: 'Chats' }).first();
    if (await chats.count()) await chats.click();
    await shot(page, '04-sidebar-filters');
    ok('sidebar filters clickable');
  } catch (e) {
    fail('sidebar filters clickable', e);
  }

  // ── 5. New chat → bob ─────────────────────────────────────
  try {
    await page.locator('button[aria-label="New chat"]').first().click();
    await page.getByPlaceholder(/Search users/i).waitFor({ timeout: 10_000 });
    await page.getByPlaceholder(/Search users/i).fill('bob');
    await page.waitForTimeout(700);
    const bobRow = page
      .locator('button.menu-item, button')
      .filter({ hasText: /^bob$|@bob|Bob/i })
      .first();
    // Prefer username row
    const byText = page.getByText('@bob', { exact: false }).first();
    if (await byText.count()) {
      await byText.click();
    } else {
      await bobRow.waitFor({ timeout: 10_000 });
      await bobRow.click();
    }
    await page.getByPlaceholder('Message…').waitFor({ timeout: 15_000 });
    await shot(page, '05-dm-open');
    ok('open DM with bob');
  } catch (e) {
    fail('open DM with bob', e);
    await shot(page, '05-fail').catch(() => {});
  }

  // ── 6. Send text message ──────────────────────────────────
  try {
    const box = page.getByPlaceholder('Message…');
    const text = `Browser check ${Date.now()}`;
    await box.fill(text);
    await page.locator('button[aria-label="Send"]').click();
    await page.getByText(text).waitFor({ timeout: 10_000 });
    await shot(page, '06-message-sent');
    ok('send text message', text.slice(0, 40));
  } catch (e) {
    fail('send text message', e);
  }

  // ── 7. Pulse Play picker (all 4 games visible) ─────────────
  try {
    await page.locator('button[aria-label="Play a game"]').first().click();
    await page.getByRole('dialog', { name: 'Play a game' }).waitFor({ timeout: 10_000 });
    await page.waitForTimeout(600);
    const body = await page.getByRole('dialog', { name: 'Play a game' }).innerText();
    const need = ['Tic', 'Connect', 'Trivia', 'Emoji'];
    const missing = need.filter((n) => !new RegExp(n, 'i').test(body));
    if (missing.length) throw new Error('missing games in picker: ' + missing.join(','));
    await shot(page, '07-play-picker');
    ok('Play picker shows 4 games', body.replace(/\s+/g, ' ').slice(0, 100));
    // Backdrop close can be obscured by the sheet; Escape is the reliable path
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  } catch (e) {
    fail('Play picker shows 4 games', e);
    await shot(page, '07-fail').catch(() => {});
    await page.keyboard.press('Escape').catch(() => {});
  }

  // ── 8. Games panel ────────────────────────────────────────
  try {
    const gamesBtn = page.locator('button[aria-label*="Games"]').first();
    if (await gamesBtn.count()) {
      await gamesBtn.click();
      await page.waitForTimeout(500);
      await shot(page, '08-games-panel');
      ok('Games history panel opens');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
    } else {
      ok('Games history button absent (skip)');
    }
  } catch (e) {
    fail('Games history panel opens', e);
  }

  // ── 9. Call buttons present (don't place real call) ───────
  try {
    await page.locator('button[aria-label*="Voice call"], button[aria-label*="voice call"]').first().waitFor({
      timeout: 5_000,
    });
    await page.locator('button[aria-label*="Video call"], button[aria-label*="video call"]').first().waitFor({
      timeout: 5_000,
    });
    ok('voice + video call buttons visible');
  } catch (e) {
    fail('voice + video call buttons visible', e);
  }

  // ── 10. Settings ──────────────────────────────────────────
  try {
    await page.locator('button[aria-label="Settings"]').first().click();
    await page.waitForTimeout(700);
    await shot(page, '09-settings');
    const hasSettings =
      (await page.getByText(/theme|privacy|security|account|Appearance|Profile/i).count()) > 0;
    if (!hasSettings) throw new Error('settings UI not obvious');
    ok('settings opens');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  } catch (e) {
    fail('settings opens', e);
  }

  // ── 11. Mobile viewport chat ──────────────────────────────
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(500);
    await shot(page, '10-mobile-chat');
    await page.getByPlaceholder('Message…').waitFor({ timeout: 8_000 });
    await page.locator('button[aria-label="Play a game"]').first().waitFor({ timeout: 5_000 });
    ok('mobile viewport chat usable');
  } catch (e) {
    fail('mobile viewport chat usable', e);
  }

  // ── 12. Mobile play picker not clipped ────────────────────
  try {
    await page.locator('button[aria-label="Play a game"]').first().click();
    await page.getByRole('dialog', { name: 'Play a game' }).waitFor({ timeout: 8_000 });
    await page.waitForTimeout(400);
    const dialog = page.getByRole('dialog', { name: 'Play a game' });
    const box = await dialog.boundingBox();
    if (!box) throw new Error('no dialog box');
    const text = await dialog.innerText();
    if (!/Emoji|Trivia/i.test(text)) throw new Error('4th game content missing on mobile');
    await shot(page, '11-mobile-play-picker');
    ok('mobile play picker visible', `y=${Math.round(box.y)} h=${Math.round(box.height)}`);
    await page.keyboard.press('Escape');
  } catch (e) {
    fail('mobile play picker visible', e);
  }

  // ── 13. Register page (logged-out path) ───────────────────
  try {
    // Clear storage and go register
    await context.clearCookies();
    await page.evaluate(() => {
      try {
        localStorage.clear();
        sessionStorage.clear();
      } catch {
        /* */
      }
    });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${BASE}/register`, { waitUntil: 'networkidle', timeout: 20_000 });
    await page.getByPlaceholder('Alex Rivera').waitFor({ timeout: 10_000 });
    await page.getByPlaceholder('alexrivera').waitFor();
    await shot(page, '12-register');
    ok('register page renders');
  } catch (e) {
    fail('register page renders', e);
  }

  // ── 14. Forgot password page ──────────────────────────────
  try {
    await page.goto(`${BASE}/forgot-password`, { waitUntil: 'networkidle', timeout: 20_000 });
    await page.waitForTimeout(500);
    await shot(page, '13-forgot');
    ok('forgot-password page loads', page.url());
  } catch (e) {
    fail('forgot-password page loads', e);
  }

  // ── Console errors (filter noise) ─────────────────────────
  try {
    const noise = /(favicon|Download the React DevTools|sourcemap|net::ERR_ABORTED)/i;
    const real = [...consoleErrors, ...pageErrors].filter((t) => !noise.test(t));
    // Dedup
    const uniq = [...new Set(real)].slice(0, 12);
    if (uniq.length === 0) ok('no serious console/page errors');
    else {
      // Soft fail — report but don't always hard-fail on third-party noise
      const critical = uniq.filter((t) => /TypeError|ReferenceError|is not defined|Uncaught/i.test(t));
      if (critical.length) fail('console/page errors', critical.join(' | '));
      else ok('console noise only (non-critical)', uniq.slice(0, 3).join(' · '));
    }
  } catch (e) {
    fail('console check', e);
  }

  await browser.close();

  const report = {
    at: new Date().toISOString(),
    base: BASE,
    failed,
    passed: results.filter((r) => r.pass).length,
    results,
    screenshots: SHOT,
  };
  fs.writeFileSync(path.join(SHOT, 'report.json'), JSON.stringify(report, null, 2));

  console.log('\n══════════════════════════════════════');
  console.log(
    `Browser check: ${report.passed}/${results.length} passed, ${failed} failed`
  );
  console.log(`Screenshots: ${SHOT}`);
  console.log('══════════════════════════════════════\n');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

#!/usr/bin/env node
/* F1 SIM autopilot runner.
   Opens the league site in a hidden browser, signs in as the Race Control robot account, and runs the
   autopilot: practice sessions, qualifying and races that are due on their timetable happen, races move on,
   and the announcements go out. The rules are the site's own, so this does exactly what Race Control's
   buttons do.

   Settings (environment variables):
     F1SIM_RUNNER_USER       the robot account's username (a Race Control account)
     F1SIM_RUNNER_PASSWORD   its password
     F1SIM_SITE_URL          the site (default https://f1-rp-sim.co.uk/)
     F1SIM_EVERY_SECONDS     how often to check when looping (default 60)

   Run it:
     node autopilot.mjs              check once and stop (what GitHub Actions does)
     node autopilot.mjs --for=9      keep checking for 9 minutes, then stop
     node autopilot.mjs --loop       keep checking until you stop it (Ctrl+C), e.g. on a computer left on */
import { chromium } from 'playwright';

const SITE = process.env.F1SIM_SITE_URL || 'https://f1-rp-sim.co.uk/';
const USER = process.env.F1SIM_RUNNER_USER, PASS = process.env.F1SIM_RUNNER_PASSWORD;
const args = process.argv.slice(2), loop = args.includes('--loop'), forArg = args.find(a => a.startsWith('--for='));
const minutes = forArg ? Number(forArg.slice(6)) || 0 : 0, every = Math.max(20, Number(process.env.F1SIM_EVERY_SECONDS) || 60);
const log = (...a) => console.log(new Date().toISOString().replace('T', ' ').slice(0, 19), ...a);

async function signIn(page) {
  await page.goto(SITE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#au-user') || (window.F1SIM_AUTOPILOT && window.F1SIM_AUTOPILOT.ready()), null, { timeout: 90000 });
  if (await page.$('#au-user')) {
    if (!USER || !PASS) throw new Error('Set F1SIM_RUNNER_USER and F1SIM_RUNNER_PASSWORD: the Race Control robot account.');
    await page.fill('#au-user', USER); await page.fill('#au-pass', PASS); await page.click('#au-go');
    const ok = await page.waitForFunction(() => (window.F1SIM_AUTOPILOT && window.F1SIM_AUTOPILOT.ready()) || document.querySelector('#au-note'), null, { timeout: 90000 });
    const note = await page.$('#au-note'); if (note && !(await page.evaluate(() => window.F1SIM_AUTOPILOT && window.F1SIM_AUTOPILOT.ready()))) throw new Error(`Couldn't sign in: ${(await note.innerText()).trim()}`);
    void ok;
  }
  await page.evaluate(() => { window.F1SIM_RUNNER = true; });
  if (!(await page.evaluate(() => window.F1SIM_AUTOPILOT.isRaceControl()))) throw new Error(`${USER || 'This account'} isn't Race Control. In the app: Accounts and backups → Accounts → set its role to Race Control.`);
  log(`Signed in to ${SITE} as Race Control.`);
}
async function tick(page) {
  const r = await page.evaluate(() => window.F1SIM_AUTOPILOT.tick());
  log(r.ok ? 'OK:' : 'Problem:', r.did.length ? r.did.join('; ') : 'nothing due', r.note ? `(${r.note})` : '');
  await page.waitForTimeout(5000);   /* let saves and Discord posts finish */
  return r;
}
const browser = await chromium.launch();
let failed = false;
try {
  const page = await browser.newPage();
  page.on('pageerror', e => log('Page error:', e.message));
  await signIn(page);
  if (!loop && !minutes) { const r = await tick(page); failed = !r.ok; }
  else {
    const until = minutes ? Date.now() + minutes * 60000 : Infinity;
    for (let n = 1; Date.now() < until; n++) {
      try { await tick(page); } catch (e) { log('Check failed:', e.message); }
      if (n % 30 === 0) { await signIn(page); }   /* a fresh page now and then */
      if (Date.now() + every * 1000 >= until) break;
      await page.waitForTimeout(every * 1000);
    }
  }
} catch (e) { log(e.message); failed = true; }
await browser.close();
process.exit(failed ? 1 : 0);

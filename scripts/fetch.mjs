// Pulls tomorrow's forecast for Beit Yanai / Michmoret and writes docs/data.json.
// Waves: GoSurf. Wind: Windguru. Open-Meteo is used only as a labelled backup when one of them fails.
// Surfline was dropped: it refuses automated requests (HTTP 403).
import { chromium } from 'playwright';
import { writeFile, readFile } from 'node:fs/promises';
import { parseGoSurf } from './parse.mjs';

const TZ = 'Asia/Jerusalem';
const LAT = 32.40, LON = 34.86; // Michmoret / Beit Yanai
const GOSURF_URL = 'https://www.gosurf.co.il/forecast/beit-yanai';
const WINDGURU_URL = 'https://www.windguru.cz/771'; // Beit Yannai
const OUT = new URL('../docs/data.json', import.meta.url);

const ymd = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d); // 2026-11-28
const now = new Date();
const target = ymd(new Date(now.getTime() + 24 * 3600 * 1000));
const [Y, M, D] = target.split('-');
const log = (...a) => console.log(new Date().toISOString(), ...a);

async function withRetry(name, fn, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try { return await fn(); }
    catch (e) { log(`${name} attempt ${i} failed:`, e.message); if (i < tries) await new Promise(r => setTimeout(r, 20000 * i)); }
  }
  return null;
}

// ---------- Windguru (wind) ----------
async function windguru(page) {
  await page.goto(WINDGURU_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.locator('table.tabulka').first().waitFor({ timeout: 30000 });
  const raw = await page.evaluate(() => {
    const t = document.querySelector('table.tabulka');
    const get = id => [...t.rows].find(r => r.id.endsWith(id));
    const cells = r => [...r.cells].slice(1);
    const d = cells(get('dates')).map(c => c.textContent.trim());
    const sp = cells(get('WINDSPD')).map(c => +c.textContent.trim());
    const gu = cells(get('GUST')).map(c => +c.textContent.trim());
    const sm = cells(get('SMER')).map(c => { const g = c.querySelector('svg g[transform]'); const m = g && g.getAttribute('transform').match(/rotate\(([\d.]+)/); return m ? ((+m[1] - 180) % 360 + 360) % 360 : null; });
    return d.map((x, i) => [x, sp[i], gu[i], sm[i]]);
  });
  // date cells look like "Sa28.07h"
  const points = raw.filter(([x]) => new RegExp(`^[A-Za-z]{2}${+D}\\.\\d{2}h$`).test(x))
    .map(([x, kn, gust, dir]) => [+x.match(/\.(\d{2})h$/)[1], kn, gust, dir])
    .filter(p => Number.isFinite(p[1]));
  if (points.length < 3) throw new Error('Windguru: too few points for target date');
  return { ok: true, points };
}

// ---------- Open-Meteo (official free API, backup + sun times) ----------
async function openMeteo() {
  const w = await (await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m&daily=sunrise,sunset&models=gfs_seamless&wind_speed_unit=kn&timezone=${TZ}&start_date=${target}&end_date=${target}`)).json();
  const m = await (await fetch(`https://marine-api.open-meteo.com/v1/marine?latitude=${LAT}&longitude=${LON - 0.05}&hourly=wave_height,wave_period&timezone=${TZ}&start_date=${target}&end_date=${target}`)).json();
  const H = w.hourly.time.map(t => +t.slice(11, 13));
  return {
    sunrise: w.daily.sunrise[0].slice(11, 16), sunset: w.daily.sunset[0].slice(11, 16),
    wind: H.map((h, i) => [h, Math.round(w.hourly.wind_speed_10m[i]), Math.round(w.hourly.wind_gusts_10m[i]), Math.round(w.hourly.wind_direction_10m[i])]).filter((_, i) => i % 2 === 1),
    waves: m.hourly.time.map((t, i) => ({ h: +t.slice(11, 13), cm: Math.round(m.hourly.wave_height[i] * 100), period: m.hourly.wave_period[i] }))
  };
}

async function main() {
  log('target date', target);
  const browser = await chromium.launch();
  const page = await browser.newPage({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', locale: 'he-IL', timezoneId: TZ });
  // Windguru prints its hours in the browser's time zone; GitHub's servers run on UTC, so pin Israel time.
  const gosurf = await withRetry('GoSurf', async () => {
    await page.goto(GOSURF_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    return parseGoSurf(await page.locator('body').innerText(), `${D}/${M}/${Y}`);
  });
  const wg = await withRetry('Windguru', () => windguru(page));
  await browser.close();
  const om = await withRetry('Open-Meteo', openMeteo);

  let previous = null;
  try { previous = JSON.parse(await readFile(OUT, 'utf8')); } catch {}

  const data = {
    generatedAt: now.toISOString(),
    date: target,
    sunrise: om?.sunrise || previous?.sunrise || '06:20',
    sunset: om?.sunset || previous?.sunset || '16:35',
    gosurf: gosurf || { ok: false },
    windguru: wg || { ok: false },
    backup: om ? { wind: om.wind, waves: om.waves } : null,
  };
  const failed = ['gosurf', 'windguru'].filter(k => !data[k].ok);
  if (failed.length === 2 && !om) throw new Error('All sources failed, keeping previous data.json');
  // Count consecutive failed runs per source (3 runs a day). After about 2 days, fail the job so GitHub emails the owner.
  data.failStreak = Object.fromEntries(['gosurf', 'windguru'].map(k => [k, data[k].ok ? 0 : ((previous?.failStreak?.[k]) || 0) + 1]));
  await writeFile(OUT, JSON.stringify(data, null, 1));
  log('wrote data.json; failed sources:', failed.join(', ') || 'none');
  const stuck = Object.entries(data.failStreak).filter(([, n]) => n >= 6).map(([k]) => k);
  if (stuck.length) { console.error(`Sources failing for ~2 days: ${stuck.join(', ')} (page is using the Open-Meteo backup)`); process.exitCode = 1; }
}

main().catch(e => { console.error(e); process.exit(1); });

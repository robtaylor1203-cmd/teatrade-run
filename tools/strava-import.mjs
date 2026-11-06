#!/usr/bin/env node
/**
 * Builds strava-stats.json from your Strava data export (no Strava API or
 * subscription needed).
 *
 *   1. On strava.com (website): Settings > My Account > "Download your account"
 *      > Get Started > Request download. Strava emails a link within a few hours.
 *   2. Download the zip, then run:
 *        node tools/strava-import.mjs "C:\Users\you\Downloads\export_12345.zip"
 *      (a plain activities.csv works too; with no argument it uses
 *      strava-export/activities.csv, a folder git ignores)
 *   3. Commit + push strava-stats.json. The site shows it whenever the live
 *      Strava feed isn't available.
 *
 * Only activities.csv is read (and only totals are written), because the full
 * export contains private data. Never commit the export itself: this repo is public.
 *
 * Options:  --since 2022-11-01   first day to count (default 2022-11-01)
 *           --out path.json     write somewhere other than strava-stats.json
 */
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUN_TYPES = new Set(["run", "trail run"]);

// Minimal RFC 4180 parser: quoted fields, "" escapes, commas and newlines in notes.
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", q = false;
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Export dates are UTC, e.g. "Nov 6, 2022, 7:25:01 AM" or "6 Nov 2022, 07:25:01".
function parseDate(s) {
  const ms = Date.parse(String(s).replace(/,/g, "") + " UTC");
  return Number.isFinite(ms) ? ms : null;
}

const num = (v) => {
  const n = parseFloat(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};

export function aggregate(csvText, since = "2022-11-01") {
  const rows = parseCsv(csvText);
  if (rows.length < 2) throw new Error("activities.csv has no rows");
  const head = rows[0].map(h => h.trim().toLowerCase());
  // The export repeats some headings ("Distance", "Elapsed Time"); the LAST
  // "Distance" is in metres and the first is in your display units.
  const last = (name) => head.lastIndexOf(name);
  const first = (name) => head.indexOf(name);
  const col = {
    date: first("activity date"), type: first("activity type"),
    distance: last("distance"), distanceDisplay: first("distance"),
    moving: first("moving time"), elev: first("elevation gain"),
  };
  for (const [k, v] of Object.entries(col)) if (v < 0) throw new Error(`activities.csv is missing the "${k}" column`);

  const from = Date.parse(since + "T00:00:00Z");
  if (!Number.isFinite(from)) throw new Error(`Bad --since date: ${since}`);

  const out = { runs: 0, meters: 0, seconds: 0, elevM: 0, longestM: 0, lastMs: 0, firstMs: 0, byYear: {}, skippedDates: 0, displayMeters: 0 };
  for (const r of rows.slice(1)) {
    if (!RUN_TYPES.has((r[col.type] || "").trim().toLowerCase())) continue;
    const ms = parseDate(r[col.date]);
    if (ms === null) { out.skippedDates++; continue; }
    if (ms < from) continue;
    const m = num(r[col.distance]);
    out.runs++;
    out.meters += m;
    out.displayMeters += num(r[col.distanceDisplay]);
    out.seconds += num(r[col.moving]);
    out.elevM += num(r[col.elev]);
    out.longestM = Math.max(out.longestM, m);
    out.lastMs = Math.max(out.lastMs, ms);
    out.firstMs = out.firstMs ? Math.min(out.firstMs, ms) : ms;
    const y = new Date(ms).getUTCFullYear();
    out.byYear[y] = (out.byYear[y] || 0) + m;
  }
  return out;
}

export function toStats(agg, { since, athleteUrl }) {
  return {
    since,
    distance_km: +(agg.meters / 1000).toFixed(1),
    moving_time_seconds: Math.round(agg.seconds),
    elevation_gain_meters: Math.round(agg.elevM),
    run_count: agg.runs,
    longest_run_km: +(agg.longestM / 1000).toFixed(1),
    last_run_date: agg.lastMs ? new Date(agg.lastMs).toISOString().slice(0, 10) : null,
    athlete_url: athleteUrl,
    generated_at: new Date().toISOString(),
    source: "strava-export",
  };
}

function readCsvFrom(arg) {
  const p = resolve(arg);
  if (!existsSync(p)) throw new Error(`Not found: ${p}`);
  if (!/\.zip$/i.test(p)) return readFileSync(p, "utf8");

  // Pull just activities.csv out of the zip (the rest is private and large).
  const tmp = mkdtempSync(join(tmpdir(), "strava-"));
  const dest = join(tmp, "activities.csv");
  try {
    const r = process.platform === "win32"
      ? spawnSync("powershell", ["-NoProfile", "-Command",
          `Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead('${p.replace(/'/g, "''")}'); try { $e=$z.Entries | Where-Object { $_.FullName -ieq 'activities.csv' } | Select-Object -First 1; if (-not $e) { exit 3 }; [IO.Compression.ZipFileExtensions]::ExtractToFile($e,'${dest.replace(/'/g, "''")}',$true) } finally { $z.Dispose() }`],
          { encoding: "utf8" })
      : spawnSync("sh", ["-c", `unzip -p "${p}" activities.csv > "${dest}"`], { encoding: "utf8" });
    if (r.status !== 0 || !existsSync(dest)) throw new Error("Couldn't find activities.csv inside that zip. Is it the Strava export?");
    return readFileSync(dest, "utf8");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

const km = (m) => (m / 1000).toFixed(1);

function main() {
  const args = process.argv.slice(2);
  const si = args.indexOf("--since");
  const since = si >= 0 ? args.splice(si, 2)[1] : "2022-11-01";
  const oi = args.indexOf("--out");
  const outPath = oi >= 0 ? resolve(args.splice(oi, 2)[1]) : join(REPO, "strava-stats.json");
  const src = args[0] || join(REPO, "strava-export", "activities.csv");

  const agg = aggregate(readCsvFrom(src), since);
  const target = outPath;
  let athleteUrl = "https://www.strava.com/athletes/runteatrade";
  try { athleteUrl = JSON.parse(readFileSync(target, "utf8")).athlete_url || athleteUrl; } catch { /* first run */ }

  if (!agg.runs) throw new Error(`No runs found on or after ${since}. Check the file and date.`);
  const stats = toStats(agg, { since, athleteUrl });
  writeFileSync(target, JSON.stringify(stats, null, 2) + "\n");

  const h = Math.floor(agg.seconds / 3600), m = Math.round((agg.seconds % 3600) / 60);
  console.log(`\nCounted since ${since}:`);
  console.log(`  runs            ${agg.runs}`);
  console.log(`  distance        ${km(agg.meters)} km`);
  console.log(`  moving time     ${h}h ${m}m`);
  console.log(`  elevation gain  ${Math.round(agg.elevM).toLocaleString("en-GB")} m`);
  console.log(`  longest run     ${km(agg.longestM)} km`);
  console.log(`  latest run      ${stats.last_run_date}`);
  console.log("  by year        ", Object.entries(agg.byYear).map(([y, v]) => `${y}: ${km(v)} km`).join("   "));
  if (agg.skippedDates) console.log(`  (skipped ${agg.skippedDates} rows with an unreadable date)`);
  const ratio = agg.displayMeters ? agg.meters / agg.displayMeters : 0;
  if (ratio && (ratio < 900 || ratio > 1100) && (ratio < 0.6 || ratio > 1.7)) {
    console.log("\n  ! Distance units look unusual. Compare these totals with your Strava profile before publishing.");
  }
  console.log(`\nWrote ${target}`);
  console.log("Check the totals against your Strava profile, then commit and push strava-stats.json.\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (e) { console.error("\nError: " + e.message + "\n"); process.exit(1); }
}

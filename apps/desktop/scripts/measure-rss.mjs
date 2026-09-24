#!/usr/bin/env node
/**
 * Samples the RSS of the sidecar and every process under it (forked search
 * workers, commands) until it exits or you press Ctrl-C, then prints idle
 * (first sample after --settle seconds), peak, and the peak's breakdown.
 * Worker threads (modelWorker) are inside the sidecar's own RSS.
 *
 *   node scripts/measure-rss.mjs <sidecar-pid> [--interval 500] [--settle 10] [--out file.json]
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';

const args = process.argv.slice(2);
const pid = Number(args[0]);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const interval = Number(opt('--interval', 500));
const settleMs = Number(opt('--settle', 10)) * 1000;
const out = opt('--out');
if (!pid) {
  console.error('usage: measure-rss.mjs <pid> [--interval ms] [--settle s] [--out file]');
  process.exit(2);
}

function tree() {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss=,comm='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((l) => {
      const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(l);
      return m && { pid: +m[1], ppid: +m[2], rssKb: +m[3], comm: m[4] };
    })
    .filter(Boolean);
  const keep = new Set([pid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of rows) if (!keep.has(r.pid) && keep.has(r.ppid)) (keep.add(r.pid), (grew = true));
  }
  return rows.filter((r) => keep.has(r.pid));
}

const start = Date.now();
let idle;
let peak = { totalMb: 0 };
const samples = [];
const mb = (kb) => Math.round(kb / 102.4) / 10;

function report() {
  const res = { idle, peak, samples: samples.length, durationS: Math.round((Date.now() - start) / 1000) };
  console.log(JSON.stringify(res, null, 2));
  if (out) fs.writeFileSync(out, JSON.stringify({ ...res, series: samples }, null, 1));
  process.exit(0);
}

const timer = setInterval(() => {
  let procs;
  try {
    procs = tree();
  } catch {
    procs = [];
  }
  if (!procs.some((p) => p.pid === pid)) {
    clearInterval(timer);
    report();
    return;
  }
  const totalMb = mb(procs.reduce((s, p) => s + p.rssKb, 0));
  const t = Math.round((Date.now() - start) / 1000);
  samples.push({ t, totalMb, sidecarMb: mb(procs.find((p) => p.pid === pid).rssKb), processes: procs.length });
  if (!idle && Date.now() - start >= settleMs) idle = { t, totalMb, processes: procs.map((p) => ({ pid: p.pid, mb: mb(p.rssKb), comm: p.comm })) };
  if (totalMb > peak.totalMb) peak = { t, totalMb, processes: procs.map((p) => ({ pid: p.pid, mb: mb(p.rssKb), comm: p.comm })) };
}, interval);
process.on('SIGINT', report);
process.on('SIGTERM', report);

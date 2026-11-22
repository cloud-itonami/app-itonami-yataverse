#!/usr/bin/env node
// Probe referenced CIDs against https://yataverse.com/ipfs/<cid> for the fallback-only inventory
// (AWAI-3833, docs/fallback-only-inventory-2026-11-22.md).
//   node scripts/probe-inventory.mjs <list.tsv: cid<TAB>source...> <results.tsv>   (resumable: done CIDs are skipped)
// Output columns: cid, HEAD status (or HEAD/GET when the error code was read), error code, content-length, ms, time.
// One request is started per second; requests may overlap because a fallback miss takes ~15 s.
// The error code of a non-200/451 answer is read with a GET for the first 20 of each status.
import fs from 'node:fs';
const [list, out] = process.argv.slice(2);
const done = new Set(fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t')[0]) : []);
const rows = fs.readFileSync(list, 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sampled = {}; const pending = [];
async function probe(cid) {
  const t0 = Date.now(); let status = 'error', code = '', len = '';
  try {
    const h = await fetch(`https://yataverse.com/ipfs/${cid}`, { method: 'HEAD', signal: AbortSignal.timeout(60000) });
    status = String(h.status); len = h.headers.get('content-length') ?? '';
    if (h.status !== 200 && h.status !== 451 && (sampled[h.status] = (sampled[h.status] ?? 0) + 1) <= 20) {
      await sleep(1000);
      const g = await fetch(`https://yataverse.com/ipfs/${cid}`, { signal: AbortSignal.timeout(60000) });
      const txt = (await g.text()).slice(0, 300);
      try { code = JSON.parse(txt).error ?? ''; } catch { code = txt.replace(/\s+/g, ' ').slice(0, 80); }
      status = `${h.status}/${g.status}`;
    }
  } catch (e) { code = e.name; }
  fs.appendFileSync(out, `${cid}\t${status}\t${code}\t${len}\t${Date.now() - t0}\t${new Date().toISOString()}\n`);
}
for (const [cid] of rows) {
  if (done.has(cid)) continue;
  pending.push(probe(cid));
  await sleep(1000);
}
await Promise.all(pending);

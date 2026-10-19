// [tester] Vocal tracks (raw audio takes): first take, overdub over a loop, persistence + clear.
// Timing (notes/engine.md "vocal take"): fixture time x injected with mic stamp at + x is sung at corrected
// at + x − inLat → loop pos p = at + x − inLat − origin (mod L) → the strip renders it at origin + p + k·L − outLat.
// So capture time = x + offset with offset = at − inLat − outLat + k·L (first take: origin = t0).
// Asserts: the lane output correlates with the injected fixture at lag 0 ± 2 ms (NCC ≥ 0.9); no click at the loop
// seam; the stored Int16 audio has the fixture's onsets at their loop positions ± 5 ms; a new vocal lane is silent
// until ts + L and plays after; reload restores the audio bit-exactly enough to correlate; clear removes the keys.
import { expect, test, type Page } from '@playwright/test';
import type { Session } from '../src/types.ts';
import {
  SESSION_KEY, boot, exactness, firstTake, fixtureUrl, getLog, getSession, groundTruth, idbGet, idbKeys, ms, putFixtures,
  scheds,
} from './helpers.ts';

const FIX = 'sing-cmaj';
const URL_ = fixtureUrl(FIX);

/** onsets (s) in the stored Int16 loop audio of `key` (1 ms RMS envelope, see inside) */
async function storedOnsets(page: Page, key: string, thr: number): Promise<{ onsets: number[]; sampleRate: number; length: number }> {
  return page.evaluate(
    ([k, thr]) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('keyval-store');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const g = db.transaction('keyval', 'readonly').objectStore('keyval').get(k as string);
          g.onerror = () => reject(g.error);
          g.onsuccess = () => {
            db.close();
            const v = g.result as { sampleRate: number; pcm: Int16Array };
            const sr = v.sampleRate;
            // 1 ms RMS blocks: an onset = a block over thr and over 3× the mean of the 20 blocks before it (a rise);
            // its time = first sample in the block over thr/2; then 40 ms refractory
            const B = Math.round(0.001 * sr);
            const rms: number[] = [];
            for (let b0 = 0; b0 + B <= v.pcm.length; b0 += B) {
              let sum = 0;
              for (let i = b0; i < b0 + B; i++) sum += (v.pcm[i] / 32768) ** 2;
              rms.push(Math.sqrt(sum / B));
            }
            const onsets: number[] = [];
            let last = -Infinity;
            for (let k = 20; k < rms.length; k++) {
              let prev = 0;
              for (let j = k - 20; j < k; j++) prev += rms[j];
              prev /= 20;
              if (rms[k] > (thr as number) && rms[k] > 3 * prev && k - last >= 40) {
                let i = k * B;
                while (i < (k + 1) * B && Math.abs(v.pcm[i]) / 32768 < (thr as number) / 2) i++;
                onsets.push(i / sr);
                last = k;
              }
            }
            resolve({ onsets, sampleRate: sr, length: v.pcm.length });
          };
        };
      }),
    [key, thr] as const,
  ) as Promise<{ onsets: number[]; sampleRate: number; length: number }>;
}

test('vocals first take: output = the sung audio at lag 0, exact scheduling (seam clicks: bugs.spec.ts)', async ({ page }) => {
  const errors = await boot(page);
  await putFixtures(page, [FIX]);
  expect(await page.evaluate(() => window.__sing!.command({ type: 'create', kind: 'vocals' }))).toBe(true);
  // L puts the loop seam inside the A4 (fixture 3.84–4.59 s): the seam joins a sung note to the room noise at pos 0
  const run = await firstTake(page, { fixture: FIX, L: 4.29, bars: 2, lead: 0.1, captureKey: 'lane' });
  const L = run.L;
  expect(await page.evaluate(() => window.__sing!.state())).toBe('playing');
  const session = await getSession(page);
  const lane = session.tracks.find((t) => t.id === run.trackId)!;
  expect(lane.kind).toBe('vocals');
  expect(lane.take!.audio).toBeTruthy();
  expect(lane.take!.audio!.length).toBe(Math.round(L * lane.take!.audio!.sampleRate) + Math.round(0.02 * lane.take!.audio!.sampleRate));
  expect(lane.take!.peaks?.length).toBe(256);
  expect(lane.take!.notes).toEqual([]);

  const r = await page.evaluate(async (r) => {
    const s = window.__sing!;
    await s.waitUntil(r.t0 + 2 * r.L + 0.4); // cycle 1 and the seam into cycle 2
    const sum = await s.capture.end('lane');
    s.command({ type: 'stop' });
    return { sum };
  }, run);
  const log = await getLog(page);
  const sc = scheds(log).filter((x) => x.trackId === run.trackId);
  const outLat = sc[0].outLat;
  // cycle 1 (k = 1): compare render times [stopT + 0.2, t0 + 2L − outLat − 0.05)
  const offset = run.at - run.inLat - outLat + L;
  const xc = await page.evaluate(
    ([url, off, a, b]) => window.__sing!.capture.xcorr('lane', url, off, a, b, 0.01),
    [URL_, offset, run.stopT + 0.2, run.t0 + 2 * L - outLat - 0.05] as const,
  );
  const ex = exactness(log, await getSession(page));
  console.log(`[vocals] first take L ${L}: ${sc.length} sched (cycles ${sc.map((x) => x.cycle).join(',')}), exactness missing ${ex.missing.length} extra ${ex.extra.length} dups ${ex.dups.length}; output rms ${r.sum.rms.toFixed(4)}; xcorr lag ${ms(xc.lag)} ncc ${xc.ncc.toFixed(4)} (at 0: ${xc.nccAtZero.toFixed(4)})`);
  expect(ex.dups).toEqual([]);
  expect(ex.missing).toEqual([]);
  expect(ex.extra).toEqual([]);
  expect(r.sum.rms).toBeGreaterThan(1e-3);
  expect(Math.abs(xc.lag)).toBeLessThanOrEqual(0.002);
  expect(xc.ncc).toBeGreaterThanOrEqual(0.9);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('vocals overdub: stored audio aligned to the loop, silent until ts + L, plays after', async ({ page }) => {
  test.slow();
  const errors = await boot(page);
  await putFixtures(page, ['beatbox-basic']);
  const first = await firstTake(page, { fixture: 'sing-cmaj', L: 3.0, dur: 2.7 });
  const L = (await getSession(page)).loopLength!;
  const r = await page.evaluate(async (L) => {
    const s = window.__sing!;
    if (!s.command({ type: 'create', kind: 'vocals' })) throw new Error('create vocals refused');
    const ts = s.now();
    const at = await s.mic.play('/__fixtures/beatbox-basic.wav', ts + 0.1, { dur: 2.4 });
    if (!s.transport('record', ts)) throw new Error(`punch-in refused in ${s.state()}`);
    const start = s.logSince(ts).find((e) => e.type === 'take' && e.data?.phase === 'start')!;
    const trackId = String(start.data!.trackId);
    s.capture.begin('v', trackId);
    await s.waitUntil(ts + L + 1.2);
    const sum = await s.capture.end('v');
    const commit = s.logSince(ts).find((e) => e.type === 'take' && e.data?.phase === 'commit' && e.data?.trackId === trackId);
    return { ts, at, trackId, inLat: Number(start.data!.inLat), sum, committed: !!commit, outLat: s.outLat() };
  }, L);
  expect(r.committed).toBe(true);
  const lane = (await getSession(page)).tracks.find((t) => t.id === r.trackId)!;
  expect(lane.kind).toBe('vocals');
  // stored audio: each beatbox hit at its loop position ± 5 ms
  const stored = await storedOnsets(page, lane.take!.audio!.key, 0.05);
  const hits = groundTruth('beatbox-basic').hits.filter((h) => h.t < 2.35);
  const mod = (x: number) => ((x % L) + L) % L;
  const errs = hits.map((h) => {
    const p = mod(r.at + h.t - r.inLat - first.t0);
    const d = (o: number) => ((o - p + L / 2) % L + L) % L - L / 2; // circular distance
    const near = stored.onsets.reduce((b, o) => (Math.abs(d(o)) < Math.abs(d(b)) ? o : b), stored.onsets[0] ?? NaN);
    return d(near);
  });
  console.log(`[vocals] overdub: stored ${stored.length} samples, ${stored.onsets.length} onsets; hit pos errors ${errs.map((e) => ms(e)).join(' ')}; onsets ${stored.onsets.map((o) => o.toFixed(3)).join(' ')}; expected ${hits.map((h) => mod(r.at + h.t - r.inLat - first.t0).toFixed(3)).join(' ')}`);
  expect(stored.length).toBe(Math.round(L * stored.sampleRate) + Math.round(0.02 * stored.sampleRate));
  for (const e of errs) expect(Math.abs(e)).toBeLessThanOrEqual(0.005);
  // silent until ts + L (render time ts + L − outLat), audible after
  const before = await page.evaluate(([a, b]) => window.__sing!.capture.level('v', a, b), [r.ts + 0.05, r.ts + L - r.outLat - 0.01] as const);
  const after = await page.evaluate(([a, b]) => window.__sing!.capture.level('v', a, b), [r.ts + L + 0.2, r.ts + L + 1.1] as const);
  console.log(`[vocals] overdub lane before ts + L: rms ${before.rms.toExponential(2)} peak ${before.peak.toExponential(2)}; after: rms ${after.rms.toFixed(4)}`);
  expect(before.peak).toBeLessThan(1e-4);
  expect(after.rms).toBeGreaterThan(1e-3);
  const sc = scheds(await getLog(page)).filter((x) => x.trackId === r.trackId);
  expect(sc.length).toBeGreaterThan(0);
  expect(sc.every((x) => x.heard + L > r.ts + L - 1e-6)).toBe(true);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('vocals persist: reload restores audible audio; clear session removes the audio keys', async ({ page }) => {
  test.slow();
  const errors = await boot(page);
  await putFixtures(page, [FIX]);
  await page.evaluate(() => window.__sing!.command({ type: 'create', kind: 'vocals' }));
  const run = await firstTake(page, { fixture: FIX, L: 3.0, lead: 0.1 });
  await page.evaluate(async () => {
    window.__sing!.command({ type: 'stop' });
    await window.__sing!.flush();
  });
  const before = await getSession(page);
  const key = before.tracks[0].take!.audio!.key;
  expect((await idbKeys(page)).filter((k) => k.startsWith('sing.audio.'))).toEqual([key]);

  await page.reload();
  await boot(page, { navigate: false });
  await putFixtures(page, [FIX]);
  expect(await page.evaluate(() => window.__sing!.state())).toBe('stopped');
  expect(await getSession(page)).toEqual(before);
  const r = await page.evaluate(async (id) => {
    const s = window.__sing!;
    const t = s.now();
    s.command({ type: 'play' }, t);
    const origin = Number(s.logSince(t).find((e) => e.type === 'transport' && e.data?.action === 'start')!.data!.origin);
    s.capture.begin('v', id);
    await s.waitUntil(origin + s.session().loopLength! + 0.2);
    const sum = await s.capture.end('v');
    return { origin, sum, outLat: s.outLat() };
  }, run.trackId);
  // after the reload origin is new: fixture x renders at origin + (at − inLat − t0 + x) − outLat (cycle 0)
  const xc = await page.evaluate(
    ([url, off, a, b]) => window.__sing!.capture.xcorr('v', url, off, a, b, 0.01),
    [URL_, r.origin + run.at - run.inLat - run.t0 - r.outLat, r.origin + 0.3, r.origin + 2.9 - r.outLat] as const,
  );
  console.log(`[vocals] after reload: rms ${r.sum.rms.toFixed(4)}, xcorr lag ${ms(xc.lag)} ncc ${xc.ncc.toFixed(4)}`);
  expect(r.sum.rms).toBeGreaterThan(1e-3);
  expect(Math.abs(xc.lag)).toBeLessThanOrEqual(0.002);
  expect(xc.ncc).toBeGreaterThanOrEqual(0.9);

  // clear session (settings → tap the danger row twice) → no audio keys left
  await page.locator('[data-action="settings"]').click();
  await page.locator('.sheet-layer.open .row.danger').click();
  await page.locator('.sheet-layer.open .row.danger').click();
  await expect.poll(async () => (await idbKeys(page)).filter((k) => k.startsWith('sing.audio.')), { timeout: 5000 }).toEqual([]);
  expect(await page.evaluate(() => window.__sing!.state())).toBe('idle');
  await page.evaluate(() => window.__sing!.flush());
  const stored = await idbGet<Session>(page, SESSION_KEY);
  expect(stored?.tracks ?? []).toEqual([]);
  expect(errors, errors.join('\n')).toEqual([]);
});

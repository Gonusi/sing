// [tester] Clap calibration against a simulated speaker→mic path: mic.loopback(d) routes master → DelayNode(d) → mic.
// mic.loopback taps the speaker feed (limiter output). The click heard at H enters the master at H − outLat and leaves
// the limiter LIMITER_DELAY_SEC later, so its stamp is H − outLat + LIMITER_DELAY + d → expected inLat = d − outLat +
// LIMITER_DELAY (± 5 ms; notes/engine.md worked example 4).
// Then the calibrated inLat makes an overdub land where it was heard: a take sung along with the loopback's own
// playback is placed at the loop positions it echoes.
import { expect, test } from '@playwright/test';
import { boot, firstTake, getSession, matchNotes, maxAbs, ms, overdub } from './helpers.ts';

/** src/audio/context.ts LIMITER_DELAY_SEC (not imported: that module needs a browser) */
const LIMITER_DELAY_SEC = 0.006;

// the loopback must be longer than the output latency (this Mac's default output reported 0.17 s on 2026-10-19), so the
// delays are outLat + extra: inLat = extra + LIMITER_DELAY_SEC whatever the host
for (const extra of [0.08, 0.2]) {
  test(`loopback outLat + ${extra * 1000} ms → calibrate → inLat = d − outLat + limiter delay`, async ({ page }) => {
    const errors = await boot(page, { noise: null });
    const d = (await page.evaluate(() => window.__sing!.outLat())) + extra;
    const r = await page.evaluate(async (d) => {
      const s = window.__sing!;
      s.loopback(d);
      const res = await s.calibrate();
      s.loopbackOff();
      if (res.ok) await s.setDevice({ inLat: res.inLat, calibrated: true });
      return { ...res, device: s.device() };
    }, d);
    const expected = d - r.outLatAtStart + LIMITER_DELAY_SEC;
    console.log(`[calibration] d ${ms(d)}: ok ${r.ok}, inLat ${ms(r.inLat)} (expected ${ms(expected)}, err ${ms(r.inLat - expected)}), spread ${ms(r.spread)}, matched ${r.matched}`);
    expect(r.ok).toBe(true);
    expect(r.matched).toBeGreaterThanOrEqual(5);
    expect(Math.abs(r.inLat - expected)).toBeLessThanOrEqual(0.005);
    expect(r.device.inLat).toBeCloseTo(r.inLat, 9);
    expect(r.device.calibrated).toBe(true);
    expect(errors, errors.join('\n')).toEqual([]);
  });
}

test('without a loopback (nobody claps) → not ok, device untouched', async ({ page }) => {
  await boot(page);
  const r = await page.evaluate(async () => {
    const s = window.__sing!;
    const before = s.device();
    const res = await s.calibrate();
    return { ok: res.ok, matched: res.matched, before, after: s.device() };
  });
  expect(r.ok).toBe(false);
  expect(r.after).toEqual(r.before);
});

test('calibrated inLat: an overdub of the looped-back playback lands on the positions it echoes', async ({ page }) => {
  test.slow();
  const errors = await boot(page);
  const d = (await page.evaluate(() => window.__sing!.outLat())) + 0.1;
  const cal = await page.evaluate(async (d) => {
    const s = window.__sing!;
    s.loopback(d);
    const r = await s.calibrate();
    await s.setDevice({ inLat: r.inLat, calibrated: true });
    return r;
  }, d);
  expect(cal.ok).toBe(true);
  // lane 1: a sung synth line; the loopback stays on, so its playback enters the mic d later
  const first = await firstTake(page, { fixture: 'sing-cmaj', L: 3.0, dur: 2.7 });
  // lane 2: an overdub with no singer: the mic hears only lane 1's looped-back output
  const dub = await overdub(page, { kind: 'synth', fixture: 'silence-noise', dur: 0.05, lead: 0.1 });
  expect(dub.phase).toBe('commit');
  const session = await getSession(page);
  const a = session.tracks.find((t) => t.id === first.trackId)!.take!.notes;
  const b = session.tracks.find((t) => t.id === dub.trackId)!.take!.notes;
  const L = session.loopLength!;
  // a note near the window start is clipped to ts (pos ts − origin mod L): compare the ones well inside the window
  const tsPos = (((dub.ts - first.t0) % L) + L) % L;
  const inside = a.filter((n) => {
    const rel = (((n.pos - tsPos) % L) + L) % L;
    // short notes (the slurred F4 cut by the slice end) are re-detected unreliably from a polyphonic synth (notes/tester.md)
    return rel > 0.05 && rel + n.dur < L - 0.05 && n.dur >= 0.2;
  });
  const m = matchNotes(b.map((n) => ({ t: n.pos, midi: n.midi })), inside.map((n) => ({ t: n.pos, midi: n.midi })), 0.04);
  console.log(`[calibration] echo overdub: lane 1 ${a.length} notes (${inside.length} inside the window), lane 2 ${b.length}; matched ${m.matched}/${m.expected}, pos err max ${ms(maxAbs(m.errors))} mean ${ms(m.errors.reduce((x, y) => x + y, 0) / Math.max(1, m.errors.length))}; missed ${m.missed.join(' ')} wrong ${m.wrongPitch.join(' ')}`);
  expect(m.expected).toBeGreaterThanOrEqual(3);
  expect(m.missed).toEqual([]);
  // the synth re-detection error itself is up to ~30 ms (first-take.spec); the echo adds the calibration error
  expect(maxAbs(m.errors)).toBeLessThanOrEqual(0.025);
  expect(m.wrongPitch).toEqual([]);
  expect(errors, errors.join('\n')).toEqual([]);
});

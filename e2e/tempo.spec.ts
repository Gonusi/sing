// [tester] Round 4 tempo + metronome: first takes round to whole bars; setTempo rescales note and drum takes (same bars)
// and keeps the bar position while playing; the tempo is locked once a vocal take exists; a short tap on the bpm number
// toggles the metronome; the number pulses on the beat; on speakers, metronome clicks never become drum hits.
import { expect, test, type Page } from '@playwright/test';
import { boot, firstTake, getSession, overdub, scheds } from './helpers.ts';

/** record (count-in) → stop `bars` bars after the downbeat; returns the loop length and bar length */
async function takeOfBars(page: Page, bars: number): Promise<{ L: number; bar: number }> {
  return page.evaluate(async (bars) => {
    const s = window.__sing!;
    const t = s.now();
    s.transport('record', t);
    const D = Number(s.logSince(t).find((e) => e.type === 'countIn')!.data!.D);
    const bar = (60 / s.view().tempo.bpm) * s.view().tempo.beatsPerBar;
    await s.waitUntil(D + bars * bar + 0.1);
    if (!s.transport('record', D + bars * bar)) throw new Error(`stop refused in ${s.state()}`);
    return { L: s.session().loopLength!, bar };
  }, bars);
}

test('first take rounds to whole bars (round half up, at least one)', async ({ page }) => {
  const errors = await boot(page); // default 90 bpm 4/4: bar 2.667 s
  // not exactly on a half bar: stop − D at 2.5 bars is a float hair under 2.5 and rounds down (a real tap never ties)
  for (const [recorded, bars] of [[1.4, 1], [1.55, 2], [0.3, 1], [2.6, 3]] as const) {
    const r = await takeOfBars(page, recorded);
    console.log(`[tempo] recorded ${recorded} bars → loop ${(r.L / r.bar).toFixed(4)} bars`);
    expect(r.L).toBeCloseTo(bars * r.bar, 6);
    await expect(page.locator('.tp-right')).toHaveText(`${bars} ${bars === 1 ? 'bar' : 'bars'}`);
    await page.evaluate(() => window.__sing!.clearSession());
  }
  expect(errors, errors.join('\n')).toEqual([]);
});

test('setTempo rescales note + drum takes (same bars) and keeps the bar position while playing', async ({ page }) => {
  test.slow();
  const errors = await boot(page);
  await page.evaluate(() => window.__sing!.setDevice({ output: 'wired' })); // keep every drum hit
  await firstTake(page, { fixture: 'sing-cmaj', L: 3.0, dur: 2.7 }); // 80 bpm, 1 bar
  const dub = await overdub(page, { kind: 'drums', fixture: 'beatbox-basic', dur: 2.4, fade: 0.01 });
  expect(dub.phase).toBe('commit');
  const before = await getSession(page);
  const r = await page.evaluate(async () => {
    const s = window.__sing!;
    const L = s.session().loopLength!;
    const fracBefore = s.view().playhead! / L;
    const t = s.now();
    const ok = s.setTempo(100);
    const fracAfter = s.view().playhead! / s.session().loopLength!;
    await s.waitUntil(t + 2 * s.session().loopLength! + 0.2);
    return { ok, t, fracBefore, fracAfter, bpm: s.view().tempo.bpm };
  });
  expect(r.ok).toBe(true);
  expect(r.bpm).toBe(100);
  await expect(page.locator('.tempo-val')).toHaveText('100');
  const after = await getSession(page);
  const k = 80 / 100;
  expect(after.loopLength!).toBeCloseTo(before.loopLength! * k, 6);
  for (let i = 0; i < before.tracks.length; i++) {
    const a = before.tracks[i].take!;
    const b = after.tracks[i].take!;
    expect(b.notes.length).toBe(a.notes.length);
    expect(b.hits.length).toBe(a.hits.length);
    b.notes.forEach((n, j) => {
      expect(n.pos).toBeCloseTo(a.notes[j].pos * k, 4);
      expect(n.dur).toBeCloseTo(a.notes[j].dur * k, 4);
      expect(n.midi).toBe(a.notes[j].midi);
    });
    b.hits.forEach((h, j) => {
      expect(h.pos).toBeCloseTo(a.hits[j].pos * k, 4);
      expect(h.kind).toBe(a.hits[j].kind);
    });
  }
  const dFrac = Math.abs(r.fracAfter - r.fracBefore);
  console.log(`[tempo] 80 → 100 bpm: loop ${before.loopLength!.toFixed(4)} → ${after.loopLength!.toFixed(4)}; bar position ${r.fracBefore.toFixed(4)} → ${r.fracAfter.toFixed(4)}; ${before.tracks[1].take!.hits.length} hits, ${before.tracks[0].take!.notes.length} notes rescaled`);
  expect(Math.min(dFrac, 1 - dFrac)).toBeLessThan(0.05);
  // what plays after the change is the rescaled take
  const sc = scheds(await page.evaluate((t) => window.__sing!.logSince(t), r.t)).filter((s) => s.heard > r.t + 0.5);
  const positions = new Set(after.tracks.flatMap((t) => [...t.take!.notes, ...t.take!.hits].map((e) => e.pos.toFixed(5))));
  expect(sc.length).toBeGreaterThan(0);
  expect(sc.filter((s) => !positions.has(s.pos.toFixed(5)))).toEqual([]);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('tempo is locked once a vocal take exists', async ({ page }) => {
  const errors = await boot(page);
  await page.evaluate(() => window.__sing!.command({ type: 'create', kind: 'vocals' }));
  await firstTake(page, { fixture: 'sing-cmaj', L: 3.0, dur: 2.7 });
  expect(await page.evaluate(() => window.__sing!.view().tempoEditable)).toBe(false);
  expect(await page.evaluate(() => window.__sing!.setTempo(100))).toBe(false);
  await expect(page.locator('.tempo')).toHaveClass(/locked/);
  await page.locator('.tempo-step[data-tempo="up"]').click();
  await expect(page.locator('.toast')).toContainText('locked');
  expect(await page.evaluate(() => window.__sing!.view().tempo.bpm)).toBe(80);
  // undo the vocal take → editable again
  expect(await page.evaluate(() => window.__sing!.command({ type: 'undo' }))).toBe(true);
  expect(await page.evaluate(() => window.__sing!.view().tempoEditable)).toBe(true);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('a short tap on the bpm number toggles the metronome; the number pulses on the beat', async ({ page }) => {
  const errors = await boot(page);
  await firstTake(page, { fixture: 'sing-cmaj', L: 3.0, dur: 2.7 });
  const num = page.locator('.tempo-num');
  const click = () => page.evaluate(() => window.__sing!.session().fx?.click ?? true);
  expect(await click()).toBe(true);
  await num.click();
  expect(await click()).toBe(false);
  await expect(page.locator('.tempo')).toHaveClass(/muted/);
  await num.click();
  expect(await click()).toBe(true);
  await expect(page.locator('.tempo')).not.toHaveClass(/muted/);
  // playing: the number's background changes within a beat (0.75 s at 80 bpm); paused: it holds still
  const sample = () =>
    page.evaluate(async () => {
      const out = new Set<string>();
      const el = document.querySelector<HTMLElement>('.tempo-num')!;
      for (let i = 0; i < 24; i++) {
        out.add(el.style.background);
        await new Promise((r) => setTimeout(r, 40));
      }
      return out.size;
    });
  const playing = await sample();
  await page.evaluate(() => window.__sing!.transport('pause'));
  await page.waitForTimeout(200);
  const paused = await sample();
  console.log(`[tempo] pulse: ${playing} distinct backgrounds playing, ${paused} paused`);
  expect(playing).toBeGreaterThanOrEqual(3);
  expect(paused).toBe(1);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('on speakers metronome clicks never become drum hits (headphones: they would)', async ({ page }) => {
  test.slow();
  await boot(page, { noise: null });
  // the speaker → mic path: a loopback longer than the output latency, calibrated so click times line up
  const d = (await page.evaluate(() => window.__sing!.outLat())) + 0.1;
  await page.evaluate(async (d) => {
    const s = window.__sing!;
    s.loopback(d);
    const r = await s.calibrate();
    if (!r.ok) throw new Error('calibration failed');
    await s.setDevice({ inLat: r.inLat, calibrated: true, output: 'speaker' });
  }, d);
  const run = async (output: 'speaker' | 'wired') =>
    page.evaluate(async (output) => {
      const s = window.__sing!;
      await s.clearSession();
      await s.setDevice({ output });
      s.command({ type: 'create', kind: 'drums' });
      const t = s.now();
      s.transport('record', t);
      const D = Number(s.logSince(t).find((e) => e.type === 'countIn')!.data!.D);
      const bar = (60 / s.view().tempo.bpm) * 4;
      await s.waitUntil(D + 2 * bar + 0.1);
      s.transport('record', D + 2 * bar);
      return s.session().tracks[0].take?.hits.map((h) => `${h.kind}@${h.pos.toFixed(3)}`) ?? [];
    }, output);
  const speaker = await run('speaker');
  const wired = await run('wired');
  console.log(`[tempo] clicks heard by the mic, 2-bar drum take: speaker ${JSON.stringify(speaker)} · wired (no exclusion) ${wired.length} hits ${JSON.stringify(wired.slice(0, 8))}`);
  expect(speaker).toEqual([]);
  // sensitivity: without the exclusion the same clicks do turn into hits
  expect(wired.length).toBeGreaterThanOrEqual(4);
});

// [shell] Setup step 4: teach drums. Three sub-steps (kick, snare, hat; 3 hits each via api.teachDrum), then a live
// test pad (api.testDrums) where the user beatboxes freely; "sounds right" saves the templates.
import { DRUM_KINDS, type DrumKind, type DrumTemplate } from '../../types.ts';
import { buildCard, button, createLife, el, setResult, wait, type Life, type SetupStep } from './kit.ts';

const HITS = 3;
const TIMEOUT_SEC = 8;
const NEXT_SOUND_MS = 700;
const FLASH_MS = 220;
const PROMPTS: Record<DrumKind, string> = {
  kick: 'Make your kick: a short punchy “b!”',
  snare: 'Your snare: “ka” or “psh”',
  hat: 'Your hi-hat: a short “ts”',
};

export const drumsStep: SetupStep = {
  id: 'drums',
  title: 'Teach me your drums',
  mount(card, api, done) {
    const life = createLife();
    const ui = buildCard(card, PROMPTS.kick);
    let templates: DrumTemplate[] = [];
    let stopPad: (() => void) | null = null;
    life.onEnd(() => stopPad?.());

    async function teach(): Promise<void> {
      stopPad?.();
      stopPad = null;
      templates = [];
      for (const kind of DRUM_KINDS) {
        const got = await teachOne(kind);
        if (!got) return; // cleaned up while waiting
        templates.push(...got);
      }
      showPad();
    }

    /** one sound: start button -> 3 circles fill per hit; repeats until at least one hit was heard */
    async function teachOne(kind: DrumKind): Promise<DrumTemplate[] | null> {
      for (;;) {
        ui.instruction.textContent = PROMPTS[kind];
        ui.body.replaceChildren();
        const chips = el('div', 'wiz-chips');
        for (const k of DRUM_KINDS) chips.append(el('span', `wiz-chip${k === kind ? ' on' : ''}`, k));
        const circles = Array.from({ length: HITS }, () => el('span', 'wiz-circle'));
        const row = el('div', 'wiz-circles');
        row.append(...circles);
        const start = button('start', 'go');
        ui.body.append(chips, row, start);
        await clicked(start, life);
        if (!life.alive()) return null;
        start.hidden = true;
        setResult(ui, 'go ahead…', 'dim');
        let result: DrumTemplate[];
        try {
          result = await api.teachDrum(kind, HITS, (i) => circles[i]?.classList.add('on'), TIMEOUT_SEC);
        } catch (e) {
          console.error(e);
          result = [];
        }
        if (!life.alive()) return null;
        result.forEach((_, i) => circles[i]?.classList.add('on'));
        if (result.length > 0) {
          setResult(ui, `got ${result.length}`, 'ok');
          await wait(life, NEXT_SOUND_MS);
          if (!life.alive()) return null;
          setResult(ui, '', 'dim');
          return result;
        }
        setResult(ui, 'didn’t hear that — try again', 'bad');
        circles.forEach((c) => c.classList.remove('on'));
        start.textContent = 'try again';
        start.hidden = false;
        await clicked(start, life);
        if (!life.alive()) return null;
      }
    }

    function showPad(): void {
      ui.instruction.textContent = 'Now beatbox freely — I’ll show what I hear.';
      ui.body.replaceChildren();
      setResult(ui, '', 'dim');
      const pads = new Map<DrumKind, HTMLElement>();
      const grid = el('div', 'wiz-pads');
      for (const kind of DRUM_KINDS) {
        const pad = el('div', 'wiz-pad', kind);
        pad.dataset.kind = kind;
        pads.set(kind, pad);
        grid.append(pad);
      }
      const good = button('sounds right', 'go');
      const again = button('teach again');
      const pair = el('div', 'wiz-pair');
      pair.append(good, again);
      ui.body.append(grid, pair);
      stopPad = api.testDrums(templates, (kind) => {
        const pad = pads.get(kind);
        if (!life.alive() || !pad) return;
        pad.classList.add('hit');
        setTimeout(() => pad.classList.remove('hit'), FLASH_MS);
      });
      good.addEventListener('click', async () => {
        stopPad?.();
        stopPad = null;
        good.hidden = true;
        try {
          await api.save({ drums: templates });
        } catch (e) {
          console.error(e);
          if (life.alive()) setResult(ui, 'couldn’t save — try again', 'bad');
          good.hidden = false;
          return;
        }
        if (!life.alive()) return;
        setResult(ui, 'saved — I’ll use your sounds', 'ok');
        done(true);
      });
      again.addEventListener('click', () => void teach());
    }

    void teach();
    return life.end;
  },
};

/** resolves on the button's next click (or when the life ends) */
function clicked(b: HTMLButtonElement, life: Life): Promise<void> {
  return new Promise((resolve) => {
    b.addEventListener('click', () => resolve(), { once: true });
    life.onEnd(resolve);
  });
}

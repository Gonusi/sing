// [shell] Setup step 2: mic check. Measures the room's noise floor, then a few seconds of humming against it,
// with a live level meter (sqrt-scaled like the audio probe: speech RMS is ~0.01-0.1).
import { buildCard, button, createLife, el, frames, setResult, type SetupStep } from './kit.ts';

const FLOOR_SEC = 1.5;
const HUM_MS = 4000;
/** level (RMS 0..1) that counts as "good" */
const GOOD_LEVEL = 0.05;
/** the hum must also stand this many times above the room's noise floor */
const FLOOR_RATIO = 3;
const pct = (level: number): string => `${Math.min(1, Math.sqrt(Math.max(0, level))) * 100}%`;

export const micStep: SetupStep = {
  id: 'mic',
  title: 'Mic check',
  mount(card, api, done) {
    const life = createLife();
    const ui = buildCard(card, 'Hum something for a few seconds.');
    const meter = el('div', 'wiz-meter');
    const fill = el('span', 'wiz-meter-fill');
    const mark = el('span', 'wiz-meter-mark');
    mark.style.left = pct(GOOD_LEVEL);
    mark.append(el('span', 'wiz-meter-cap', 'good'));
    meter.append(fill, mark);
    const again = button('try again');
    again.hidden = true;
    ui.body.append(meter, again);

    let humming = false;
    let peak = 0;
    frames(life, () => {
      const level = api.level();
      fill.style.width = pct(level);
      fill.classList.toggle('good', level >= GOOD_LEVEL);
      if (humming) peak = Math.max(peak, level);
    });

    async function run(): Promise<void> {
      again.hidden = true;
      setResult(ui, 'stay quiet for a moment…', 'dim');
      const floor = await api.noiseFloor(FLOOR_SEC);
      if (!life.alive()) return;
      setResult(ui, 'now hum…', 'dim');
      peak = 0;
      humming = true;
      const timer = setTimeout(finish, HUM_MS);
      life.onEnd(() => clearTimeout(timer));
      function finish(): void {
        humming = false;
        const good = peak >= GOOD_LEVEL && peak >= floor * FLOOR_RATIO;
        setResult(ui, good ? 'your mic sounds good' : 'too quiet — move closer or choose the iPhone mic in ⋯', good ? 'ok' : 'bad');
        again.hidden = good;
        done(good);
      }
    }
    again.addEventListener('click', () => void run());
    void run();
    return life.end;
  },
};

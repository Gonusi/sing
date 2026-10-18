// [shell] Setup step 3: latency. The clap-along calibration with the same visuals as the settings row.
import { buildCard, button, createLife, el, setResult, type SetupStep } from './kit.ts';

const PULSE_MS = 300;

export const latencyStep: SetupStep = {
  id: 'latency',
  title: 'Latency',
  mount(card, api, done) {
    const life = createLife();
    const ui = buildCard(card, 'Clap or say “ta” on each low click. Wear your headphones.');
    const phase = el('div', 'wiz-phase');
    const dot = el('span', 'wiz-click-dot');
    const start = button('start', 'go');
    ui.body.append(dot, phase, start);

    function onClick(i: number, n: number, which: 'listen' | 'measure'): void {
      if (!life.alive()) return;
      phase.textContent = which === 'listen' ? `listen… ${i}/${n}` : `clap or say “ta” · ${i}/${n}`;
      dot.classList.toggle('listen', which === 'listen');
      dot.animate([{ opacity: 1, transform: 'scale(1.5)' }, { opacity: 0.15, transform: 'scale(1)' }], { duration: PULSE_MS });
    }
    async function run(): Promise<void> {
      start.hidden = true;
      phase.textContent = 'listen…';
      dot.classList.add('listen');
      setResult(ui, '', 'dim');
      let r: { ok: boolean; text: string };
      try {
        r = await api.calibrate(onClick);
      } catch (e) {
        console.error(e);
        r = { ok: false, text: 'calibration failed' };
      }
      if (!life.alive()) return;
      phase.textContent = '';
      setResult(ui, r.text, r.ok ? 'ok' : 'bad');
      start.textContent = 'try again';
      start.hidden = r.ok;
      done(r.ok);
    }
    start.addEventListener('click', () => void run());
    return life.end;
  },
};

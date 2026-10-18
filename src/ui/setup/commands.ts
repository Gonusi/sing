// [shell] Setup step 6: try a voice command. Hold the button, say "create violin track"; shown, never run.
import type { SetupApi } from '../../types.ts';
import { buildCard, createLife, el, setResult, type SetupStep } from './kit.ts';

const POLL_MS = 400;
const PHRASE = 'create violin track';
const UNAVAILABLE = 'voice isn’t available on this device — you can still tap';

export const commandsStep: SetupStep = {
  id: 'commands',
  title: 'Voice commands',
  mount(card, api, done) {
    const life = createLife();
    const ui = buildCard(card, `Hold the button and say “${PHRASE}”.`);
    const hold = el('button', 'wiz-hold', 'hold');
    hold.type = 'button';
    hold.disabled = true;
    ui.body.append(hold);

    let usable = false;
    function refresh(api: SetupApi): void {
      const { status, progress } = api.voiceStatus();
      if (status === 'ready') {
        if (!usable) setResult(ui, '', 'dim');
        usable = true;
        hold.disabled = false;
        return;
      }
      usable = false;
      hold.disabled = true;
      if (status === 'loading') setResult(ui, `voice is still downloading… ${Math.round(progress * 100)}%`, 'dim');
      else {
        setResult(ui, UNAVAILABLE, 'bad');
        clearInterval(poll); // 'off' / 'error' do not recover
        done(false);
      }
    }
    const poll = setInterval(() => !usable && refresh(api), POLL_MS);
    life.onEnd(() => clearInterval(poll));
    refresh(api);

    // press = listen, release = read what was heard
    let listening: ReturnType<SetupApi['tryCommand']> | null = null;
    hold.addEventListener('pointerdown', (e) => {
      if (listening || !usable) return;
      hold.setPointerCapture(e.pointerId);
      hold.classList.add('on');
      hold.textContent = 'listening…';
      setResult(ui, '', 'dim');
      try {
        listening = api.tryCommand();
      } catch (err) {
        console.error(err);
        listening = null;
      }
    });
    async function release(): Promise<void> {
      const t = listening;
      if (!t) return;
      listening = null;
      hold.classList.remove('on');
      hold.textContent = 'hold';
      let heard: { text: string; command: unknown } | null = null;
      try {
        heard = await t.stop();
      } catch (err) {
        console.error(err);
      }
      if (!life.alive()) return;
      if (heard && heard.command) {
        setResult(ui, `heard: “${heard.text}” ✓`, 'ok');
        done(true);
      } else {
        setResult(ui, 'didn’t catch that — try again', 'bad');
      }
    }
    hold.addEventListener('pointerup', () => void release());
    hold.addEventListener('pointercancel', () => void release());
    hold.addEventListener('contextmenu', (e) => e.preventDefault());
    life.onEnd(() => {
      // leaving mid-hold: stop listening, ignore the result
      const t = listening;
      listening = null;
      void t?.stop().catch(() => {});
    });
    return life.end;
  },
};

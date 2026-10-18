// [shell] Setup step 1: what are you listening on? -> api.applyOutput, then a test tone and "hear it clearly?".
import type { OutputKind } from '../../types.ts';
import { buildCard, button, createLife, el, setResult, type SetupStep } from './kit.ts';

const OPTIONS: Array<{ kind: OutputKind; label: string }> = [
  { kind: 'wired', label: 'wired headphones' },
  { kind: 'bluetooth', label: 'Bluetooth headphones' },
  { kind: 'speaker', label: 'phone speaker' },
];
const TONE_MIDI = 69;
const TONE_SEC = 1.2;
const QUIET_TIP = 'switch to headphones, or turn echo cancellation on in ⋯';

export const listeningStep: SetupStep = {
  id: 'listening',
  title: 'What are you listening on?',
  mount(card, api, done) {
    const life = createLife();
    const ui = buildCard(card, 'So I can set echo and mic the right way.');
    const guess = api.guessOutput();
    const buttons = new Map<OutputKind, HTMLButtonElement>();
    const options = el('div', 'wiz-options');
    for (const { kind, label } of OPTIONS) {
      const b = el('button', `wiz-opt${kind === guess ? ' guess' : ''}`);
      b.type = 'button';
      b.dataset.kind = kind;
      b.append(el('span', '', label));
      if (kind === guess) b.append(el('span', 'wiz-opt-tag', 'looks like'));
      b.addEventListener('click', () => void choose(kind));
      buttons.set(kind, b);
      options.append(b);
    }

    // appears after an output is chosen: test tone, then the question
    const test = el('div', 'wiz-test');
    test.hidden = true;
    const toneBtn = button('play test tone', 'go');
    const question = el('div', 'wiz-question');
    question.hidden = true;
    const yes = button('yes');
    const no = button('no, it’s quiet');
    const pair = el('div', 'wiz-pair');
    pair.append(yes, no);
    question.append(el('div', 'wiz-ask', 'hear it clearly?'), pair);
    test.append(toneBtn, question);
    ui.body.append(options, test);

    let seq = 0; // a late applyOutput of an earlier choice must not show
    async function choose(kind: OutputKind): Promise<void> {
      const mine = ++seq;
      buttons.forEach((b, k) => b.classList.toggle('on', k === kind));
      test.hidden = true;
      question.hidden = true;
      setResult(ui, 'setting up…', 'dim');
      try {
        await api.applyOutput(kind);
      } catch (e) {
        console.error(e);
        if (life.alive() && mine === seq) setResult(ui, 'couldn’t set that up — try another', 'bad');
        return;
      }
      if (!life.alive() || mine !== seq) return;
      setResult(ui, 'now check you can hear me', 'dim');
      test.hidden = false;
    }

    toneBtn.addEventListener('click', () => {
      api.playTone(TONE_MIDI, TONE_SEC);
      question.hidden = false;
      setResult(ui, '', 'dim');
    });
    yes.addEventListener('click', () => {
      setResult(ui, 'good — all set', 'ok');
      done(true);
    });
    no.addEventListener('click', () => {
      setResult(ui, QUIET_TIP, 'bad');
      done(false);
    });
    return life.end;
  },
};

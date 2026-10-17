// [shell] Dev page for the start screen. ?p=0.6 -> tapped, loading at 60%; ?e=message -> error state.
// window.__taps counts onTap calls (shots.ts asserts the first tap calls it once and later taps are ignored).
import '../../src/ui/style.css';
import { mountStart } from '../../src/ui/start.ts';

declare global {
  interface Window {
    __taps: number;
  }
}

const params = new URLSearchParams(location.search);
window.__taps = 0;
const start = mountStart(document.getElementById('app')!, () => {
  window.__taps += 1;
});

const progress = params.get('p');
if (progress !== null) {
  // what a real tap does first: the screen switches to "starting…"
  document.querySelector('.start')!.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  start.progress(Number(progress), params.get('label') ?? 'instruments');
}
const error = params.get('e');
if (error !== null) start.error(error);

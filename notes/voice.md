# voice — notes

## Progress (voice agent, branch `voice`)
- [ ] scripts/fetch-model.mjs (copy from VOSK_MODEL_CACHE or download, sha256-checked)
- [ ] dev/check-grammar.ts (Gr.fst symbol table vs COMMAND_PHRASES)
- [ ] src/voice/grammar.ts (GRAMMAR_JSON, variants)
- [ ] src/voice/recognizer.ts
- [ ] dev/voice/make-speech.ts (say + ffmpeg fixtures, manifest)
- [ ] dev/voice/ page + check (dev server, fast + real-time modes)
- [ ] gate on Chromium (clean ≥ 90 %, noisy ≥ 80 %, 0 false positives, release→command median ≤ 400 ms)
- [ ] production build (preview, /sing/) run
- [ ] WebKit attempt
- [ ] notes: API, numbers, progress approach, WebKit, iPhone risks, contract changes

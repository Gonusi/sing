// [voice] Real download progress for vosk-browser 0.0.8's model, with a single download.
//
// vosk downloads the model inside its own blob Web Worker and posts nothing until the model is ready.
// The Model constructor creates that worker synchronously with the GLOBAL `Worker` (its WorkerFactory).
// constructWithProgress() swaps `window.Worker` for the duration of that one synchronous call, so the worker
// starts from a small wrapper script that
//   1. replaces the worker's `fetch` with one that counts the bytes of the model response, and posts
//      { event: PROGRESS_EVENT, loaded, total } (vosk's Model re-dispatches unknown events on itself), then
//   2. importScripts() vosk's original worker blob, unchanged.
// Coupling: this relies on vosk-browser 0.0.8 internals (WorkerFactory uses the global Worker at construction
// time; the worker downloads with the global fetch). package.json pins ^0.0.8 (= 0.0.8 only).
// If the wrapper ever stops working, progress stays at 0 until ready — loading itself is unaffected
// as long as importScripts works.

/** CustomEvent type dispatched on the vosk Model; detail = ProgressDetail */
export const PROGRESS_EVENT = 'sing-progress';
/** post at most one progress message per this many bytes */
const PROGRESS_STEP_BYTES = 256 * 1024;

export interface ProgressDetail {
  event: typeof PROGRESS_EVENT;
  loaded: number;
  /** Content-Length, 0 when the server sent none */
  total: number;
}

/**
 * Worker-side wrapper, kept as a plain string (bundler-proof: no transpiled helpers, no renamed identifiers).
 * `modelHref` is the absolute model URL as the worker will fetch it (vosk normalises it with new URL()).
 */
function wrapperSource(modelHref: string, voskWorkerUrl: string): string {
  return `"use strict";
const MODEL = ${JSON.stringify(modelHref)};
const STEP = ${PROGRESS_STEP_BYTES};
const nativeFetch = self.fetch.bind(self);
self.fetch = async function (input, init) {
  const res = await nativeFetch(input, init);
  const url = typeof input === "string" ? input : input && input.url;
  if (url !== MODEL || !res.ok || !res.body || typeof TransformStream !== "function") return res;
  const total = Number(res.headers.get("Content-Length")) || 0;
  let loaded = 0;
  let posted = 0;
  const post = () => self.postMessage({ event: ${JSON.stringify(PROGRESS_EVENT)}, loaded, total });
  const counter = new TransformStream({
    transform(chunk, ctl) {
      loaded += chunk.byteLength;
      if (loaded - posted >= STEP) { posted = loaded; post(); }
      ctl.enqueue(chunk);
    },
    flush() { post(); },
  });
  return new Response(res.body.pipeThrough(counter), { status: res.status, statusText: res.statusText, headers: res.headers });
};
importScripts(${JSON.stringify(voskWorkerUrl)});
`;
}

/** run `construct` (which must create vosk's Model synchronously) with the progress wrapper around its worker */
export function constructWithProgress<T>(modelUrl: string, construct: () => T): T {
  const win = window as unknown as { Worker: typeof Worker };
  const NativeWorker = win.Worker;
  const modelHref = new URL(modelUrl).href;
  // called with `new`: returning an object from a constructor function makes that object the result
  function WrappedWorker(url: string | URL, options?: WorkerOptions): Worker {
    const src = wrapperSource(modelHref, String(url));
    const wrapperUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    return new NativeWorker(wrapperUrl, options);
  }
  win.Worker = WrappedWorker as unknown as typeof Worker;
  try {
    return construct();
  } finally {
    win.Worker = NativeWorker;
  }
}

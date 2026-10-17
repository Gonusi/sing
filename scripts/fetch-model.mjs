// [voice] Ensures public/vosk/<model>.tar.gz exists with the right sha256 (run in CI before `npm run build`).
// Sources, in order: the file already in place (idempotent) → env VOSK_MODEL_CACHE (a local copy) → download.
// Usage: npm run fetch-model   (plain Node ESM, no dependencies)
// Exit code 1 when no verified copy could be put in place.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const MODEL_FILE = 'vosk-model-small-en-us-0.15.tar.gz';
const MODEL_BYTES = 41_184_862;
const MODEL_SHA256 = 'f0b24bb92a48ca575b6a96500d6b543f0f079c573dfe85bbe16001fc0404e1d8';
const MODEL_URL = `https://ccoreilly.github.io/vosk-browser/models/${MODEL_FILE}`;
/** one retry after the first failed download */
const DOWNLOAD_ATTEMPTS = 2;
const RETRY_WAIT_MS = 3000;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEST = join(ROOT, 'public', 'vosk', MODEL_FILE);
const TMP = `${DEST}.part`;

async function sha256(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/** true when `path` is the expected model (size first: cheap) */
async function verified(path) {
  if (!existsSync(path) || statSync(path).size !== MODEL_BYTES) return false;
  return (await sha256(path)) === MODEL_SHA256;
}

/** move a verified temp file into place; throws (and removes it) when it does not verify */
async function commitTmp(source) {
  if (!(await verified(TMP))) {
    const size = existsSync(TMP) ? statSync(TMP).size : 0;
    rmSync(TMP, { force: true });
    throw new Error(`${source}: size or sha256 mismatch (${size} bytes, expected ${MODEL_BYTES})`);
  }
  renameSync(TMP, DEST);
}

async function fromCache(cachePath) {
  if (!existsSync(cachePath)) throw new Error(`VOSK_MODEL_CACHE=${cachePath} does not exist`);
  copyFileSync(cachePath, TMP);
  await commitTmp(cachePath);
}

async function download() {
  // fetch follows redirects by default
  const res = await fetch(MODEL_URL);
  if (!res.ok || !res.body) throw new Error(`GET ${MODEL_URL}: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(TMP));
  await commitTmp(MODEL_URL);
}

async function downloadWithRetry() {
  for (let attempt = 1; ; attempt++) {
    try {
      await download();
      return;
    } catch (e) {
      rmSync(TMP, { force: true });
      if (attempt >= DOWNLOAD_ATTEMPTS) throw e;
      console.warn(`fetch-model: attempt ${attempt} failed (${e.message}); retrying`);
      await new Promise((r) => setTimeout(r, RETRY_WAIT_MS));
    }
  }
}

async function main() {
  mkdirSync(dirname(DEST), { recursive: true });
  if (await verified(DEST)) {
    console.log(`fetch-model: ${DEST} already verified`);
    return;
  }
  rmSync(DEST, { force: true });
  const cache = process.env.VOSK_MODEL_CACHE;
  if (cache) {
    await fromCache(cache);
    console.log(`fetch-model: copied ${cache} → ${DEST}`);
    return;
  }
  const t0 = performance.now();
  await downloadWithRetry();
  console.log(`fetch-model: downloaded ${MODEL_URL} → ${DEST} in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
}

main().catch((e) => {
  console.error(`fetch-model: FAILED — ${e.message}`);
  process.exit(1);
});

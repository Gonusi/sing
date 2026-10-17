// Shared by every dev/e2e script: start Vite on a free port (PORT env overrides), so parallel runs never collide.
import net from 'node:net';
import { build, createServer, preview } from 'vite';

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

export interface Served {
  /** e.g. http://127.0.0.1:51234/sing/ */
  url: string;
  close(): Promise<void>;
}

/** Vite dev server (fast, serves dev/*.html pages too) */
export async function startDev(root = process.cwd()): Promise<Served> {
  const port = Number(process.env.PORT) || (await freePort());
  const server = await createServer({
    root,
    logLevel: 'warn',
    server: { port, strictPort: true, host: '127.0.0.1' },
  });
  await server.listen();
  return { url: `http://127.0.0.1:${port}/sing/`, close: () => server.close() };
}

/** production build + vite preview (tests base /sing/ and the service worker) */
export async function startPreview(root = process.cwd(), opts: { skipBuild?: boolean } = {}): Promise<Served> {
  if (!opts.skipBuild) await build({ root, logLevel: 'warn' });
  const port = Number(process.env.PORT) || (await freePort());
  const server = await preview({ root, logLevel: 'warn', preview: { port, strictPort: true, host: '127.0.0.1' } });
  return {
    url: `http://127.0.0.1:${port}/sing/`,
    close: () => new Promise<void>((resolve) => server.httpServer.close(() => resolve())),
  };
}

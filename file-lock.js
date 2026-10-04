/* Small helpers for files that both the server and admin-cli.js write.
 * - serial(): one writer at a time inside this process
 * - withLock(): one writer at a time across processes (lock file created with O_EXCL)
 * - atomicWrite(): write to a temp file, fsync, rename — readers never see a half-written file
 * Every file is created owner-only (0600) inside an owner-only directory (0700). */
import { open, rename, unlink, stat, mkdir, chmod } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

const queues = new Map();
export function serial(key, fn) {
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.then(() => fn());
  queues.set(key, next.catch(() => {}));
  return next;
}

export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => {});
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const STALE_MS = 30_000;

export function withLock(file, fn, { waitMs = 5_000 } = {}) {
  return serial(file, async () => {
    await ensureDir(path.dirname(file));
    const lock = file + '.lock';
    const deadline = Date.now() + waitMs;
    let fh = null;
    while (!fh) {
      try { fh = await open(lock, 'wx', 0o600); }
      catch (e) {
        if (e.code !== 'EEXIST') throw e;
        const st = await stat(lock).catch(() => null);
        if (st && Date.now() - st.mtimeMs > STALE_MS) { await unlink(lock).catch(() => {}); continue; }
        if (Date.now() > deadline) throw Object.assign(new Error('Tệp dữ liệu đang bị khóa, thử lại sau.'), { code: 'LOCKED_FILE' });
        await sleep(40);
      }
    }
    try { await fh.writeFile(String(process.pid)); return await fn(); }
    finally { await fh.close().catch(() => {}); await unlink(lock).catch(() => {}); }
  });
}

export async function atomicWrite(file, text) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const fh = await open(tmp, 'wx', 0o600);
  try { await fh.writeFile(text); await fh.sync(); }
  finally { await fh.close(); }
  await rename(tmp, file);
}

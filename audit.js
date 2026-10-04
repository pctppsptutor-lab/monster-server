/* Append-only, tamper-evident audit log (JSON Lines in DATA_DIR/audit.log).
 * Each line carries `prev` (hash of the previous line) and `hash` (SHA-256 of prev + the line body),
 * so editing or deleting any line breaks the chain from that point: `node admin-cli.js verify-audit`.
 * Never put passwords, session ids, CSRF tokens or question content in here — only who/what/when/where. */
import { createHash } from 'node:crypto';
import { open, readFile, appendFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { withLock, ensureDir, atomicWrite } from './file-lock.js';

export const GENESIS = '0'.repeat(64);
const FIELDS = ['actor', 'ip', 'ua', 'outcome', 'reason', 'target', 'gameId', 'from', 'to', 'detail'];
const MAX_FIELD = 300;

const digest = (prev, body) => createHash('sha256').update(prev + '\n' + JSON.stringify(body)).digest('hex');

function clean(fields) {
  const out = {};
  for (const k of FIELDS) {
    const v = fields?.[k];
    if (v === undefined || v === null || v === '') continue;
    out[k] = typeof v === 'number' || typeof v === 'boolean' ? v : String(v).slice(0, MAX_FIELD);
  }
  return out;
}

async function tailText(file, bytes) {
  let st; try { st = await stat(file); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; }
  if (!st || st.size === 0) return '';
  const len = Math.min(st.size, bytes);
  const fh = await open(file, 'r');
  try { const buf = Buffer.alloc(len); await fh.read(buf, 0, len, st.size - len); return buf.toString('utf8'); }
  finally { await fh.close(); }
}

export function createAudit(dataDir, { echo = true } = {}) {
  const file = path.join(dataDir, 'audit.log');
  const anchorFile = process.env.AUDIT_ANCHOR_FILE ? path.resolve(process.env.AUDIT_ANCHOR_FILE) : '';

  async function lastHash() {
    const lines = (await tailText(file, 16_384)).split('\n').filter(Boolean);
    if (!lines.length) return GENESIS;
    try { const h = JSON.parse(lines[lines.length - 1]).hash; if (/^[0-9a-f]{64}$/.test(h)) return h; } catch { /* fall through */ }
    throw Object.assign(new Error('audit.log bị hỏng ở dòng cuối — chạy: node admin-cli.js verify-audit'), { code: 'AUDIT_BROKEN' });
  }

  /** Writes one event. Throws if it cannot be written: callers treat that as a failed operation. */
  function record(event, fields = {}) {
    return withLock(file, async () => {
      await ensureDir(dataDir);
      const prev = await lastHash();
      const body = { ts: new Date().toISOString(), event: String(event).slice(0, 60), ...clean(fields), prev };
      const line = JSON.stringify({ ...body, hash: digest(prev, body) });
      await appendFile(file, line + '\n', { mode: 0o600 });
      if (echo) console.log('AUDIT ' + line);
    });
  }

  /** Most recent entries, newest first (for the admin page). */
  async function recent(limit = 100) {
    const n = Math.max(1, Math.min(200, Number(limit) || 100));
    const lines = (await tailText(file, 512_000)).split('\n').filter(Boolean);
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
      try { const { prev, hash, ...rest } = JSON.parse(lines[i]); out.push(rest); } catch { /* partial first line of the tail window */ }
    }
    return out;
  }

  /** Full chain check. */
  async function verify({ checkAnchor = true } = {}) {
    let text = '', missing = false;
    try { text = await readFile(file, 'utf8'); } catch (e) {
      if (e.code === 'ENOENT') missing = true;
      else return { ok: false, count: 0, message: `Không đọc được audit.log (${e.code || 'IO_ERROR'}).` };
    }
    let anchor = null;
    if (anchorFile && checkAnchor) {
      try { anchor = JSON.parse(await readFile(anchorFile, 'utf8')); }
      catch (e) { return { ok: false, count: 0, message: e.code === 'ENOENT' ? 'Thiếu bản đối chứng AUDIT_ANCHOR_FILE.' : `Không đọc được bản đối chứng (${e.code || 'IO_ERROR'}).` }; }
    }
    if (missing && !anchor) return { ok: true, count: 0, lastHash: GENESIS, message: 'Chưa có nhật ký.' };
    let prev = GENESIS, n = 0, hashAtAnchor = null;
    for (const line of text.split('\n')) {
      if (!line) continue;
      n++;
      let e;
      try { e = JSON.parse(line); } catch { return { ok: false, count: n, brokenAt: n, message: `Dòng ${n} không phải JSON.` }; }
      const { hash, ...body } = e;
      if (body.prev !== prev) return { ok: false, count: n, brokenAt: n, message: `Dòng ${n}: liên kết với dòng trước bị đứt (có dòng bị xóa hoặc chèn).` };
      if (digest(prev, body) !== hash) return { ok: false, count: n, brokenAt: n, message: `Dòng ${n}: nội dung đã bị sửa.` };
      prev = hash;
      if (anchor && n === anchor.count) hashAtAnchor = hash;
    }
    if (anchor && (!Number.isInteger(anchor.count) || anchor.count < 0 || !/^[0-9a-f]{64}$/.test(anchor.hash || ''))) return { ok: false, count: n, message: 'Bản đối chứng sai cấu trúc.' };
    if (anchor && n < anchor.count) return { ok: false, count: n, message: `Nhật ký đã bị cắt: bản đối chứng có ${anchor.count} dòng, hiện chỉ còn ${n}.` };
    if (anchor && anchor.count > 0 && hashAtAnchor !== anchor.hash) return { ok: false, count: n, message: `Bản đối chứng không khớp tại dòng ${anchor.count}.` };
    return { ok: true, count: n, lastHash: prev, message: `${n} dòng, chuỗi băm nguyên vẹn${anchor ? ' và khớp bản đối chứng' : ''}.` };
  }

  async function checkpoint() {
    if (!anchorFile) throw new Error('Chưa đặt AUDIT_ANCHOR_FILE. Hãy trỏ tới ổ/hệ thống tách khỏi DATA_DIR.');
    if (path.dirname(anchorFile) === path.resolve(dataDir)) throw new Error('AUDIT_ANCHOR_FILE phải nằm ngoài DATA_DIR để làm bản đối chứng độc lập.');
    const r = await verify({ checkAnchor: false }); if (!r.ok) throw new Error(r.message);
    await ensureDir(path.dirname(anchorFile));
    await atomicWrite(anchorFile, JSON.stringify({ version: 1, count: r.count, hash: r.lastHash || GENESIS, anchoredAt: new Date().toISOString() }) + '\n');
    return { count: r.count, hash: r.lastHash || GENESIS, anchorFile };
  }

  return { record, recent, verify, checkpoint, file, anchorFile };
}

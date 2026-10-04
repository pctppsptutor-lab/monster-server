/* Admin (content-owner) authentication building blocks. No HTTP here — see admin-routes.js.
 * Passwords: scrypt (OWASP parameters N=2^15 r=8 p=3), 16-byte salt, constant-time compare.
 * Accounts: DATA_DIR/admins.json, written atomically under a lock (server and admin-cli.js share it).
 * Sessions: server-side, random 256-bit ids, only their SHA-256 is kept in memory. */
import { scrypt, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { withLock, atomicWrite } from './file-lock.js';

/* ------------------------------------------------------------ hashing */
export const KDF = Object.freeze({ N: 32768, r: 8, p: 3, keylen: 64 });
const MAXMEM = 96 * 1024 * 1024;
const PARAM_LIMITS = { N: 1 << 20, r: 32, p: 16 };

// At most 2 hashes at once, at most 16 waiting: a login flood cannot exhaust CPU/RAM.
let running = 0; const waiting = [];
async function kdf(password, salt, { N, r, p, keylen }) {
  if (running >= 2) {
    if (waiting.length >= 16) throw Object.assign(new Error('Máy chủ đang bận, thử lại sau ít giây.'), { code: 'BUSY' });
    await new Promise(res => waiting.push(res));
  }
  running++;
  try {
    return await new Promise((res, rej) => scrypt(password, salt, keylen, { N, r, p, maxmem: MAXMEM }, (e, k) => (e ? rej(e) : res(k))));
  } finally { running--; waiting.shift()?.(); }
}

export const normalize = pw => String(pw).normalize('NFKC');

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await kdf(normalize(password), salt, KDF);
  return ['scrypt', KDF.N, KDF.r, KDF.p, salt.toString('base64'), key.toString('base64')].join('$');
}

/** Returns { ok, needsRehash }. Rejects tampered/oversized parameters instead of running them. */
export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return { ok: false, needsRehash: false };
  const [N, r, p] = parts.slice(1, 4).map(Number);
  const salt = Buffer.from(parts[4], 'base64'), want = Buffer.from(parts[5], 'base64');
  const sane = Number.isInteger(N) && N >= 16384 && N <= PARAM_LIMITS.N && (N & (N - 1)) === 0
    && Number.isInteger(r) && r >= 1 && r <= PARAM_LIMITS.r && Number.isInteger(p) && p >= 1 && p <= PARAM_LIMITS.p
    && salt.length >= 16 && want.length >= 32 && want.length <= 128;
  if (!sane) return { ok: false, needsRehash: false };
  const got = await kdf(normalize(password), salt, { N, r, p, keylen: want.length });
  const ok = timingSafeEqual(got, want);
  return { ok, needsRehash: ok && (N < KDF.N || r !== KDF.r || p < KDF.p || want.length !== KDF.keylen) };
}

// Used when the username does not exist, so the response time does not reveal which names are real.
let dummy = null;
export async function dummyHash() { return (dummy ??= await hashPassword(randomBytes(24).toString('base64'))); }

/* ------------------------------------------------------------- policy */
// NIST SP 800-63B: length over composition rules, block known-common and context-specific values.
const COMMON = new Set(`123456789012 1234567890123 12345678901234 123456123456 password1234 password12345 passw0rd1234
qwertyuiop12 qwerty123456 1q2w3e4r5t6y 1qaz2wsx3edc abc123456789 abcdefghijkl iloveyou1234 aaaaaaaaaaaa
matkhau12345 matkhau123456 matkhaumoi123 anhyeuem1234 emyeuanh1234 admin1234567 administrator admin@123456
changeme1234 welcome12345 letmein12345 trustno11234 football1234 baseball1234 superman1234 dragon123456
monkey123456 sunshine1234 princess1234 starwars1234 vietnam12345 hanoi1234567 saigon123456 0123456789ab
11111111111 111111111111 000000000000 987654321098 zaq12wsxcde3 asdfghjkl123 zxcvbnm12345 qwertyuiopas`.split(/\s+/));
const CONTEXT_WORDS = ['edupia', 'classroom', 'admin', 'quantri', 'matkhau', 'password'];

export const PASSWORD_RULES = 'Ít nhất 12 ký tự (nên dùng cụm 3–4 từ), tối đa 128; không chứa tên đăng nhập hay các từ như "edupia", "admin", "matkhau"; không dùng mật khẩu phổ biến.';

/** Returns a Vietnamese error message, or null if the password is acceptable. */
export function checkPasswordPolicy(password, { username = '' } = {}) {
  if (typeof password !== 'string') return 'Mật khẩu không hợp lệ.';
  const pw = normalize(password);
  const len = [...pw].length;
  if (len < 12) return 'Mật khẩu cần ít nhất 12 ký tự.';
  if (len > 128) return 'Mật khẩu tối đa 128 ký tự.';
  if (/[\u0000-\u001f\u007f]/.test(pw)) return 'Mật khẩu không được chứa ký tự điều khiển.';
  const lower = pw.toLowerCase();
  if (new Set(lower).size < 5) return 'Mật khẩu lặp quá nhiều ký tự giống nhau.';
  if (COMMON.has(lower)) return 'Mật khẩu này quá phổ biến.';
  if (username && username.length >= 3 && lower.includes(username.toLowerCase())) return 'Mật khẩu không được chứa tên đăng nhập.';
  const squashed = lower.replace(/[^a-z0-9]/g, '');
  const word = CONTEXT_WORDS.find(w => squashed.includes(w));
  if (word) return `Mật khẩu không được chứa từ "${word}".`;
  return null;
}

/** One-time password handed out by admin-cli.js (≈100 bits, readable, no ambiguous characters). */
export function generateTempPassword() {
  const A = 'abcdefghjkmnpqrstuvwxyz23456789';
  const out = [];
  // rejection sampling keeps the distribution uniform
  while (out.length < 20) { for (const b of randomBytes(32)) { if (b < 248 && out.length < 20) out.push(A[b % 31]); } }
  return out.join('').match(/.{5}/g).join('-');
}

export const USERNAME_RE = /^[a-z0-9][a-z0-9.-]{2,31}$/;
export const TEMP_PASSWORD_TTL_MS = 72 * 3600_000;

/* ------------------------------------------------------------ accounts */
export function createAccountStore(dataDir) {
  const file = path.join(dataDir, 'admins.json');
  let cache = null, sig = null;

  async function load() {
    const st = await stat(file).catch(() => null);
    const now = st ? `${st.ino}:${st.size}:${st.mtimeMs}` : 'none';
    if (cache && now === sig) return cache;
    let data = { version: 1, users: {} };
    if (st) {
      const raw = JSON.parse(await readFile(file, 'utf8'));
      if (!raw || raw.version !== 1 || typeof raw.users !== 'object' || Array.isArray(raw.users)) throw new Error('admins.json sai cấu trúc.');
      data = raw;
    }
    // null-prototype map: usernames can never reach Object.prototype
    data.users = Object.assign(Object.create(null), data.users);
    cache = data; sig = now;
    return cache;
  }

  return {
    file,
    async get(username) { const d = await load(); return USERNAME_RE.test(username) && Object.hasOwn(d.users, username) ? d.users[username] : null; },
    async list() { const d = await load(); return Object.entries(d.users).map(([username, u]) => ({ username, ...u, hash: undefined })); },
    /** fn(user|null, users) may mutate; return value is passed through. Runs under the cross-process lock. */
    update(username, fn) {
      if (!USERNAME_RE.test(username)) throw Object.assign(new Error('Tên đăng nhập không hợp lệ.'), { code: 'BAD_USERNAME' });
      return withLock(file, async () => {
        sig = null; const d = await load();
        const result = await fn(Object.hasOwn(d.users, username) ? d.users[username] : null, d.users);
        await atomicWrite(file, JSON.stringify({ version: 1, users: { ...d.users } }, null, 2) + '\n');
        sig = null;
        return result;
      });
    }
  };
}

/* ------------------------------------------------------------ sessions */
export const SESSION = Object.freeze({ idleMs: 30 * 60_000, absoluteMs: 8 * 3600_000, max: 500 });
const sha = s => createHash('sha256').update(s).digest('hex');

export function createSessionStore(now = () => Date.now()) {
  const map = new Map(); // sha256(id) -> session
  const sweep = () => { const t = now(); for (const [k, s] of map) if (t - s.lastSeen > SESSION.idleMs || t - s.created > SESSION.absoluteMs) map.delete(k); };
  setInterval(sweep, 60_000).unref();
  return {
    create(username, ver) {
      sweep();
      while (map.size >= SESSION.max) map.delete(map.keys().next().value);
      const id = randomBytes(32).toString('base64url');
      const t = now();
      map.set(sha(id), { username, ver, csrf: randomBytes(32).toString('base64url'), created: t, lastSeen: t });
      return id;
    },
    get(id) {
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(id)) return null;
      const k = sha(id), s = map.get(k), t = now();
      if (!s) return null;
      if (t - s.lastSeen > SESSION.idleMs || t - s.created > SESSION.absoluteMs) { map.delete(k); return null; }
      s.lastSeen = t;
      return s;
    },
    revoke(id) { if (typeof id === 'string') map.delete(sha(id)); },
    revokeUser(username) { let n = 0; for (const [k, s] of map) if (s.username === username) { map.delete(k); n++; } return n; },
    expiresAt(s) { return new Date(Math.min(s.lastSeen + SESSION.idleMs, s.created + SESSION.absoluteMs)).toISOString(); }
  };
}

/* ------------------------------------------------------------ throttle */
// Per username (real or not, so lockout says nothing about which names exist) and per client IP.
export const THROTTLE = Object.freeze({ userMax: 5, userLockMs: 15 * 60_000, ipMax: 20, ipWindowMs: 15 * 60_000, cap: 10_000 });

export function createThrottle(now = () => Date.now()) {
  const users = new Map(), ips = new Map();
  const cap = m => { while (m.size > THROTTLE.cap) m.delete(m.keys().next().value); };
  return {
    /** ms until this IP may try again, or 0 */
    ipWait(ip) {
      const e = ips.get(ip); if (!e) return 0;
      if (now() - e.start > THROTTLE.ipWindowMs) { ips.delete(ip); return 0; }
      return e.count >= THROTTLE.ipMax ? THROTTLE.ipWindowMs - (now() - e.start) : 0;
    },
    /** ms until this username may try again, or 0 */
    userWait(username) {
      const e = users.get(username); if (!e?.lockedUntil) return 0;
      const left = e.lockedUntil - now();
      if (left <= 0) { users.delete(username); return 0; }
      return left;
    },
    /** returns true when this failure triggered a new lock */
    fail(ip, username) {
      const t = now();
      const i = ips.get(ip);
      if (!i || t - i.start > THROTTLE.ipWindowMs) ips.set(ip, { count: 1, start: t }); else i.count++;
      let locked = false;
      if (username) {
        const u = users.get(username) || { count: 0, lockedUntil: 0 };
        u.count++;
        if (u.count >= THROTTLE.userMax) { u.lockedUntil = t + THROTTLE.userLockMs; u.count = 0; locked = true; }
        users.delete(username); users.set(username, u);
      }
      cap(ips); cap(users);
      return locked;
    },
    success(username) { users.delete(username); }
  };
}

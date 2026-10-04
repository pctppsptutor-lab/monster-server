/* Security regression tests for /admin. Run: npm test
 * Starts the real server on a random port with a throw-away DATA_DIR, creates an account with admin-cli.js,
 * then attacks it the way an auditor would. Every test talks HTTP to the running process. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = mkdtempSync(path.join(tmpdir(), 'cg-admin-test-'));
const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const ENV = { ...process.env, PORT: String(PORT), DATA_DIR: DATA, TRUST_PROXY: '1', ALLOWED_ORIGINS: 'https://x.test', ADMIN_ORIGIN: '', ADMIN_TOKEN: '' };
let proc;
let ipSeq = 1;
const freshIp = () => `203.0.113.${ipSeq++}`;

const cli = (...args) => execFileSync(process.execPath, ['admin-cli.js', ...args], { cwd: ROOT, env: ENV, encoding: 'utf8' });
const tempPw = out => out.match(/Mật khẩu dùng một lần: (\S+)/)[1];

function client(ip = freshIp()) {
  let cookie = '';
  let csrf = '';
  async function call(method, p, body, { headers = {}, raw = false } = {}) {
    const h = { 'x-forwarded-for': ip, ...headers };
    if (cookie) h.cookie = cookie;
    if (method !== 'GET') { h.origin ??= BASE; h['content-type'] ??= 'application/json'; if (csrf && !('x-csrf-token' in headers)) h['x-csrf-token'] = csrf; }
    for (const k of Object.keys(h)) if (h[k] === null) delete h[k];
    const res = await fetch(BASE + p, { method, headers: h, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) { const v = set.split(';')[0]; cookie = v.endsWith('=') ? '' : v; }
    const json = await res.json().catch(() => null);
    if (json?.csrf) csrf = json.csrf;
    return { status: res.status, json, headers: res.headers, setCookie: set };
  }
  return { call, get cookie() { return cookie; }, set cookie(v) { cookie = v; }, get csrf() { return csrf; }, set csrf(v) { csrf = v; }, ip };
}
const STRONG = 'mây trắng bay qua đồi chè xanh';
const STRONG2 = 'con thuyền nhỏ trôi trên sông hồng';

before(async () => {
  proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stderr.on('data', d => process.stderr.write(d));
  for (let i = 0; i < 100; i++) { try { if ((await fetch(BASE + '/healthz')).ok) return; } catch {} await new Promise(r => setTimeout(r, 100)); }
  throw new Error('server did not start');
});
after(() => { proc?.kill(); rmSync(DATA, { recursive: true, force: true }); });

test('admin page: strict headers, no inline script/style, no browser storage', async () => {
  const res = await fetch(BASE + '/admin');
  assert.equal(res.status, 200);
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'/); assert.match(csp, /style-src 'self'/); assert.match(csp, /frame-ancestors 'none'/); assert.match(csp, /form-action 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const html = await res.text();
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>\s*\S/i, 'inline script');
  assert.doesNotMatch(html, /<style|\sstyle=|\son[a-z]+\s*=/i, 'inline style/handler');
  const js = readFileSync(path.join(ROOT, 'public/admin.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(js, /localStorage|sessionStorage|indexedDB|document\.cookie|innerHTML|insertAdjacentHTML|eval\(/);
});

test('admin refuses plain HTTP unless it is localhost', async () => {
  const status = await new Promise((res, rej) => http.get({ host: '127.0.0.1', port: PORT, path: '/admin', headers: { host: 'classroom.example' } }, r => { r.resume(); res(r.statusCode); }).on('error', rej));
  assert.equal(status, 403);
  const ok = await new Promise((res, rej) => http.get({ host: '127.0.0.1', port: PORT, path: '/admin', headers: { host: 'classroom.example', 'x-forwarded-proto': 'https' } }, r => { r.resume(); res([r.statusCode, r.headers['strict-transport-security']]); }).on('error', rej));
  assert.equal(ok[0], 200); assert.match(ok[1], /max-age=/);
});

test('unknown user and wrong password get the same generic answer', async () => {
  cli('create', 'enum-check');
  const a = await client().call('POST', '/api/admin/login', { username: 'khong-ton-tai', password: 'abc' });
  const b = await client().call('POST', '/api/admin/login', { username: 'enum-check', password: 'abc' });
  assert.equal(a.status, 401); assert.equal(b.status, 401);
  assert.deepEqual(a.json, b.json);
  const c = await client().call('POST', '/api/admin/login', { username: '__proto__', password: 'abc' });
  assert.equal(c.status, 401); assert.deepEqual(c.json, a.json);
});

test('first login: one-time password, cookie flags, forced change, policy, revocation', async () => {
  const pw = tempPw(cli('create', 'duyen'));
  const c = client();
  const r = await c.call('POST', '/api/admin/login', { username: 'Duyen', password: pw });
  assert.equal(r.status, 200); assert.equal(r.json.mustChange, true);
  assert.match(r.setCookie, /^__Host-cg_admin=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict$/);

  assert.equal((await c.call('GET', '/api/admin/sources')).json.code, 'PASSWORD_CHANGE_REQUIRED');
  assert.equal((await c.call('GET', '/api/admin/audit')).status, 403);

  // CSRF defences
  assert.equal((await c.call('POST', '/api/admin/password', { currentPassword: pw, newPassword: STRONG }, { headers: { 'x-csrf-token': null } })).json.code, 'CSRF');
  assert.equal((await c.call('POST', '/api/admin/password', { currentPassword: pw, newPassword: STRONG }, { headers: { origin: 'https://evil.example' } })).json.code, 'BAD_ORIGIN');
  assert.equal((await c.call('POST', '/api/admin/password', JSON.stringify({ currentPassword: pw, newPassword: STRONG }), { raw: true, headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await c.call('GET', '/api/admin/session', undefined, { headers: { 'sec-fetch-site': 'cross-site' } })).json.code, 'CROSS_SITE');

  // policy
  for (const weak of ['short1!', 'aaaaaaaaaaaaaaaa', 'duyen-rat-dai-123', 'Edupia2026!!xx', 'qwertyuiop12']) {
    const w = await c.call('POST', '/api/admin/password', { currentPassword: pw, newPassword: weak });
    assert.equal(w.json.code, 'WEAK_PASSWORD', weak);
  }
  assert.equal((await c.call('POST', '/api/admin/password', { currentPassword: pw, newPassword: pw })).json.code, 'WEAK_PASSWORD');

  // a second session that must die when the password changes
  const other = client();
  await other.call('POST', '/api/admin/login', { username: 'duyen', password: pw });
  assert.equal((await other.call('GET', '/api/admin/session')).status, 200);

  const oldCookie = c.cookie, oldCsrf = c.csrf;
  const ch = await c.call('POST', '/api/admin/password', { currentPassword: pw, newPassword: STRONG });
  assert.equal(ch.status, 200); assert.equal(ch.json.mustChange, false);
  assert.notEqual(c.cookie, oldCookie, 'session id rotated'); assert.notEqual(c.csrf, oldCsrf, 'csrf rotated');
  assert.equal((await c.call('GET', '/api/admin/sources')).status, 200);
  assert.equal((await other.call('GET', '/api/admin/session')).status, 401, 'other session revoked');
  const replay = client(); replay.cookie = oldCookie;
  assert.equal((await replay.call('GET', '/api/admin/session')).status, 401, 'old cookie revoked');

  // the one-time password no longer works; the new one does
  assert.equal((await client().call('POST', '/api/admin/login', { username: 'duyen', password: pw })).status, 401);
  assert.equal((await client().call('POST', '/api/admin/login', { username: 'duyen', password: STRONG })).status, 200);

  // wrong current password is refused
  assert.equal((await c.call('POST', '/api/admin/password', { currentPassword: 'sai mat khau roi', newPassword: STRONG2 })).json.code, 'BAD_CURRENT');
});

test('login rotates session id (no fixation) and logout kills the session', async () => {
  const c = client();
  c.cookie = '__Host-cg_admin=' + 'A'.repeat(43);
  await c.call('POST', '/api/admin/login', { username: 'duyen', password: STRONG });
  assert.notEqual(c.cookie, '__Host-cg_admin=' + 'A'.repeat(43));
  const cookie = c.cookie;
  const out = await c.call('POST', '/api/admin/logout', {});
  assert.equal(out.status, 200); assert.match(out.setCookie, /Max-Age=0/);
  const again = client(); again.cookie = cookie;
  assert.equal((await again.call('GET', '/api/admin/session')).status, 401);
});

test('lockout after 5 failures blocks even the right password — same for unknown names', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await client().call('POST', '/api/admin/login', { username: 'duyen', password: 'sai ' + i })).status, 401);
  const locked = await client().call('POST', '/api/admin/login', { username: 'duyen', password: STRONG });
  assert.equal(locked.status, 429); assert.equal(locked.json.code, 'LOCKED');
  for (let i = 0; i < 5; i++) await client().call('POST', '/api/admin/login', { username: 'ma-ao', password: 'sai ' + i });
  assert.equal((await client().call('POST', '/api/admin/login', { username: 'ma-ao', password: 'x' })).json.code, 'LOCKED');
});

test('per-IP limit across many usernames', async () => {
  const ip = freshIp();
  for (let i = 0; i < 20; i++) await client(ip).call('POST', '/api/admin/login', { username: 'spray-' + i, password: 'Password123!' });
  assert.equal((await client(ip).call('POST', '/api/admin/login', { username: 'spray-x', password: 'x' })).json.code, 'RATE_LIMITED');
});

test('sources: CSRF required, bad links rejected with a safe message, body size capped', async () => {
  cli('create', 'nga');
  const pw = tempPw(cli('reset', 'nga'));
  const c = client();
  await c.call('POST', '/api/admin/login', { username: 'nga', password: pw });
  await c.call('POST', '/api/admin/password', { currentPassword: pw, newPassword: STRONG2 });
  assert.equal((await c.call('PUT', '/api/admin/sources/meo-leo-cau', { sourceUrl: 'https://docs.google.com/document/d/abc' }, { headers: { 'x-csrf-token': 'nope' } })).json.code, 'CSRF');
  const bad = await c.call('PUT', '/api/admin/sources/meo-leo-cau', { sourceUrl: 'http://169.254.169.254/latest' });
  assert.equal(bad.status, 400); assert.match(bad.json.error, /HTTPS/);
  const huge = await c.call('POST', '/api/admin/preview', { sourceUrl: 'x'.repeat(20_000) });
  assert.equal(huge.status, 413);
  const good = await c.call('PUT', '/api/admin/sources/meo-leo-cau', { sourceUrl: 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUv/edit' });
  assert.equal(good.status, 200);
  const list = await c.call('GET', '/api/admin/sources');
  assert.equal(list.json['meo-leo-cau'].draft.sourceUrl, 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUv/edit');
});

test('content-owner scope limits games/grade prefixes', async () => {
  const pw = tempPw(cli('create', 'scope-user')); cli('scope', 'scope-user', 'grade-3-*');
  const c = client(); await c.call('POST', '/api/admin/login', { username: 'scope-user', password: pw }); await c.call('POST', '/api/admin/password', { currentPassword: pw, newPassword: STRONG });
  assert.equal((await c.call('PUT', '/api/admin/sources/grade-4-game', { sourceUrl: 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUv/edit' })).status, 403);
  assert.equal((await c.call('PUT', '/api/admin/sources/grade-3-game', { sourceUrl: 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUv/edit' })).status, 200);
});

test('CLI disable revokes a live session at the next request', async () => {
  const c = client();
  assert.equal((await c.call('POST', '/api/admin/login', { username: 'nga', password: STRONG2 })).status, 200);
  cli('disable', 'nga');
  assert.equal((await c.call('GET', '/api/admin/sources')).status, 401);
  assert.equal((await client().call('POST', '/api/admin/login', { username: 'nga', password: STRONG2 })).status, 401);
});

test('audit log: complete, no secrets, tamper-evident', async () => {
  const text = readFileSync(path.join(DATA, 'audit.log'), 'utf8');
  for (const ev of ['account.create', 'password.reset', 'login.failure', 'login.success', 'account.locked', 'login.blocked', 'password.change', 'logout', 'csrf.reject', 'source.draft', 'account.disable'])
    assert.match(text, new RegExp(`"event":"${ev.replace('.', '\\.')}"`), ev);
  for (const secret of [STRONG, STRONG2, 'sai 0', 'Password123!']) assert.ok(!text.includes(secret), 'secret leaked into audit log');
  assert.doesNotMatch(text, /__Host-cg_admin|csrf"/);
  assert.match(cli('verify-audit'), /^OK/);
  const lines = text.trim().split('\n');
  const edited = JSON.parse(lines[3]); edited.actor = 'ke-gian';
  writeFileSync(path.join(DATA, 'audit.log'), [...lines.slice(0, 3), JSON.stringify(edited), ...lines.slice(4)].join('\n') + '\n');
  assert.throws(() => cli('verify-audit'), e => e.status === 2 && /LỖI/.test(e.stdout), 'edited line detected');
  writeFileSync(path.join(DATA, 'audit.log'), [...lines.slice(0, 3), ...lines.slice(4)].join('\n') + '\n');
  assert.throws(() => cli('verify-audit'), e => e.status === 2 && /LỖI/.test(e.stdout), 'deleted line detected');
});

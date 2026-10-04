/* /admin and /api/admin/* — the content owner's password-protected area.
 *
 * Security controls (see references/admin.md in the skill for the full threat model):
 *  - HTTPS only (direct TLS, X-Forwarded-Proto from a trusted proxy, or http://localhost for testing)
 *  - session cookie `__Host-cg_admin`: Secure, HttpOnly, SameSite=Strict, Path=/; nothing kept in browser storage
 *  - every state-changing request: exact Origin match + per-session CSRF token header + JSON content type
 *  - generic login errors, constant work for unknown users, lockout per username and per IP
 *  - first login with a one-time password must change it; changing a password revokes every other session
 *  - every security-relevant action goes to the hash-chained audit log; if logging fails the action fails
 *  - strict CSP (no inline script or style), frame-ancestors 'none', no-store on everything */
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  verifyPassword, hashPassword, dummyHash, checkPasswordPolicy, normalize, PASSWORD_RULES, USERNAME_RE,
  createAccountStore, createSessionStore, createThrottle, SESSION
} from './admin-auth.js';
import { createAudit } from './audit.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const COOKIE = '__Host-cg_admin';
const PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'";
const BASE_HEADERS = {
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'cache-control': 'no-store',
  'cross-origin-opener-policy': 'same-origin', 'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()', 'x-robots-tag': 'noindex, nofollow'
};
const GENERIC_LOGIN = 'Sai tên đăng nhập hoặc mật khẩu.';
const MAX_BODY = 8_192;

class HttpError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const eq = (a, b) => { const x = Buffer.from(String(a ?? '')), y = Buffer.from(String(b ?? '')); return x.length === y.length && timingSafeEqual(x, y); };
const minutes = ms => Math.max(1, Math.ceil(ms / 60_000));

export function createAdmin({ dataDir, trustProxy = 0, adminOrigin = '', sources, log = () => {}, now = () => Date.now() }) {
  const accounts = createAccountStore(dataDir);
  const sessions = createSessionStore(now);
  const throttle = createThrottle(now);
  const audit = createAudit(dataDir);
  const previewHits = new Map(); // session csrf -> [timestamps]
  const files = {};
  const asset = async name => (files[name] ??= await readFile(path.join(HERE, 'public', name)));

  /* -------------------------------------------------------- request facts */
  function clientIp(req) {
    const sock = req.socket.remoteAddress || '';
    if (!trustProxy) return sock;
    const chain = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
    return chain.length ? chain[Math.max(0, chain.length - trustProxy)] : sock;
  }
  const isLoopback = a => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
  function hostName(req) { try { return new URL('http://' + (req.headers.host || '')).hostname; } catch { return ''; } }
  // 'https' only when TLS is real: direct TLS, or a trusted proxy said so (last X-Forwarded-Proto value).
  const viaHttps = req => Boolean(req.socket.encrypted) || Boolean(trustProxy && String(req.headers['x-forwarded-proto'] || '').split(',').pop().trim().toLowerCase() === 'https');
  // plain http is tolerated only for a browser on the server machine itself (local testing)
  const isLocalDev = req => isLoopback(req.socket.remoteAddress) && ['localhost', '127.0.0.1', '[::1]'].includes(hostName(req));
  const isSecure = req => viaHttps(req) || isLocalDev(req);
  const expectedOrigin = req => adminOrigin || `${viaHttps(req) ? 'https' : 'http'}://${req.headers.host}`;
  const who = req => ({ ip: clientIp(req), ua: String(req.headers['user-agent'] || '').slice(0, 200) });

  function readCookie(req) {
    for (const part of String(req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
    }
    return null;
  }
  const setCookie = id => `${COOKIE}=${id}; Path=/; Secure; HttpOnly; SameSite=Strict`;
  const clearCookie = `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;

  async function readJson(req, max = MAX_BODY) {
    if (Number(req.headers['content-length'] || 0) > max) throw new HttpError(413, 'TOO_LARGE', 'Dữ liệu quá lớn.');
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > max) { req.destroy(); throw new HttpError(413, 'TOO_LARGE', 'Dữ liệu quá lớn.'); } chunks.push(c); }
    let v; try { v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new HttpError(400, 'BAD_JSON', 'JSON không hợp lệ.'); }
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'BAD_JSON', 'JSON không hợp lệ.');
    return v;
  }

  function send(req, res, status, data, extra = {}) {
    const headers = { ...BASE_HEADERS, 'content-type': 'application/json; charset=utf-8', ...extra };
    if (viaHttps(req)) headers['strict-transport-security'] = 'max-age=31536000';
    res.writeHead(status, headers);
    res.end(JSON.stringify(data));
  }

  /* ------------------------------------------------------------- guards */
  async function requireSession(req, { csrf, allowMustChange = false }) {
    const id = readCookie(req);
    const s = id && sessions.get(id);
    if (!s) throw new HttpError(401, 'AUTH_REQUIRED', 'Phiên đã hết hạn, vui lòng đăng nhập lại.');
    const user = await accounts.get(s.username);
    if (!user || user.disabled || user.tokenVersion !== s.ver) { sessions.revoke(id); throw new HttpError(401, 'AUTH_REQUIRED', 'Phiên không còn hiệu lực, vui lòng đăng nhập lại.'); }
    if (csrf && !eq(req.headers['x-csrf-token'], s.csrf)) {
      await audit.record('csrf.reject', { actor: s.username, ...who(req), detail: req.url });
      throw new HttpError(403, 'CSRF', 'Yêu cầu không hợp lệ. Tải lại trang rồi thử lại.');
    }
    if (user.mustChange && !allowMustChange) throw new HttpError(403, 'PASSWORD_CHANGE_REQUIRED', 'Cần đổi mật khẩu trước khi tiếp tục.');
    return { id, s, user };
  }
  const scopesOf = user => Array.isArray(user.scopes) && user.scopes.length ? user.scopes : ['*'];
  const canAccess = (user, gameId) => scopesOf(user).some(scope => scope === '*' || (scope.endsWith('*') ? gameId.startsWith(scope.slice(0, -1)) : scope === gameId));
  const requireGame = (user, gameId) => { if (!canAccess(user, gameId)) throw new HttpError(403, 'FORBIDDEN_GAME', 'Tài khoản không được phụ trách game/khối lớp này.'); };
  const sessionInfo = (s, user) => ({ username: s.username, scopes: scopesOf(user), mustChange: Boolean(user.mustChange), csrf: s.csrf, expiresAt: sessions.expiresAt(s), idleMinutes: SESSION.idleMs / 60_000, passwordRules: PASSWORD_RULES });

  /* ------------------------------------------------------------- routes */
  async function login(req, res) {
    const b = await readJson(req);
    const ctx = who(req);
    const username = String(b.username ?? '').trim().toLowerCase().slice(0, 64);
    const password = typeof b.password === 'string' ? b.password : '';

    const ipWait = throttle.ipWait(ctx.ip);
    if (ipWait) {
      await audit.record('login.blocked', { actor: username, ...ctx, reason: 'ip_rate_limit' });
      throw new HttpError(429, 'RATE_LIMITED', `Quá nhiều lần đăng nhập sai từ máy này. Thử lại sau ${minutes(ipWait)} phút.`);
    }
    const valid = USERNAME_RE.test(username) && password.length > 0 && Buffer.byteLength(password) <= 1024;
    const userWait = valid ? throttle.userWait(username) : 0;
    if (userWait) {
      await audit.record('login.blocked', { actor: username, ...ctx, reason: 'user_locked' });
      throw new HttpError(429, 'LOCKED', `Đăng nhập với tên này đang tạm khóa do nhập sai nhiều lần. Thử lại sau ${minutes(userWait)} phút.`);
    }

    const user = valid ? await accounts.get(username) : null;
    // Always run one KDF, so a missing account costs the same time as a wrong password.
    const { ok, needsRehash } = await verifyPassword(valid ? password : 'x', user?.hash ?? await dummyHash());
    let reason = null;
    if (!valid) reason = 'malformed';
    else if (!user) reason = 'unknown_user';
    else if (!ok) reason = 'bad_password';
    else if (user.disabled) reason = 'disabled';
    else if (user.mustChange && user.tempExpiresAt && Date.parse(user.tempExpiresAt) < now()) reason = 'temp_password_expired';
    if (reason) {
      const locked = throttle.fail(ctx.ip, valid ? username : null);
      await audit.record('login.failure', { actor: valid ? username : '(không hợp lệ)', ...ctx, reason });
      if (locked) await audit.record('account.locked', { actor: username, ...ctx, detail: 'tạm khóa 15 phút' });
      throw new HttpError(401, 'BAD_CREDENTIALS', GENERIC_LOGIN);
    }

    throttle.success(username);
    if (needsRehash) { const h = await hashPassword(password); await accounts.update(username, u => { if (u) u.hash = h; }); }
    const old = readCookie(req); if (old) sessions.revoke(old); // never reuse a pre-login session id
    const id = sessions.create(username, user.tokenVersion);
    await audit.record('login.success', { actor: username, ...ctx, outcome: user.mustChange ? 'must_change_password' : 'ok' });
    send(req, res, 200, sessionInfo(sessions.get(id), user), { 'set-cookie': setCookie(id) });
  }

  async function logout(req, res) {
    const { id, s } = await requireSession(req, { csrf: true, allowMustChange: true });
    sessions.revoke(id);
    await audit.record('logout', { actor: s.username, ...who(req) });
    send(req, res, 200, { ok: true }, { 'set-cookie': clearCookie });
  }

  async function changePassword(req, res) {
    const { s, user } = await requireSession(req, { csrf: true, allowMustChange: true });
    const b = await readJson(req);
    const ctx = who(req);
    const current = typeof b.currentPassword === 'string' ? b.currentPassword : '';
    const next = typeof b.newPassword === 'string' ? b.newPassword : '';

    const wait = throttle.userWait(s.username);
    if (wait) throw new HttpError(429, 'LOCKED', `Nhập sai mật khẩu hiện tại quá nhiều lần. Thử lại sau ${minutes(wait)} phút.`);
    const { ok } = Buffer.byteLength(current) <= 1024 && current ? await verifyPassword(current, user.hash) : { ok: false };
    if (!ok) {
      const locked = throttle.fail(ctx.ip, s.username);
      await audit.record('password.change', { actor: s.username, ...ctx, outcome: 'failure', reason: 'bad_current_password' });
      if (locked) { sessions.revokeUser(s.username); await audit.record('account.locked', { actor: s.username, ...ctx, detail: 'sai mật khẩu hiện tại nhiều lần; đã đăng xuất mọi phiên' }); }
      throw new HttpError(400, 'BAD_CURRENT', 'Mật khẩu hiện tại không đúng.');
    }
    const policy = checkPasswordPolicy(next, { username: s.username });
    const same = !policy && normalize(next) === normalize(current);
    if (policy || same) {
      await audit.record('password.change', { actor: s.username, ...ctx, outcome: 'failure', reason: same ? 'same_as_current' : 'policy' });
      throw new HttpError(400, 'WEAK_PASSWORD', same ? 'Mật khẩu mới phải khác mật khẩu hiện tại.' : policy);
    }

    const hash = await hashPassword(next);
    const newVer = await accounts.update(s.username, u => {
      if (!u || u.tokenVersion !== s.ver) throw new HttpError(401, 'AUTH_REQUIRED', 'Tài khoản vừa được thay đổi ở nơi khác, vui lòng đăng nhập lại.');
      u.hash = hash; u.mustChange = false; u.tempExpiresAt = null; u.passwordChangedAt = new Date(now()).toISOString(); u.tokenVersion += 1;
      return u.tokenVersion;
    });
    throttle.success(s.username);
    const revoked = sessions.revokeUser(s.username); // includes this one
    const fresh = sessions.create(s.username, newVer);
    await audit.record('password.change', { actor: s.username, ...ctx, outcome: 'success', detail: `đã thu hồi ${revoked} phiên` });
    send(req, res, 200, sessionInfo(sessions.get(fresh), { mustChange: false }), { 'set-cookie': setCookie(fresh) });
  }

  async function listSources(req, res) {
    const { user } = await requireSession(req, { csrf: false }); const all = await sources.list();
    send(req, res, 200, Object.fromEntries(Object.entries(all).filter(([gameId]) => canAccess(user, gameId))));
  }

  async function putSource(req, res, gameId) {
    const { s, user } = await requireSession(req, { csrf: true }); requireGame(user, gameId);
    const b = await readJson(req);
    const url = String(b.sourceUrl ?? '').trim().slice(0, 2048);
    let result;
    try { result = await sources.setDraft(gameId, url, s.username); }
    catch (e) {
      await audit.record('source.draft', { actor: s.username, ...who(req), gameId, to: url, outcome: 'failure', reason: e.code === 'BAD_SOURCE' ? e.message : 'error' });
      throw e;
    }
    await audit.record('source.draft', { actor: s.username, ...who(req), gameId, to: url, outcome: 'success' });
    send(req, res, 200, result);
  }

  async function workflow(req, res, gameId, action) {
    const { s, user } = await requireSession(req, { csrf: true }); requireGame(user, gameId);
    const b = await readJson(req); let result;
    try {
      if (action === 'review') result = await sources.reviewDraft(gameId, s.username);
      else if (action === 'publish') result = await sources.publishDraft(gameId, s.username);
      else result = await sources.restoreVersion(gameId, Number(b.version), s.username);
    } catch (e) { await audit.record(`source.${action}`, { actor: s.username, ...who(req), gameId, outcome: 'failure', reason: e.code === 'BAD_SOURCE' ? e.message : 'error' }); throw e; }
    await audit.record(`source.${action}`, { actor: s.username, ...who(req), gameId, outcome: 'success', detail: action === 'restore' ? `version ${Number(b.version)}` : '' });
    send(req, res, 200, action === 'review' ? { bank: result.bank, entry: result.entry } : result);
  }

  async function preview(req, res) {
    const { s, user } = await requireSession(req, { csrf: true });
    const t = now(), hits = (previewHits.get(s.csrf) || []).filter(x => t - x < 60_000);
    if (hits.length >= 20) throw new HttpError(429, 'RATE_LIMITED', 'Kiểm tra link quá nhiều lần, chờ một phút.');
    hits.push(t); previewHits.set(s.csrf, hits);
    if (previewHits.size > 1000) previewHits.delete(previewHits.keys().next().value);
    const b = await readJson(req);
    const gameId = String(b.gameId ?? '').trim(); requireGame(user, gameId);
    const url = String(b.sourceUrl ?? '').trim().slice(0, 2048);
    try {
      const bank = await sources.preview(url);
      await audit.record('source.preview', { actor: s.username, ...who(req), to: url, outcome: 'success' });
      send(req, res, 200, bank);
    } catch (e) {
      await audit.record('source.preview', { actor: s.username, ...who(req), to: url, outcome: 'failure' });
      throw e;
    }
  }

  async function getBank(req, res, gameId) {
    const { user } = await requireSession(req, { csrf: false });
    requireGame(user, gameId);
    if (!sources.getBank) throw new HttpError(404, 'NOT_SUPPORTED', 'Chưa hỗ trợ lấy ngân hàng câu hỏi.');
    const bank = await sources.getBank(gameId);
    send(req, res, 200, bank);
  }

  async function saveBank(req, res, gameId) {
    const { s, user } = await requireSession(req, { csrf: true });
    requireGame(user, gameId);
    if (!sources.saveDirect) throw new HttpError(404, 'NOT_SUPPORTED', 'Chưa hỗ trợ lưu trực tiếp.');
    const b = await readJson(req, 500_000);
    const publish = Boolean(b.publish);
    let result;
    try {
      result = await sources.saveDirect(gameId, b.bank, { publish, actor: s.username });
    } catch (e) {
      await audit.record(publish ? 'source.publish' : 'source.draft', { actor: s.username, ...who(req), gameId, outcome: 'failure', reason: e.code === 'BAD_SOURCE' ? e.message : e.message || 'error' });
      throw e;
    }
    await audit.record(publish ? 'source.publish' : 'source.draft', { actor: s.username, ...who(req), gameId, outcome: 'success', detail: `trực tiếp: ${result.bank.questions.length} câu` });
    send(req, res, 200, result);
  }

  async function auditLog(req, res, url) {
    await requireSession(req, { csrf: false });
    send(req, res, 200, await audit.recent(url.searchParams.get('limit')));
  }

  /* ------------------------------------------------------------- entry */
  async function serveAsset(req, res, name, type) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { ...BASE_HEADERS, allow: 'GET, HEAD' }); return res.end(); }
    if (!isSecure(req)) {
      res.writeHead(403, { ...BASE_HEADERS, 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Trang quản trị chỉ mở qua HTTPS. Nếu máy chủ đứng sau reverse proxy, đặt TRUST_PROXY=1 và cho proxy gửi X-Forwarded-Proto.');
    }
    const body = await asset(name);
    res.writeHead(200, { ...BASE_HEADERS, 'content-type': type, 'content-security-policy': PAGE_CSP, ...(viaHttps(req) ? { 'strict-transport-security': 'max-age=31536000' } : {}) });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  async function api(req, res, url) {
    if (!isSecure(req)) throw new HttpError(403, 'HTTPS_REQUIRED', 'Trang quản trị chỉ hoạt động qua HTTPS.');
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin') throw new HttpError(403, 'CROSS_SITE', 'Yêu cầu từ trang khác bị từ chối.');
    if (req.method !== 'GET') {
      if (req.headers.origin !== expectedOrigin(req)) throw new HttpError(403, 'BAD_ORIGIN', 'Yêu cầu từ trang khác bị từ chối.');
      if (!/^application\/json(\s*;|$)/i.test(String(req.headers['content-type'] || ''))) throw new HttpError(415, 'BAD_TYPE', 'Cần Content-Type: application/json.');
    }
    const p = url.pathname, m = req.method;
    if (m === 'POST' && p === '/api/admin/login') return login(req, res);
    if (m === 'GET' && p === '/api/admin/session') { const { s, user } = await requireSession(req, { csrf: false, allowMustChange: true }); return send(req, res, 200, sessionInfo(s, user)); }
    if (m === 'POST' && p === '/api/admin/logout') return logout(req, res);
    if (m === 'POST' && p === '/api/admin/password') return changePassword(req, res);
    if (m === 'GET' && p === '/api/admin/sources') return listSources(req, res);
    const g = p.match(/^\/api\/admin\/sources\/([a-z0-9-]{2,40})$/);
    if (m === 'PUT' && g) return putSource(req, res, g[1]);
    const gBank = p.match(/^\/api\/admin\/sources\/([a-z0-9-]{2,40})\/bank$/);
    if (m === 'GET' && gBank) return getBank(req, res, gBank[1]);
    if (m === 'POST' && gBank) return saveBank(req, res, gBank[1]);
    const wf = p.match(/^\/api\/admin\/sources\/([a-z0-9-]{2,40})\/(review|publish|restore)$/);
    if (m === 'POST' && wf) return workflow(req, res, wf[1], wf[2]);
    if (m === 'POST' && p === '/api/admin/preview') return preview(req, res);
    if (m === 'GET' && p === '/api/admin/audit') return auditLog(req, res, url);
    throw new HttpError(404, 'NOT_FOUND', 'Không có.');
  }

  /** Returns true if the request belonged to the admin area (and has been answered). */
  async function handle(req, res, url) {
    const p = url.pathname;
    if (p !== '/admin' && p !== '/admin.js' && p !== '/admin.css' && !p.startsWith('/api/admin/')) return false;
    try {
      if (p === '/admin') await serveAsset(req, res, 'admin.html', 'text/html; charset=utf-8');
      else if (p === '/admin.js') await serveAsset(req, res, 'admin.js', 'text/javascript; charset=utf-8');
      else if (p === '/admin.css') await serveAsset(req, res, 'admin.css', 'text/css; charset=utf-8');
      else await api(req, res, url);
    } catch (e) {
      if (res.headersSent) { res.destroy(); return true; }
      if (e instanceof HttpError) send(req, res, e.status, { error: e.message, code: e.code });
      else if (e.code === 'BAD_SOURCE') send(req, res, 400, { error: e.message, code: e.code });
      else if (e.code === 'BUSY' || e.code === 'LOCKED_FILE') send(req, res, 503, { error: e.message, code: e.code }, { 'retry-after': '5' });
      else { log('admin error', e); send(req, res, 500, { error: 'Lỗi máy chủ.', code: 'SERVER_ERROR' }); }
    }
    return true;
  }

  return { handle, accounts, audit };
}

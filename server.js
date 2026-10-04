/* Edupia Classroom Server 2.0.0 — one deployment serves every game built with edupiagamebuilder.
 * Authority: grading, rooms, timers and snapshots live HERE (shared/room-core.js). Clients are untrusted. */
import http from 'node:http';
import { randomUUID, randomInt, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { ROOM_PROTOCOL, createRoomState, apply, tick, teacherView, studentView, learnerRound } from './shared/room-core.js';
import { loadBankForGame, loadBankFromUrl, listSourceStatus, setDraft, reviewDraft, publishDraft, restoreVersion, getBankForGame, saveBankDirect } from './content-source.js';
import { authenticateTeacher } from './auth.js';
import { createAdmin } from './admin-routes.js';

try { process.loadEnvFile?.(); } catch { /* no .env file */ }
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const ALLOWED_ORIGINS = new Set((process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean));
const argGames = process.argv.indexOf('--games');
const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const TRUST_PROXY = Math.max(0, Math.min(5, Number.parseInt(process.env.TRUST_PROXY || '0', 10) || 0));
const ADMIN_ORIGIN = (process.env.ADMIN_ORIGIN || '').trim().replace(/\/$/, '');
const GAMES_DIR = argGames > 0 ? path.resolve(process.argv[argGames + 1]) : process.env.GAMES_DIR ? path.resolve(process.env.GAMES_DIR) : null;
const LIM = { payload: 16_384, msgPerSec: 20, roomsPerTeacher: 20, idleMs: 6 * 3600_000, endedIdleMs: 30 * 60_000 };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; media-src 'self' https:; connect-src 'self' ws: wss:; frame-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'; object-src 'none'";

const eq = (a, b) => { const x = Buffer.from(String(a ?? '')), y = Buffer.from(String(b ?? '')); return x.length === y.length && timingSafeEqual(x, y); };
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const log = (...a) => console.log(new Date().toISOString(), ...a);

/* ---------------------------------------------------------------- rooms */
const rooms = new Map(); // key gameId:roomCode
const key = (g, c) => `${g}:${c}`;

function newCode(gameId) {
  for (let i = 0; i < 50; i++) { const c = Array.from({ length: 6 }, () => ALPHA[randomInt(ALPHA.length)]).join(''); if (!rooms.has(key(gameId, c))) return c; }
  throw new Error('no code');
}
function publish(room) {
  const t = room.teacherWs;
  if (t?.readyState === 1) t.send(JSON.stringify({ type: 'snapshot', data: teacherView(room.state) }));
  for (const [playerId, ws] of room.players) if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'snapshot', data: studentView(room.state, playerId) }));
}
async function refreshContent(room) {
  const ticket = ++room.loadTicket;
  try {
    const bank = await loadBankForGame(room.state.gameId);
    if (ticket === room.loadTicket) apply(room.state, { role: 'system' }, 'contentLoaded', { bank });
  } catch (e) {
    if (ticket === room.loadTicket) apply(room.state, { role: 'system' }, 'contentError', { message: e.message });
  }
  publish(room);
}

/* ------------------------------------------------------------ handlers */
const E = (code, message) => Object.assign(new Error(message), { code });
function roomOf(conn) { const r = conn.roomKey && rooms.get(conn.roomKey); if (!r) throw E('ROOM_NOT_FOUND', 'Phòng không còn tồn tại.'); return r; }
function kick(ws) { if (ws?.readyState === 1) { ws.send(JSON.stringify({ type: 'event', data: { kind: 'replaced' } })); ws.close(4001, 'replaced'); } }

const ops = {
  async createRoom(conn, p) {
    if (conn.role !== 'teacher') throw E('FORBIDDEN', 'Không có quyền.');
    const mine = [...rooms.values()].filter(r => r.teacherId === conn.teacherId && r.state.status !== 'ended').length;
    if (mine >= LIM.roomsPerTeacher) throw E('TOO_MANY_ROOMS', 'Bạn đang mở quá nhiều phòng.');
    const roomCode = newCode(conn.gameId);
    const pace = p.pace === 'teacher' ? 'teacher' : 'self';
    const room = {
      state: createRoomState({ roomCode, gameId: conn.gameId, pace, maxPlayers: Math.min(Number(p.maxPlayers) || 4, 40), lateJoin: p.lateJoin === 'next-round' ? 'next-round' : 'current', revealAnswers: p.revealAnswers === 'all-submitted' ? 'all-submitted' : 'immediate', now: Date.now() }),
      teacherId: conn.teacherId, teacherToken: randomUUID(), teacherWs: null, players: new Map(), secrets: new Map(), loadTicket: 0
    };
    rooms.set(key(conn.gameId, roomCode), room);
    bindTeacher(conn, room);
    refreshContent(room);
    log('room created', conn.gameId, roomCode);
    return { roomCode, identity: { roomCode, teacherToken: room.teacherToken } };
  },
  async resumeTeacher(conn, p) {
    if (conn.role !== 'teacher') throw E('FORBIDDEN', 'Không có quyền.');
    const room = rooms.get(key(conn.gameId, String(p.roomCode)));
    if (!room) throw E('ROOM_NOT_FOUND', 'Phòng không còn tồn tại.');
    if (!eq(p.teacherToken, room.teacherToken) || room.teacherId !== conn.teacherId) throw E('BAD_TOKEN', 'Phiên giáo viên không hợp lệ.');
    bindTeacher(conn, room);
    if (room.state.status !== 'playing') refreshContent(room);
    return { roomCode: room.state.roomCode };
  },
  async reloadContent(conn) { const r = teacherRoom(conn); await refreshContent(r); return teacherView(r.state).content; },
  async start(conn, p) {
    const r = teacherRoom(conn);
    if (p.allowStale !== true) await refreshContent(r); // fresh read right before every new round
    return teacherOp(r, 'start', { allowStale: p.allowStale === true, roundId: randomUUID() });
  },
  async next(conn) { return teacherOp(teacherRoom(conn), 'next', {}); },
  async pause(conn) { return teacherOp(teacherRoom(conn), 'pause', {}); },
  async resumeGame(conn) { return teacherOp(teacherRoom(conn), 'resume', {}); },
  async setLocked(conn, p) { return teacherOp(teacherRoom(conn), 'setLocked', { locked: p.locked === true }); },
  async setLateJoin(conn, p) { return teacherOp(teacherRoom(conn), 'setLateJoin', { value: String(p.value || '') }); },
  async setRevealMode(conn, p) { return teacherOp(teacherRoom(conn), 'setRevealMode', { value: String(p.value || '') }); },
  async kick(conn, p) {
    const room = teacherRoom(conn), playerId = String(p.playerId || '');
    const r = apply(room.state, { role: 'teacher' }, 'kick', { playerId }, Date.now());
    if (!r.ok) throw E(r.code, r.error);
    const ws = room.players.get(playerId); room.players.delete(playerId); room.secrets.delete(playerId);
    if (ws?.readyState === 1) { ws.send(JSON.stringify({ type: 'event', data: { kind: 'kicked' } })); ws.close(4002, 'kicked'); }
    publish(room); return {};
  },
  async end(conn) { return teacherOp(teacherRoom(conn), 'end', {}); },
  async restart(conn) { const r = teacherRoom(conn); const out = teacherOp(r, 'restart', {}); refreshContent(r); return out; },

  async join(conn, p) {
    if (conn.role !== 'student') throw E('FORBIDDEN', 'Không có quyền.');
    if (p.gameId !== conn.gameId) throw E('WRONG_GAME', 'Mã phòng thuộc trò chơi khác.');
    const room = rooms.get(key(conn.gameId, String(p.roomCode || '').toUpperCase()));
    if (!room) throw E('ROOM_NOT_FOUND', 'Không tìm thấy phòng. Kiểm tra lại mã với giáo viên.');
    const playerId = randomUUID();
    const r = apply(room.state, { role: 'system' }, 'addPlayer', { playerId, name: p.name }, Date.now());
    if (!r.ok) throw E(r.code, r.error);
    const resumeToken = randomUUID();
    room.secrets.set(playerId, resumeToken);
    bindStudent(conn, room, playerId);
    return { identity: { roomCode: room.state.roomCode, playerId, resumeToken } };
  },
  async resumeStudent(conn, p) {
    if (conn.role !== 'student') throw E('FORBIDDEN', 'Không có quyền.');
    const room = rooms.get(key(conn.gameId, String(p.roomCode)));
    if (!room) throw E('ROOM_NOT_FOUND', 'Phòng không còn tồn tại.');
    if (!room.secrets.has(p.playerId) || !eq(room.secrets.get(p.playerId), p.resumeToken)) throw E('BAD_TOKEN', 'Phiên cũ không còn hợp lệ, em hãy vào lại.');
    apply(room.state, { role: 'system' }, 'addPlayer', { playerId: p.playerId }, Date.now());
    bindStudent(conn, room, p.playerId);
    return { identity: { roomCode: room.state.roomCode, playerId: p.playerId, resumeToken: p.resumeToken } };
  },
  async roundContent(conn) { return learnerRound(studentRoom(conn).state); },
  async answer(conn, p) { return studentOp(conn, 'answer', { questionId: String(p.questionId ?? ''), answer: safeAnswer(p.answer), roundId: String(p.roundId ?? '') }); },
  async advance(conn, p) { return studentOp(conn, 'advance', { questionId: String(p.questionId ?? ''), roundId: String(p.roundId ?? '') }); }
};

function safeAnswer(value) {
  if (value === null) return null;
  let text; try { text = JSON.stringify(value); } catch { throw E('BAD_ANSWER', 'Câu trả lời không hợp lệ.'); }
  if (text.length > 4096 || !['string', 'object'].includes(typeof value)) throw E('BAD_ANSWER', 'Câu trả lời không hợp lệ.');
  return value;
}

function teacherRoom(conn) { if (conn.role !== 'teacher') throw E('FORBIDDEN', 'Không có quyền.'); const r = roomOf(conn); if (r.teacherWs !== conn.ws) throw E('FORBIDDEN', 'Phiên giáo viên đã chuyển sang tab khác.'); return r; }
function studentRoom(conn) { if (conn.role !== 'student' || !conn.playerId) throw E('NOT_IN_ROOM', 'Em chưa vào phòng.'); return roomOf(conn); }
function teacherOp(room, op, payload) { const r = apply(room.state, { role: 'teacher' }, op, payload, Date.now()); if (!r.ok) throw E(r.code, r.error); publish(room); return {}; }
function studentOp(conn, op, payload) {
  const room = studentRoom(conn);
  if (room.players.get(conn.playerId) !== conn.ws) throw E('REPLACED', 'Em đang mở trò chơi ở tab khác.');
  const r = apply(room.state, { role: 'student', playerId: conn.playerId }, op, payload, Date.now());
  if (!r.ok) throw E(r.code, r.error);
  if (!r.duplicate) publish(room); else conn.ws.send(JSON.stringify({ type: 'snapshot', data: studentView(room.state, conn.playerId) }));
  return {};
}
function bindTeacher(conn, room) {
  if (room.teacherWs && room.teacherWs !== conn.ws) kick(room.teacherWs);
  room.teacherWs = conn.ws; conn.roomKey = key(room.state.gameId, room.state.roomCode);
  apply(room.state, { role: 'system' }, 'presence', { role: 'teacher', connected: true });
  setImmediate(() => publish(room));
}
function bindStudent(conn, room, playerId) {
  const old = room.players.get(playerId);
  if (old && old !== conn.ws) kick(old);
  room.players.set(playerId, conn.ws); conn.roomKey = key(room.state.gameId, room.state.roomCode); conn.playerId = playerId;
  setImmediate(() => publish(room));
}
function onClose(conn) {
  const room = conn.roomKey && rooms.get(conn.roomKey);
  if (!room) return;
  if (conn.role === 'teacher' && room.teacherWs === conn.ws) { room.teacherWs = null; apply(room.state, { role: 'system' }, 'presence', { role: 'teacher', connected: false }); }
  if (conn.role === 'student' && room.players.get(conn.playerId) === conn.ws) { room.players.delete(conn.playerId); apply(room.state, { role: 'system' }, 'presence', { playerId: conn.playerId, connected: false }); }
  publish(room);
}

/* ----------------------------------------------------------- websocket */
const wss = new WebSocketServer({ noServer: true, maxPayload: LIM.payload });
wss.on('connection', (ws, req) => {
  const conn = { ws, req, role: null, gameId: null, teacherId: null, roomKey: null, playerId: null, tokens: LIM.msgPerSec, last: Date.now() };
  ws.on('message', async (data, isBinary) => {
    const now = Date.now();
    conn.tokens = Math.min(LIM.msgPerSec, conn.tokens + ((now - conn.last) / 1000) * LIM.msgPerSec); conn.last = now;
    if (conn.tokens < 1) return; conn.tokens--;
    let m; try { m = JSON.parse(isBinary ? '' : data.toString()); } catch { return ws.close(1003, 'bad json'); }
    if (!m || m.v !== ROOM_PROTOCOL || typeof m.op !== 'string' || typeof m.id !== 'string' || m.id.length > 64) return;
    const reply = (ok, body) => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'reply', id: m.id, ok, ...(ok ? { data: body } : { error: body }) }));
    const p = m.payload && typeof m.payload === 'object' ? m.payload : {};
    try {
      if (m.op === 'hello') {
        if (conn.role) throw E('BAD_OP', 'Đã chào rồi.');
        if (!['teacher', 'student'].includes(p.role) || !/^[a-z0-9-]{2,40}$/.test(p.gameId || '')) throw E('BAD_HELLO', 'Thông tin kết nối không hợp lệ.');
        if (p.role === 'teacher') {
          const who = await authenticateTeacher(req, p);
          if (!who) throw E('AUTH_REQUIRED', 'Cần đăng nhập giáo viên.');
          conn.teacherId = String(who.teacherId);
        }
        conn.role = p.role; conn.gameId = p.gameId;
        return reply(true, { protocol: ROOM_PROTOCOL });
      }
      if (!conn.role) throw E('BAD_OP', 'Cần gửi hello trước.');
      const fn = Object.hasOwn(ops, m.op) ? ops[m.op] : null;
      if (!fn) throw E('BAD_OP', 'Thao tác không hợp lệ.');
      reply(true, await fn(conn, p));
    } catch (e) {
      if (!e.code) log('error', m.op, e);
      reply(false, { code: e.code || 'SERVER_ERROR', message: e.code ? e.message : 'Lỗi máy chủ.' });
    }
  });
  ws.on('close', () => onClose(conn));
  ws.on('error', () => {});
});
setInterval(() => ws_ping(), 25_000).unref();
function ws_ping() { for (const ws of wss.clients) { if (ws.isAlive === false) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); } }
wss.on('connection', ws => { ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; }); });

setInterval(() => {
  const now = Date.now();
  for (const [k, room] of rooms) {
    if (tick(room.state, now)) publish(room);
    const empty = !room.teacherWs && room.players.size === 0;
    if ((empty && now - room.state.touchedAt > (room.state.status === 'ended' ? LIM.endedIdleMs : LIM.idleMs))) { rooms.delete(k); log('room removed', k); }
  }
}, 500).unref();

/* ----------------------------------------------------------------- http */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.woff2': 'font/woff2' };
const admin = createAdmin({
  dataDir: DATA_DIR, trustProxy: TRUST_PROXY, adminOrigin: ADMIN_ORIGIN, log,
  sources: { list: listSourceStatus, setDraft, reviewDraft, publishDraft, restoreVersion, preview: loadBankFromUrl, getBank: getBankForGame, saveDirect: saveBankDirect }
});
const send = (res, code, body, type = 'application/json; charset=utf-8', extra = {}) => { res.writeHead(code, { 'content-type': type, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', ...extra }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/healthz') return send(res, 200, { ok: true, rooms: rooms.size });
    if (await admin.handle(req, res, url)) return; // /admin, /admin.js, /admin.css, /api/admin/* — see admin-routes.js
    if (GAMES_DIR && req.method === 'GET') {
      const rel = decodeURIComponent(url.pathname).replace(/\/$/, '/index.html');
      const file = path.resolve(GAMES_DIR, '.' + rel);
      if (!file.startsWith(GAMES_DIR + path.sep)) return send(res, 403, 'Forbidden', 'text/plain');
      if (/[\\/]admin\.html$/.test(file)) return send(res, 404, 'Not found', 'text/plain');
      const st = await stat(file).catch(() => null);
      if (st?.isFile()) return send(res, 200, await readFile(file), MIME[path.extname(file)] || 'application/octet-stream', { 'content-security-policy': CSP, 'cache-control': 'no-cache' });
    }
    send(res, 404, 'Not found', 'text/plain');
  } catch (e) {
    // never echo internal error text (file paths, stack details) to the client
    if (!e.code) log('http error', e);
    if (!res.headersSent) send(res, e.code ? 400 : 500, { error: e.code ? e.message : 'Lỗi máy chủ.' });
  }
});
server.on('upgrade', (req, socket, head) => {
  const origin = req.headers.origin || '';
  const url = new URL(req.url, 'http://x');
  let sameHost = false;
  try { sameHost = Boolean(GAMES_DIR && origin && new URL(origin).host === req.headers.host); } catch {}
  if (url.pathname !== '/ws' || !(ALLOWED_ORIGINS.has(origin) || sameHost)) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return socket.destroy(); }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});
server.listen(PORT, async () => {
  log(`classroom server on :${PORT}`, GAMES_DIR ? `(serving games from ${GAMES_DIR})` : '');
  if (process.env.ADMIN_TOKEN) log('WARN ADMIN_TOKEN không còn được dùng — /admin đăng nhập bằng tài khoản + mật khẩu. Xóa biến này khỏi môi trường.');
  if (!ADMIN_ORIGIN) log('WARN chưa đặt ADMIN_ORIGIN (ví dụ https://classroom.edupia.vn) — nên đặt khi chạy thật để khóa chặt kiểm tra Origin của /admin.');
  try {
    const users = (await admin.accounts.list()).filter(u => !u.disabled);
    if (!users.length) log('WARN chưa có tài khoản quản trị. Tạo bằng: node admin-cli.js create <tên-đăng-nhập>');
  } catch (e) { log('ERROR không đọc được admins.json:', e.message); }
});

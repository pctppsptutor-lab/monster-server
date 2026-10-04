#!/usr/bin/env node
/* Account management for /admin — run on the server machine by IT (shell access is the trust boundary).
 * There is deliberately NO web "first-run setup" page: whoever reached it first would own the server.
 *
 *   node admin-cli.js create  <username>   new account + one-time password (must change at first login, valid 72 h)
 *   node admin-cli.js reset   <username>   forgot password: new one-time password, every session revoked
 *   node admin-cli.js disable <username>   block login, revoke sessions   ·   enable <username>
 *   node admin-cli.js scope <username> <game-id,grade-prefix-*|*>
 *   node admin-cli.js list                 accounts and their state (never prints hashes)
 *   node admin-cli.js verify-audit         check chain + external anchor when configured
 *   node admin-cli.js anchor-audit         write/update the external checkpoint
 *
 * Changes take effect on the running server at the next request (it re-reads admins.json). */
import os from 'node:os';
import path from 'node:path';
import { createAccountStore, generateTempPassword, hashPassword, USERNAME_RE, TEMP_PASSWORD_TTL_MS } from './admin-auth.js';
import { createAudit } from './audit.js';

try { process.loadEnvFile?.(); } catch { /* no .env file */ }
const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const accounts = createAccountStore(DATA_DIR);
const audit = createAudit(DATA_DIR, { echo: false });
let operator = 'unknown';
try { operator = os.userInfo().username; } catch { /* container without passwd entry */ }
const actor = `cli:${operator}`;

const [cmd, rawName, rawScopes] = process.argv.slice(2);
const die = (msg, code = 1) => { console.error(msg); process.exit(code); };
const username = String(rawName || '').trim().toLowerCase();
const needName = () => { if (!USERNAME_RE.test(username)) die('Tên đăng nhập: 3–32 ký tự, chữ thường a–z, số, dấu chấm hoặc gạch ngang, bắt đầu bằng chữ/số.'); };

function printTemp(pw, verb) {
  console.log(`\n${verb} tài khoản "${username}".`);
  console.log(`Mật khẩu dùng một lần: ${pw}`);
  console.log(`Hết hạn sau 72 giờ. Lần đăng nhập đầu tiên bắt buộc đổi mật khẩu.`);
  console.log('Gửi mật khẩu này qua kênh riêng (không gửi chung tin nhắn với tên đăng nhập và đường dẫn).\n');
}

async function issueTemp(createNew) {
  needName();
  const pw = generateTempPassword();
  const hash = await hashPassword(pw);
  const t = new Date();
  await accounts.update(username, (u, users) => {
    if (createNew && u) throw new Error(`Đã có tài khoản "${username}". Dùng: node admin-cli.js reset ${username}`);
    if (!createNew && !u) throw new Error(`Không có tài khoản "${username}".`);
    users[username] = {
      hash, mustChange: true, tempExpiresAt: new Date(t.getTime() + TEMP_PASSWORD_TTL_MS).toISOString(),
      disabled: false, tokenVersion: (u?.tokenVersion || 0) + 1,
      createdAt: u?.createdAt || t.toISOString(), passwordChangedAt: t.toISOString(), scopes: u?.scopes || ['*']
    };
  });
  await audit.record(createNew ? 'account.create' : 'password.reset', { actor, ip: 'local', target: username, outcome: 'success' });
  printTemp(pw, createNew ? 'Đã tạo' : 'Đã cấp lại mật khẩu cho');
}

async function setDisabled(disabled) {
  needName();
  await accounts.update(username, u => {
    if (!u) throw new Error(`Không có tài khoản "${username}".`);
    u.disabled = disabled; u.tokenVersion += 1;
  });
  await audit.record(disabled ? 'account.disable' : 'account.enable', { actor, ip: 'local', target: username, outcome: 'success' });
  console.log(disabled ? `Đã khóa "${username}" và thu hồi mọi phiên.` : `Đã mở lại "${username}".`);
}

async function list() {
  const all = await accounts.list();
  if (!all.length) return console.log('Chưa có tài khoản. Tạo: node admin-cli.js create <tên>');
  for (const u of all) {
    const state = u.disabled ? 'ĐÃ KHÓA' : u.mustChange ? `chờ đổi mật khẩu (hết hạn ${u.tempExpiresAt})` : 'hoạt động';
    console.log(`${u.username.padEnd(32)} ${state.padEnd(48)} phạm vi: ${(u.scopes || ['*']).join(',')} · đổi mật khẩu: ${u.passwordChangedAt}`);
  }
}

async function setScope() {
  needName();
  const scopes = String(rawScopes || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!scopes.length || scopes.some(s => s !== '*' && !/^[a-z0-9-]{2,40}\*?$/.test(s))) die('Phạm vi: danh sách gameId hoặc tiền tố kết thúc bằng *, ví dụ grade-3-*; dùng * cho toàn bộ.');
  await accounts.update(username, u => { if (!u) throw new Error(`Không có tài khoản "${username}".`); u.scopes = [...new Set(scopes)]; u.tokenVersion += 1; });
  await audit.record('account.scope', { actor, ip: 'local', target: username, outcome: 'success', detail: scopes.join(',') });
  console.log(`Đã đặt phạm vi cho "${username}": ${scopes.join(', ')}. Mọi phiên cũ đã bị thu hồi.`);
}

async function verify() {
  const r = await audit.verify();
  console.log(`${r.ok ? 'OK' : 'LỖI'} — ${r.message}`);
  if (!r.ok) process.exit(2);
}
async function anchor() { const r = await audit.checkpoint(); console.log(`Đã neo ${r.count} dòng vào bản đối chứng bên ngoài.`); }

const table = { create: () => issueTemp(true), reset: () => issueTemp(false), disable: () => setDisabled(true), enable: () => setDisabled(false), scope: setScope, list, 'verify-audit': verify, 'anchor-audit': anchor };
if (!Object.hasOwn(table, cmd || '')) die('Lệnh: create | reset | disable | enable <tên>, scope <tên> <game,...>, list, verify-audit, anchor-audit');
table[cmd]().catch(e => die(e.message));

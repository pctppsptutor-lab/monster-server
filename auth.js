/* Teacher authentication boundary. Replace this module with Edupia SSO in production.
 * The built-in fallback uses a separate key per teacher; it deliberately does not support
 * one shared TEACHER_KEY identity. Configure TEACHER_ACCOUNTS as JSON:
 *   {"teacher.lan":"long-random-secret","teacher.minh":"another-secret"}
 * The browser sends teacherId + teacherKey during the WebSocket hello. */
import { timingSafeEqual } from 'node:crypto';

const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
let cacheRaw = null, cache = null;
function accounts() {
  const raw = process.env.TEACHER_ACCOUNTS || '{}';
  if (raw === cacheRaw) return cache;
  let parsed; try { parsed = JSON.parse(raw); } catch { return new Map(); }
  cacheRaw = raw;
  cache = new Map(Object.entries(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {})
    .filter(([teacherId, secret]) => /^[A-Za-z0-9._@-]{3,80}$/.test(teacherId) && typeof secret === 'string' && secret.length >= 16));
  return cache;
}

export async function authenticateTeacher(req, hello) {
  const teacherId = String(hello.teacherId || '').trim();
  const key = String(hello.teacherKey || '');
  const expected = accounts().get(teacherId);
  if (expected && eq(key, expected)) return { teacherId };
  return null;
}

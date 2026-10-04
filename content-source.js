import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateBank, parseDocText, readCapped, BANK_LIMITS } from './shared/question-bank.js';
import { withLock, atomicWrite } from './file-lock.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const sourcesFile = () => path.join(path.resolve(process.env.DATA_DIR || './data'), 'sources.json');
const hosts = () => (process.env.CONTENT_HOSTS || 'docs.google.com').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const REDIRECT_HOSTS = [/^[a-z0-9-]+\.googleusercontent\.com$/];
const bad = message => Object.assign(new Error(message), { code: 'BAD_SOURCE' });
let cache = null;

function normalizeStore(raw) {
  const out = Object.create(null);
  for (const [gameId, value] of Object.entries(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {})) {
    if (!/^[a-z0-9-]{2,40}$/.test(gameId) || !value || typeof value !== 'object') continue;
    if (value.sourceUrl) out[gameId] = { draft: null, published: { sourceUrl: value.sourceUrl, version: 1, contentVersion: value.contentVersion || '', publishedAt: value.updatedAt || new Date(0).toISOString(), publishedBy: 'legacy' }, history: [], nextVersion: 2 };
    else out[gameId] = { draft: value.draft || null, published: value.published || null, history: Array.isArray(value.history) ? value.history.slice(-20) : [], nextVersion: Math.max(1, Number(value.nextVersion) || 1) };
  }
  return out;
}
async function readStore() {
  if (cache) return cache;
  try { cache = normalizeStore(JSON.parse(await readFile(sourcesFile(), 'utf8'))); }
  catch (e) { if (e.code === 'ENOENT') cache = Object.create(null); else throw e; }
  return cache;
}
async function mutate(fn) {
  const file = sourcesFile();
  return withLock(file, async () => {
    cache = null; const all = await readStore(); const result = await fn(all);
    await atomicWrite(file, JSON.stringify({ ...all }, null, 2) + '\n'); cache = all; return result;
  });
}
const withoutBank = v => v && Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'bank'));
const publicEntry = entry => entry && ({ draft: entry.draft, published: withoutBank(entry.published), history: entry.history.map(withoutBank), nextVersion: entry.nextVersion });
export async function listSourceStatus() { const all = await readStore(); return Object.fromEntries(Object.entries(all).map(([gameId, entry]) => [gameId, publicEntry(entry)])); }

export async function setDraft(gameId, sourceUrl, actor = 'unknown') {
  if (!/^[a-z0-9-]{2,40}$/.test(gameId)) throw bad('gameId không hợp lệ.');
  toFetchUrl(sourceUrl);
  return mutate(all => {
    const entry = all[gameId] || { draft: null, published: null, history: [], nextVersion: 1 };
    entry.draft = { sourceUrl, updatedAt: new Date().toISOString(), updatedBy: actor, review: null }; all[gameId] = entry; return publicEntry(entry);
  });
}
export async function reviewDraft(gameId, actor = 'unknown') {
  const all = await readStore(), entry = all[gameId]; if (!entry?.draft) throw bad('Game này chưa có bản nháp.');
  const sourceUrl = entry.draft.sourceUrl, bank = await loadBankFromUrl(sourceUrl);
  return mutate(fresh => {
    const current = fresh[gameId]; if (!current?.draft || current.draft.sourceUrl !== sourceUrl) throw bad('Bản nháp đã thay đổi trong lúc kiểm tra. Hãy kiểm tra lại.');
    current.draft.review = { ok: true, contentVersion: bank.contentVersion, title: bank.title, count: bank.questions.length, checkedAt: new Date().toISOString(), checkedBy: actor };
    return { bank, entry: publicEntry(current) };
  });
}
export async function publishDraft(gameId, actor = 'unknown') {
  const before = await readStore(), draft = before[gameId]?.draft; if (!draft) throw bad('Game này chưa có bản nháp.');
  const bank = await loadBankFromUrl(draft.sourceUrl);
  return mutate(all => {
    const entry = all[gameId]; if (!entry?.draft || entry.draft.sourceUrl !== draft.sourceUrl) throw bad('Bản nháp đã thay đổi trong lúc xuất bản. Hãy kiểm tra lại.');
    if (entry.draft.review?.contentVersion !== bank.contentVersion) throw bad('Bản nháp đã đổi sau lần kiểm tra. Hãy bấm Kiểm tra trước khi xuất bản.');
    if (entry.published) entry.history.push(entry.published);
    entry.history = entry.history.slice(-20);
    entry.published = { sourceUrl: draft.sourceUrl, version: entry.nextVersion++, contentVersion: bank.contentVersion, title: bank.title, count: bank.questions.length, publishedAt: new Date().toISOString(), publishedBy: actor, bank };
    entry.draft = null; return { published: withoutBank(entry.published), history: entry.history.map(withoutBank) };
  });
}
export async function restoreVersion(gameId, version, actor = 'unknown') {
  const all = await readStore(), entry = all[gameId], old = entry?.history.find(v => v.version === Number(version));
  if (!old) throw bad('Không tìm thấy phiên bản cần khôi phục.');
  const bank = old.bank || await loadBankFromUrl(old.sourceUrl);
  return mutate(fresh => {
    const e = fresh[gameId]; if (!e) throw bad('Game không còn tồn tại.');
    if (e.published) e.history.push(e.published); e.history = e.history.slice(-20);
    e.published = { sourceUrl: old.sourceUrl, version: e.nextVersion++, contentVersion: bank.contentVersion, title: bank.title, count: bank.questions.length, publishedAt: new Date().toISOString(), publishedBy: actor, restoredFrom: old.version, bank };
    return { published: withoutBank(e.published), history: e.history.map(withoutBank) };
  });
}

export function toFetchUrl(raw) {
  let url; try { url = new URL(String(raw)); } catch { throw bad('Link không hợp lệ.'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw bad('Chỉ nhận link HTTPS chuẩn.');
  if (!hosts().includes(url.hostname.toLowerCase())) throw bad(`Máy chủ "${url.hostname.slice(0, 80)}" chưa nằm trong CONTENT_HOSTS.`);
  if (url.hostname === 'docs.google.com') {
    const m = url.pathname.match(/^\/document\/d\/([A-Za-z0-9_-]{15,150})(?:\/|$)/); if (!m) throw bad('Cần link Google Docs dạng https://docs.google.com/document/d/MÃ/edit');
    return { url: new URL(`https://docs.google.com/document/d/${m[1]}/export?format=txt`), kind: 'doc' };
  }
  return { url, kind: 'json' };
}
async function fetchLimited(url, { timeoutMs = 10_000, maxRedirects = 3 } = {}) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    let current = url;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      let res; try { res = await fetch(current, { redirect: 'manual', signal: ctl.signal, headers: { 'cache-control': 'no-cache', 'user-agent': 'EdupiaClassroomServer/2.0' } }); } catch { throw bad(ctl.signal.aborted ? 'Hết thời gian tải nguồn (10 giây).' : 'Không kết nối được tới nguồn.'); }
      if (res.status >= 300 && res.status < 400) { let next; try { next = new URL(res.headers.get('location') || '', current); } catch { throw bad('Nguồn chuyển hướng tới địa chỉ không hợp lệ.'); } if (next.protocol !== 'https:' || !(hosts().includes(next.hostname) || REDIRECT_HOSTS.some(r => r.test(next.hostname)))) throw bad('Nguồn chuyển hướng tới địa chỉ không được phép.'); current = next; continue; }
      if (res.status === 401 || res.status === 403 || (res.status === 200 && /accounts\.google\.com/.test(res.url))) throw bad('Nguồn chưa cấp quyền đọc cho máy chủ.');
      if (!res.ok) throw bad(`Nguồn trả về lỗi HTTP ${res.status}.`); if (/text\/html/i.test(res.headers.get('content-type') || '')) throw bad('Nguồn trả về trang web, không phải dữ liệu. Kiểm tra quyền chia sẻ.');
      try { return await readCapped(res, BANK_LIMITS.maxBytes); } catch (e) { throw bad(ctl.signal.aborted ? 'Hết thời gian tải nguồn (10 giây).' : /1 MB/.test(e.message) ? e.message : 'Không đọc được dữ liệu nguồn.'); }
    }
    throw bad('Nguồn chuyển hướng quá nhiều lần.');
  } finally { clearTimeout(timer); }
}
export async function loadBankForGame(gameId) {
  const entry = (await readStore())[gameId]; if (!entry?.published?.sourceUrl) throw bad('Chủ nội dung chưa xuất bản bộ câu hỏi cho game này trong /admin.');
  return entry.published.bank ? structuredClone(entry.published.bank) : loadBankFromUrl(entry.published.sourceUrl);
}
export async function loadBankFromUrl(sourceUrl) {
  const { url, kind } = toFetchUrl(sourceUrl), text = await fetchLimited(url); let raw;
  try { if (kind === 'doc') raw = parseDocText(text); else { try { raw = JSON.parse(text); } catch { throw new Error('Nguồn không phải JSON hợp lệ.'); } } return await validateBank(raw); }
  catch (e) { throw e.code ? e : bad(e.message); }
}

export async function getBankForGame(gameId) {
  if (!/^[a-z0-9-]{2,40}$/.test(gameId)) throw bad('gameId không hợp lệ.');
  const all = await readStore();
  const entry = all[gameId];
  if (entry?.published?.bank) return structuredClone(entry.published.bank);
  if (entry?.draft?.bank) return structuredClone(entry.draft.bank);
  if (entry?.published?.sourceUrl && entry.published.sourceUrl !== 'direct://editor') {
    try { return await loadBankFromUrl(entry.published.sourceUrl); } catch {}
  }
  if (entry?.draft?.sourceUrl && entry.draft.sourceUrl !== 'direct://editor') {
    try { return await loadBankFromUrl(entry.draft.sourceUrl); } catch {}
  }
  // Try loading local content.json from scratch or sibling folder
  const candidatePaths = [
    path.resolve(HERE, '..', gameId, 'content.json'),
    path.resolve(HERE, '..', '..', gameId, 'content.json')
  ];
  for (const p of candidatePaths) {
    try {
      const text = await readFile(p, 'utf8');
      return await validateBank(JSON.parse(text));
    } catch {}
  }
  return {
    schemaVersion: 2,
    title: `Bộ câu hỏi ${gameId}`,
    contentVersion: '1.0.0',
    questions: [
      {
        id: 'q-001',
        type: 'single-choice',
        prompt: 'Nội dung câu hỏi mẫu 1',
        options: [
          { id: 'a', text: 'Lựa chọn A' },
          { id: 'b', text: 'Lựa chọn B' }
        ],
        correctOptionId: 'a',
        explanation: 'Giải thích mẫu',
        points: 10,
        timeLimitMs: 20000
      }
    ]
  };
}

export async function saveBankDirect(gameId, rawBank, { publish = false, actor = 'unknown' } = {}) {
  if (!/^[a-z0-9-]{2,40}$/.test(gameId)) throw bad('gameId không hợp lệ.');
  const validated = await validateBank(rawBank);
  return mutate(all => {
    const entry = all[gameId] || { draft: null, published: null, history: [], nextVersion: 1 };
    if (publish) {
      if (entry.published) entry.history.push(entry.published);
      entry.history = entry.history.slice(-20);
      entry.published = {
        sourceUrl: 'direct://editor',
        version: entry.nextVersion++,
        contentVersion: validated.contentVersion,
        title: validated.title,
        count: validated.questions.length,
        publishedAt: new Date().toISOString(),
        publishedBy: actor,
        bank: validated
      };
      entry.draft = null;
    } else {
      entry.draft = {
        sourceUrl: 'direct://editor',
        updatedAt: new Date().toISOString(),
        updatedBy: actor,
        bank: validated,
        review: {
          ok: true,
          contentVersion: validated.contentVersion,
          title: validated.title,
          count: validated.questions.length,
          checkedAt: new Date().toISOString(),
          checkedBy: actor
        }
      };
    }
    all[gameId] = entry;
    return { bank: validated, entry: publicEntry(entry) };
  });
}


/* Classroom Question Bank 2.0.0 — copy unchanged. Browser + Node compatible. */
export const BANK_LIMITS = Object.freeze({ maxBytes: 1_000_000, maxQuestions: 100, promptMax: 600, optionMax: 240, explanationMax: 400, titleMax: 100, minOptions: 2, maxOptions: 6, maxPoints: 100, maxTimeLimitMs: 300_000, maxItems: 8, answerMax: 240 });
export const SUPPORTED_TYPES = Object.freeze(['single-choice', 'listening-choice', 'image-choice', 'ordering', 'matching', 'fill-blank']);

async function sha256Hex(text) {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(n => n.toString(16).padStart(2, '0')).join('');
}
const str = v => (typeof v === 'string' ? v.normalize('NFC').trim() : '');
const id = v => /^[A-Za-z0-9_-]{1,40}$/.test(str(v)) ? str(v) : '';

function media(raw, fail, requiredKind = '') {
  if (raw == null) { if (requiredKind) fail(`dạng này cần media.kind="${requiredKind}".`); return undefined; }
  const src = str(raw?.src), kind = str(raw?.kind);
  if (!['image', 'audio'].includes(kind)) fail('media.kind phải là image hoặc audio.');
  if (requiredKind && kind !== requiredKind) fail(`dạng này cần media.kind="${requiredKind}".`);
  if (!/^(assets\/[A-Za-z0-9_./-]+|https:\/\/[^\s"'<>]+)$/.test(src) || src.includes('..')) fail('media.src phải là assets/... hoặc https://');
  return { kind, src, alt: str(raw.alt).slice(0, 200) };
}

function optionList(raw, fail) {
  if (!Array.isArray(raw) || raw.length < BANK_LIMITS.minOptions || raw.length > BANK_LIMITS.maxOptions) fail(`cần ${BANK_LIMITS.minOptions}–${BANK_LIMITS.maxOptions} lựa chọn.`);
  const seen = new Set();
  return raw.map(o => {
    const oid = id(o?.id), text = str(o?.text);
    if (!oid || seen.has(oid)) fail('id lựa chọn trống, sai ký tự hoặc bị trùng.');
    if (!text || text.length > BANK_LIMITS.optionMax) fail(`lựa chọn cần 1–${BANK_LIMITS.optionMax} ký tự.`);
    seen.add(oid); return { id: oid, text };
  });
}

function itemList(raw, fail, label) {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > BANK_LIMITS.maxItems) fail(`${label} cần 2–${BANK_LIMITS.maxItems} mục.`);
  const seen = new Set();
  return raw.map(o => {
    const oid = id(o?.id), text = str(o?.text);
    if (!oid || seen.has(oid)) fail(`${label}: id trống, sai ký tự hoặc bị trùng.`);
    if (!text || text.length > BANK_LIMITS.optionMax) fail(`${label}: nội dung cần 1–${BANK_LIMITS.optionMax} ký tự.`);
    seen.add(oid); return { id: oid, text, ...(o?.media ? { media: media(o.media, fail) } : {}) };
  });
}

/** Throws a precise Vietnamese error; never drops a broken question silently. */
export async function validateBank(raw, { fetchedAt = Date.now() } = {}) {
  if (!raw || typeof raw !== 'object') throw new Error('Dữ liệu không phải JSON object.');
  if (raw.schemaVersion !== 1 && raw.schemaVersion !== 2) throw new Error('schemaVersion phải là 1 hoặc 2.');
  if (!Array.isArray(raw.questions) || !raw.questions.length) throw new Error('Chưa có câu hỏi nào.');
  if (raw.questions.length > BANK_LIMITS.maxQuestions) throw new Error(`Tối đa ${BANK_LIMITS.maxQuestions} câu hỏi.`);
  const ids = new Set();
  const questions = raw.questions.map((q, i) => {
    const fail = m => { throw new Error(`Câu ${i + 1}: ${m}`); };
    if (!q || typeof q !== 'object') fail('không đúng cấu trúc.');
    const qid = id(q.id);
    if (!qid) fail('id trống hoặc sai ký tự.');
    if (ids.has(qid)) fail(`trùng mã "${qid}".`);
    ids.add(qid);
    if (!SUPPORTED_TYPES.includes(q.type)) fail(`dạng "${String(q.type).slice(0, 30)}" chưa được hỗ trợ.`);
    const prompt = str(q.prompt);
    if (!prompt || prompt.length > BANK_LIMITS.promptMax) fail(`nội dung câu hỏi cần 1–${BANK_LIMITS.promptMax} ký tự.`);
    const points = q.points ?? 10;
    if (!Number.isInteger(points) || points < 0 || points > BANK_LIMITS.maxPoints) fail(`điểm phải là số nguyên 0–${BANK_LIMITS.maxPoints}.`);
    const out = { id: qid, type: q.type, prompt, points };

    if (['single-choice', 'listening-choice', 'image-choice'].includes(q.type)) {
      out.options = optionList(q.options, fail);
      const correct = id(q.correctOptionId);
      if (!correct) fail('thiếu đáp án đúng.');
      if (!out.options.some(o => o.id === correct)) fail('đáp án đúng không khớp lựa chọn nào.');
      out.correctOptionId = correct;
      const required = q.type === 'listening-choice' ? 'audio' : q.type === 'image-choice' ? 'image' : '';
      const m = media(q.media, fail, required); if (m) out.media = m;
    } else if (q.type === 'ordering') {
      out.items = itemList(q.items, fail, 'items');
      if (!Array.isArray(q.correctOrder)) fail('thiếu correctOrder.');
      out.correctOrder = q.correctOrder.map(id);
      const want = new Set(out.items.map(x => x.id));
      if (out.correctOrder.length !== want.size || new Set(out.correctOrder).size !== want.size || out.correctOrder.some(x => !want.has(x))) fail('correctOrder phải chứa đúng mỗi id trong items một lần.');
    } else if (q.type === 'matching') {
      out.leftItems = itemList(q.leftItems, fail, 'leftItems');
      out.rightItems = itemList(q.rightItems, fail, 'rightItems');
      const left = new Set(out.leftItems.map(x => x.id)), right = new Set(out.rightItems.map(x => x.id));
      if (!q.correctMatches || typeof q.correctMatches !== 'object' || Array.isArray(q.correctMatches)) fail('thiếu correctMatches.');
      out.correctMatches = {};
      const usedRight = new Set();
      for (const lid of left) {
        const rid = id(q.correctMatches[lid]);
        if (!right.has(rid)) fail(`correctMatches thiếu hoặc sai cho "${lid}".`);
        if (usedRight.has(rid)) fail(`correctMatches dùng lặp mục phải "${rid}".`);
        usedRight.add(rid);
        out.correctMatches[lid] = rid;
      }
    } else if (q.type === 'fill-blank') {
      if (!Array.isArray(q.acceptedAnswers) || !q.acceptedAnswers.length || q.acceptedAnswers.length > 20) fail('acceptedAnswers cần 1–20 đáp án.');
      out.acceptedAnswers = [...new Set(q.acceptedAnswers.map(str))];
      if (!out.acceptedAnswers.length || out.acceptedAnswers.some(a => !a || a.length > BANK_LIMITS.answerMax)) fail(`mỗi đáp án cần 1–${BANK_LIMITS.answerMax} ký tự.`);
      out.normalization = { caseSensitive: q.normalization?.caseSensitive === true, collapseWhitespace: q.normalization?.collapseWhitespace !== false };
      const m = media(q.media, fail); if (m) out.media = m;
    }
    const explanation = str(q.explanation);
    if (explanation) { if (explanation.length > BANK_LIMITS.explanationMax) fail('giải thích quá dài.'); out.explanation = explanation; }
    if (q.timeLimitMs != null) {
      if (!Number.isInteger(q.timeLimitMs) || q.timeLimitMs < 3000 || q.timeLimitMs > BANK_LIMITS.maxTimeLimitMs) fail('timeLimitMs phải từ 3000 đến 300000.');
      out.timeLimitMs = q.timeLimitMs;
    }
    return out;
  });
  const title = str(raw.title).slice(0, BANK_LIMITS.titleMax) || 'Bộ câu hỏi';
  const contentVersion = (await sha256Hex(JSON.stringify({ title, questions }))).slice(0, 12);
  return { schemaVersion: 2, title, questions, contentVersion, fetchedAt };
}

/** Google Docs plain text stays intentionally simple: single-choice only. Use JSON for other types. */
export function parseDocText(text) {
  const questions = []; let title = '', cur = null;
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
  lines.forEach((rawLine, n) => {
    const line = rawLine.trim(); if (!line) return;
    const where = `Dòng ${n + 1}`; let m;
    if (!questions.length && !title && (m = line.match(/^#\s*(.+)$/))) { title = m[1]; return; }
    if ((m = line.match(/^(\d{1,3})\s*[.)]\s*(.+)$/))) { cur = { id: 'q-' + m[1].padStart(3, '0'), type: 'single-choice', prompt: m[2], options: [], points: 10 }; questions.push(cur); return; }
    if (!cur) throw new Error(`${where}: cần bắt đầu bằng "1. Nội dung câu hỏi".`);
    if ((m = line.match(/^([a-fA-F])\s*[.)]\s*(.+)$/))) {
      const oid = m[1].toLowerCase(), marked = /✅|\(đúng\)|\*$/i.test(m[2]);
      if (marked && cur.correctOptionId) throw new Error(`${where}: câu ${cur.id} có hơn một đáp án đúng.`);
      cur.options.push({ id: oid, text: m[2].replace(/✅|\(đúng\)|\*$/gi, '').trim() });
      if (marked) cur.correctOptionId = oid; return;
    }
    if ((m = line.match(/^Giải thích\s*:\s*(.+)$/i))) { cur.explanation = m[1]; return; }
    if ((m = line.match(/^Thời gian\s*:\s*(\d+)\s*$/i))) { cur.timeLimitMs = Number(m[1]) * 1000; return; }
    if ((m = line.match(/^Điểm\s*:\s*(\d+)\s*$/i))) { cur.points = Number(m[1]); return; }
    throw new Error(`${where}: không nhận ra định dạng.`);
  });
  return { schemaVersion: 2, title, questions };
}

export async function readCapped(response, maxBytes = BANK_LIMITS.maxBytes) {
  const len = Number(response.headers.get('content-length') || 0);
  if (len > maxBytes) throw new Error('Nguồn lớn hơn 1 MB.');
  if (!response.body?.getReader) { const t = await response.text(); if (new TextEncoder().encode(t).length > maxBytes) throw new Error('Nguồn lớn hơn 1 MB.'); return t; }
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > maxBytes) { await reader.cancel(); throw new Error('Nguồn lớn hơn 1 MB.'); } chunks.push(value); }
  const all = new Uint8Array(size); let off = 0; for (const c of chunks) { all.set(c, off); off += c.byteLength; }
  return new TextDecoder().decode(all);
}

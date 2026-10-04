/* Classroom Room Core 2.0.0 — copy unchanged. Pure logic, no I/O. */
export const ROOM_PROTOCOL = 2;
export const LIMITS = Object.freeze({ maxPlayers: 4, nameMax: 24, graceMs: 1500, answerBytes: 4096 });
const clone = v => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));

export function cleanName(raw) {
  const s = String(raw ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f<>]/g, '').replace(/\s+/g, ' ').trim();
  return [...s].slice(0, LIMITS.nameMax).join('');
}

export function createRoomState({ roomCode, gameId, pace = 'self', maxPlayers = LIMITS.maxPlayers, now, lateJoin = 'current', revealAnswers = 'immediate' }) {
  if (!['self', 'teacher'].includes(pace)) throw new Error('pace must be self|teacher');
  if (!['current', 'next-round'].includes(lateJoin)) throw new Error('lateJoin must be current|next-round');
  if (!['immediate', 'all-submitted'].includes(revealAnswers)) throw new Error('revealAnswers must be immediate|all-submitted');
  if (pace === 'self' && revealAnswers === 'all-submitted') revealAnswers = 'immediate';
  return {
    v: ROOM_PROTOCOL, roomCode, gameId, pace, maxPlayers: Math.min(Math.max(1, maxPlayers | 0), 40),
    createdAt: now, touchedAt: now, revision: 0, status: 'lobby', teacherConnected: true,
    settings: { locked: false, lateJoin, revealAnswers }, paused: false,
    content: { status: 'empty', bank: null, error: null, loadedAt: null }, round: null, players: []
  };
}

function freshStats(p) { Object.assign(p, { score: 0, index: 0, correct: 0, incorrect: 0, timeout: 0, results: {}, pending: null, servedAt: null, waiting: false }); }
export function ranks(players) {
  const sorted = [...players].sort((a, b) => b.score - a.score || a.playerId.localeCompare(b.playerId));
  return sorted.map(p => ({ playerId: p.playerId, name: p.name, score: p.score, rank: sorted.findIndex(x => x.score === p.score) + 1 }));
}
const qs = s => s.round?.content.questions || [];
const currentIndex = (s, p) => (s.pace === 'teacher' ? s.round.sharedIndex : p.index);
const servedAt = (s, p) => (s.pace === 'teacher' ? s.round.sharedServedAt : p.servedAt);
const activePlayers = s => s.players.filter(p => !p.waiting);
function finishIfDone(s) { if (s.pace === 'self' && activePlayers(s).length && activePlayers(s).every(p => p.index >= qs(s).length)) s.status = 'ended'; }

function normalizedText(q, value) {
  let s = String(value ?? '').normalize('NFC').trim();
  if (q.normalization?.collapseWhitespace !== false) s = s.replace(/\s+/g, ' ');
  if (!q.normalization?.caseSensitive) s = s.toLocaleLowerCase('vi');
  return s;
}
function validAnswer(q, answer) {
  if (['single-choice', 'listening-choice', 'image-choice'].includes(q.type)) return typeof answer === 'string' && q.options.some(o => o.id === answer);
  if (q.type === 'ordering') return Array.isArray(answer) && answer.length === q.items.length && new Set(answer).size === answer.length && answer.every(x => typeof x === 'string' && q.items.some(i => i.id === x));
  if (q.type === 'matching') {
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return false;
    const left = q.leftItems.map(x => x.id), right = new Set(q.rightItems.map(x => x.id));
    return Object.keys(answer).length === left.length && left.every(x => typeof answer[x] === 'string' && right.has(answer[x]));
  }
  return q.type === 'fill-blank' && typeof answer === 'string' && [...answer].length <= 240;
}
function isCorrect(q, answer) {
  if (['single-choice', 'listening-choice', 'image-choice'].includes(q.type)) return answer === q.correctOptionId;
  if (q.type === 'ordering') return q.correctOrder.every((x, i) => answer[i] === x);
  if (q.type === 'matching') return Object.keys(q.correctMatches).every(k => answer[k] === q.correctMatches[k]);
  return q.acceptedAnswers.some(x => normalizedText(q, x) === normalizedText(q, answer));
}
function answerKey(q) {
  if (['single-choice', 'listening-choice', 'image-choice'].includes(q.type)) {
    const opt = q.options.find(o => o.id === q.correctOptionId);
    return { correctOptionId: q.correctOptionId, correctAnswer: q.correctOptionId, correctText: opt?.text || '' };
  }
  if (q.type === 'ordering') return { correctAnswer: clone(q.correctOrder), correctText: q.correctOrder.map(x => q.items.find(i => i.id === x)?.text || x).join(' → ') };
  if (q.type === 'matching') return { correctAnswer: clone(q.correctMatches), correctText: Object.entries(q.correctMatches).map(([l, r]) => `${q.leftItems.find(i => i.id === l)?.text || l} – ${q.rightItems.find(i => i.id === r)?.text || r}`).join('; ') };
  return { correctAnswer: q.acceptedAnswers[0], correctText: q.acceptedAnswers[0] };
}

function record(s, p, q, answer, now, kind) {
  const right = kind === 'answer' && isCorrect(q, answer);
  const delta = right ? q.points : 0;
  p.score += delta;
  if (kind === 'timeout') p.timeout++; else if (right) p.correct++; else p.incorrect++;
  const result = { questionId: q.id, answer: kind === 'answer' ? clone(answer) : null, status: kind === 'timeout' ? 'timeout' : right ? 'correct' : 'incorrect', isCorrect: right, ...answerKey(q), explanation: q.explanation || '', timeMs: Math.max(0, Math.min(now - (servedAt(s, p) ?? now), 86_400_000)), score: p.score, delta };
  p.results[q.id] = result; p.pending = result; return result;
}

function revealReady(s, q) {
  if (!q || s.settings.revealAnswers === 'immediate' || s.status === 'ended' || s.pace !== 'teacher') return true;
  const eligible = activePlayers(s);
  return eligible.length > 0 && eligible.every(p => Boolean(p.results[q.id]));
}

/** apply(state, authenticated actor, op, payload, now) mutates state. */
export function apply(s, actor, op, payload = {}, now = Date.now()) {
  const fail = (code, error) => ({ ok: false, code, error });
  const done = extra => { s.revision++; s.touchedAt = now; return { ok: true, ...extra }; };
  const role = actor?.role;

  if (role === 'system') {
    if (op === 'contentLoaded') { s.content = { status: 'ok', bank: clone(payload.bank), error: null, loadedAt: now }; return done(); }
    if (op === 'contentError') { s.content = { ...s.content, status: s.content.bank ? 'stale' : 'error', error: String(payload.message || 'Lỗi nguồn').slice(0, 300) }; return done(); }
    if (op === 'presence') {
      if (payload.role === 'teacher') s.teacherConnected = !!payload.connected;
      else { const p = s.players.find(x => x.playerId === payload.playerId); if (p) p.connected = !!payload.connected; }
      return done();
    }
    if (op === 'addPlayer') {
      const existing = s.players.find(p => p.playerId === payload.playerId);
      if (existing) { existing.connected = true; return done(); }
      if (s.settings.locked) return fail('ROOM_LOCKED', 'Giáo viên đã khóa phòng.');
      if (s.status === 'ended') return fail('ROUND_ENDED', 'Vòng chơi đã kết thúc.');
      if (s.players.length >= s.maxPlayers) return fail('ROOM_FULL', `Phòng đã đủ ${s.maxPlayers} bạn.`);
      const name = cleanName(payload.name); if (!name) return fail('BAD_NAME', 'Em hãy nhập tên (tối đa 24 ký tự).');
      const p = { playerId: payload.playerId, name, joinedAt: now, connected: true }; freshStats(p);
      if (s.status === 'playing') {
        p.waiting = s.settings.lateJoin === 'next-round';
        if (!p.waiting) { p.index = s.pace === 'teacher' ? s.round.sharedIndex : 0; p.servedAt = now; }
      }
      s.players.push(p); return done();
    }
    return fail('BAD_OP', 'Thao tác hệ thống không hợp lệ.');
  }

  if (role === 'teacher') {
    if (op === 'setLocked') { s.settings.locked = payload.locked === true; return done(); }
    if (op === 'setLateJoin') { if (!['current', 'next-round'].includes(payload.value)) return fail('BAD_SETTING', 'Quy định vào muộn không hợp lệ.'); s.settings.lateJoin = payload.value; return done(); }
    if (op === 'setRevealMode') { if (!['immediate', 'all-submitted'].includes(payload.value) || (s.pace === 'self' && payload.value !== 'immediate')) return fail('BAD_SETTING', 'Chế độ công bố đáp án không phù hợp.'); s.settings.revealAnswers = payload.value; return done(); }
    if (op === 'kick') { const i = s.players.findIndex(p => p.playerId === payload.playerId); if (i < 0) return fail('NOT_IN_ROOM', 'Không tìm thấy học sinh.'); s.players.splice(i, 1); return done({ kickedPlayerId: payload.playerId }); }
    if (op === 'start') {
      if (s.status === 'playing') return fail('ALREADY_PLAYING', 'Vòng đang chạy.');
      if (!s.players.length) return fail('NO_PLAYERS', 'Cần ít nhất 1 học sinh trong phòng.');
      if (!s.content.bank) return fail('NO_CONTENT', s.content.error || 'Chưa tải được bộ câu hỏi.');
      if (s.content.status !== 'ok' && payload.allowStale !== true) return fail('STALE_CONTENT', 'Nguồn câu hỏi đang lỗi. Giáo viên có thể chọn rõ ràng dùng bản đã tải trước đó.');
      s.round = { roundId: payload.roundId, startedAt: now, content: clone(s.content.bank), sharedIndex: 0, sharedServedAt: now, usedStale: s.content.status !== 'ok', pausedAt: null };
      s.players.forEach(p => { freshStats(p); p.servedAt = now; }); s.status = 'playing'; s.paused = false; return done();
    }
    if (op === 'pause') { if (s.status !== 'playing' || s.paused) return fail('BAD_STATE', 'Vòng không chạy hoặc đã tạm dừng.'); s.paused = true; s.round.pausedAt = now; return done(); }
    if (op === 'resume') {
      if (s.status !== 'playing' || !s.paused) return fail('BAD_STATE', 'Vòng không ở trạng thái tạm dừng.');
      const gap = Math.max(0, now - s.round.pausedAt); s.round.sharedServedAt += gap; s.players.forEach(p => { if (p.servedAt != null) p.servedAt += gap; }); s.round.pausedAt = null; s.paused = false; return done();
    }
    if (op === 'next') {
      if (s.status !== 'playing' || s.pace !== 'teacher') return fail('BAD_STATE', 'Chỉ dùng khi giáo viên điều khiển nhịp câu hỏi.');
      if (s.paused) return fail('PAUSED', 'Hãy tiếp tục trước khi chuyển câu.');
      const q = qs(s)[s.round.sharedIndex];
      if (q) activePlayers(s).forEach(p => { if (!p.results[q.id]) record(s, p, q, null, now, 'timeout'); });
      s.round.sharedIndex++; s.round.sharedServedAt = now; s.players.forEach(p => { p.pending = null; p.index = s.round.sharedIndex; });
      if (s.round.sharedIndex >= qs(s).length) s.status = 'ended'; return done();
    }
    if (op === 'end') { if (s.status !== 'playing') return fail('BAD_STATE', 'Không có vòng nào đang chạy.'); s.status = 'ended'; s.paused = false; return done(); }
    if (op === 'restart') { if (s.status === 'playing') return fail('BAD_STATE', 'Hãy kết thúc vòng hiện tại trước.'); s.status = 'lobby'; s.round = null; s.paused = false; s.settings.locked = false; s.players.forEach(freshStats); return done(); }
    return fail('BAD_OP', 'Thao tác không hợp lệ.');
  }

  if (role === 'student') {
    const p = s.players.find(x => x.playerId === actor.playerId); if (!p) return fail('NOT_IN_ROOM', 'Em chưa ở trong phòng.');
    if (p.waiting) return fail('WAIT_NEXT_ROUND', 'Em sẽ tham gia từ vòng tiếp theo.');
    if (s.status !== 'playing') return fail('NOT_PLAYING', 'Vòng chơi chưa bắt đầu hoặc đã kết thúc.');
    if (s.paused) return fail('PAUSED', 'Giáo viên đang tạm dừng trò chơi.');
    if (payload.roundId !== s.round.roundId) return fail('OLD_ROUND', 'Sự kiện thuộc vòng cũ.');
    const idx = currentIndex(s, p), q = qs(s)[idx]; if (!q || q.id !== payload.questionId) return fail('WRONG_QUESTION', 'Câu hỏi không còn hiện hành.');
    if (op === 'answer') {
      if (p.results[q.id]) return { ok: true, duplicate: true };
      if (payload.answer !== null && !validAnswer(q, payload.answer)) return fail('BAD_ANSWER', 'Câu trả lời không hợp lệ.');
      const late = q.timeLimitMs && now > servedAt(s, p) + q.timeLimitMs + LIMITS.graceMs;
      record(s, p, q, payload.answer, now, payload.answer === null || late ? 'timeout' : 'answer'); return done();
    }
    if (op === 'advance') {
      if (s.pace === 'teacher') return fail('BAD_OP', 'Giáo viên điều khiển chuyển câu.');
      if (!p.results[q.id]) return fail('NOT_ANSWERED', 'Chưa có kết quả cho câu này.');
      p.index++; p.pending = null; p.servedAt = now; finishIfDone(s); return done();
    }
    return fail('BAD_OP', 'Thao tác không hợp lệ.');
  }
  return fail('FORBIDDEN', 'Không có quyền.');
}

export function tick(s, now = Date.now()) {
  if (s.status !== 'playing' || s.paused) return false;
  let changed = false;
  for (const p of activePlayers(s)) {
    const q = qs(s)[currentIndex(s, p)];
    if (q?.timeLimitMs && !p.results[q.id] && now > servedAt(s, p) + q.timeLimitMs + LIMITS.graceMs) { record(s, p, q, null, now, 'timeout'); changed = true; }
  }
  if (changed) { s.revision++; s.touchedAt = now; } return changed;
}

function hiddenPending(s, p) { return p.pending && !revealReady(s, qs(s).find(x => x.id === p.pending.questionId)) ? p.pending : null; }
function safeStats(s, p) {
  const hidden = hiddenPending(s, p);
  return { score: p.score - (hidden?.delta || 0), correct: p.correct - (hidden?.status === 'correct' ? 1 : 0), incorrect: p.incorrect - (hidden?.status === 'incorrect' ? 1 : 0), timeout: p.timeout - (hidden?.status === 'timeout' ? 1 : 0) };
}
function publicPlayers(s, learnerSafe = false) {
  const total = qs(s).length;
  return s.players.map(p => ({ playerId: p.playerId, name: p.name, connected: p.connected !== false, waiting: !!p.waiting, ...(learnerSafe ? safeStats(s, p) : { score: p.score, correct: p.correct, incorrect: p.incorrect, timeout: p.timeout }), answered: Object.keys(p.results).length, total }));
}
const learnerQuestion = q => {
  if (!q) return q;
  const base = { id: q.id, type: q.type, prompt: q.prompt, ...(q.media ? { media: q.media } : {}), ...(q.timeLimitMs ? { timeLimitMs: q.timeLimitMs } : {}) };
  if (q.options) base.options = q.options.map(o => ({ id: o.id, text: o.text }));
  if (q.items) base.items = clone(q.items);
  if (q.leftItems) { base.leftItems = clone(q.leftItems); base.rightItems = clone(q.rightItems); }
  if (q.type === 'fill-blank') base.normalization = clone(q.normalization);
  return base;
};
const contentInfo = s => ({ status: s.content.status, error: s.content.error, loadedAt: s.content.loadedAt, title: s.content.bank?.title || '', contentVersion: s.content.bank?.contentVersion || '', fetchedAt: s.content.bank?.fetchedAt || null, count: s.content.bank?.questions.length || 0 });
export function learnerRound(s) { return s.round && { roundId: s.round.roundId, title: s.round.content.title, contentVersion: s.round.content.contentVersion, questions: qs(s).map(learnerQuestion) }; }

export function teacherView(s) {
  const total = qs(s).length;
  return { role: 'teacher', v: s.v, roomCode: s.roomCode, gameId: s.gameId, pace: s.pace, revision: s.revision, status: s.status, paused: s.paused, settings: clone(s.settings), maxPlayers: s.maxPlayers,
    content: contentInfo(s), preview: s.content.bank ? clone(s.content.bank.questions) : [],
    round: s.round && { roundId: s.round.roundId, title: s.round.content.title, contentVersion: s.round.content.contentVersion, usedStale: s.round.usedStale, total, sharedIndex: s.round.sharedIndex, questions: clone(s.round.content.questions) },
    players: s.players.map(p => ({ ...publicPlayers(s).find(x => x.playerId === p.playerId), currentIndex: s.round ? currentIndex(s, p) : 0, unanswered: Math.max(0, total - Object.keys(p.results).length), results: clone(p.results) })), leaderboard: ranks(s.players) };
}

export function studentView(s, playerId) {
  const p = s.players.find(x => x.playerId === playerId), idx = p && s.round ? currentIndex(s, p) : 0;
  const q = s.status === 'playing' && p && !p.waiting ? qs(s)[idx] : null;
  const reveal = p?.pending && revealReady(s, qs(s).find(x => x.id === p.pending.questionId));
  const visible = publicPlayers(s, true), mine = visible.find(x => x.playerId === playerId);
  return { role: 'student', v: s.v, roomCode: s.roomCode, gameId: s.gameId, pace: s.pace, revision: s.revision, status: s.status, paused: s.paused, teacherConnected: s.teacherConnected,
    roundId: s.round?.roundId || null, title: s.round?.content.title || s.content.bank?.title || '', total: qs(s).length,
    players: visible.map(({ correct, incorrect, timeout, ...rest }) => rest), leaderboard: ranks(visible),
    me: p ? { playerId: p.playerId, name: p.name, score: mine.score, index: idx, waiting: !!p.waiting, waitingForReveal: Boolean(p.pending && !reveal), correct: mine.correct, incorrect: mine.incorrect, timeout: mine.timeout, lastResult: reveal ? clone(p.pending) : null } : null,
    question: q && !p.results[q.id] ? { ...learnerQuestion(q), index: idx, servedAt: servedAt(s, p) } : q ? { ...learnerQuestion(q), index: idx, servedAt: servedAt(s, p), answered: true } : null };
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoomState, apply, tick, studentView, teacherView } from '../shared/room-core.js';

const q = (id, correct = 'a') => ({ id, type: 'single-choice', prompt: id, options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], correctOptionId: correct, points: 10, timeLimitMs: 10_000 });
const bank = (name, questions = [q('q1'), q('q2', 'b')]) => ({ schemaVersion: 2, title: name, contentVersion: name, fetchedAt: 0, questions });
function setup({ revealAnswers = 'immediate', lateJoin = 'current' } = {}) {
  const s = createRoomState({ roomCode: 'ABC123', gameId: 'test-game', pace: 'teacher', maxPlayers: 4, revealAnswers, lateJoin, now: 0 });
  apply(s, { role: 'system' }, 'contentLoaded', { bank: bank('v1') }, 1);
  for (let i = 1; i <= 4; i++) assert.equal(apply(s, { role: 'system' }, 'addPlayer', { playerId: `p${i}`, name: `Em ${i}` }, 2 + i).ok, true);
  assert.equal(apply(s, { role: 'teacher' }, 'start', { roundId: 'r1' }, 10).ok, true); return s;
}
const answer = (s, playerId, value, at = 100) => apply(s, { role: 'student', playerId }, 'answer', { roundId: s.round.roundId, questionId: s.round.content.questions[s.round.sharedIndex].id, answer: value }, at);

test('one teacher and four students answer; unreplied learners never receive answer keys', () => {
  const s = setup({ revealAnswers: 'all-submitted' });
  assert.equal(answer(s, 'p1', 'a').ok, true);
  const first = studentView(s, 'p1'), second = studentView(s, 'p2');
  assert.equal(first.me.lastResult, null); assert.equal(first.me.waitingForReveal, true);
  assert.equal(first.me.score, 0); assert.equal(first.leaderboard.find(x => x.playerId === 'p1').score, 0);
  assert.doesNotMatch(JSON.stringify(second), /correctOptionId|correctAnswer|acceptedAnswers/);
  for (const id of ['p2', 'p3', 'p4']) answer(s, id, id === 'p4' ? 'b' : 'a');
  assert.equal(studentView(s, 'p1').me.lastResult.correctOptionId, 'a');
  assert.deepEqual(teacherView(s).players.map(p => p.answered), [1, 1, 1, 1]);
});

test('double click and retry after reconnect score only once', () => {
  const s = setup();
  assert.equal(answer(s, 'p1', 'a').ok, true); const score = studentView(s, 'p1').me.score;
  assert.equal(answer(s, 'p1', 'a').duplicate, true);
  apply(s, { role: 'system' }, 'presence', { playerId: 'p1', connected: false }, 120);
  apply(s, { role: 'system' }, 'addPlayer', { playerId: 'p1' }, 130); // resume/new tab, same identity
  assert.equal(answer(s, 'p1', 'a').duplicate, true); assert.equal(studentView(s, 'p1').me.score, score);
  assert.equal(s.players.filter(p => p.playerId === 'p1').length, 1);
});

test('teacher changing question while an answer is in flight is deterministic', () => {
  const s = setup();
  assert.equal(answer(s, 'p1', 'a', 100).ok, true);
  assert.equal(apply(s, { role: 'teacher' }, 'next', {}, 101).ok, true);
  const late = apply(s, { role: 'student', playerId: 'p2' }, 'answer', { roundId: 'r1', questionId: 'q1', answer: 'a' }, 102);
  assert.equal(late.code, 'WRONG_QUESTION');
  assert.equal(studentView(s, 'p1').me.score, 10); assert.equal(studentView(s, 'p2').me.score, 0);
  assert.equal(teacherView(s).players.find(p => p.playerId === 'p2').results.q1.status, 'timeout');
});

test('source failure/change during a round cannot alter its snapshot', () => {
  const s = setup();
  apply(s, { role: 'system' }, 'contentError', { message: 'nguồn lỗi' }, 20);
  apply(s, { role: 'system' }, 'contentLoaded', { bank: bank('v2', [q('new-q', 'b')]) }, 30);
  assert.equal(s.round.content.contentVersion, 'v1'); assert.equal(s.round.content.questions[0].id, 'q1');
  apply(s, { role: 'teacher' }, 'end', {}, 40); apply(s, { role: 'teacher' }, 'restart', {}, 41); apply(s, { role: 'teacher' }, 'start', { roundId: 'r2' }, 42);
  assert.equal(s.round.content.contentVersion, 'v2'); assert.equal(s.round.content.questions[0].id, 'new-q');
});

test('pause preserves remaining time; lock, late join and kick enforce teacher control', () => {
  const s = setup();
  apply(s, { role: 'teacher' }, 'pause', {}, 1_000); assert.equal(tick(s, 50_000), false);
  apply(s, { role: 'teacher' }, 'resume', {}, 51_000); assert.equal(s.round.sharedServedAt, 50_010); assert.equal(tick(s, 55_000), false);
  apply(s, { role: 'teacher' }, 'setLocked', { locked: true }, 55_100);
  assert.equal(apply(s, { role: 'system' }, 'addPlayer', { playerId: 'late', name: 'Late' }, 55_101).code, 'ROOM_LOCKED');
  assert.equal(apply(s, { role: 'teacher' }, 'kick', { playerId: 'p4' }, 55_200).ok, true); assert.equal(s.players.length, 3);
  apply(s, { role: 'teacher' }, 'setLocked', { locked: false }, 55_300); apply(s, { role: 'teacher' }, 'setLateJoin', { value: 'next-round' }, 55_301);
  assert.equal(apply(s, { role: 'system' }, 'addPlayer', { playerId: 'late', name: 'Late' }, 55_302).ok, true); assert.equal(studentView(s, 'late').me.waiting, true); assert.equal(studentView(s, 'late').question, null);
});

test('server grades ordering, matching and fill-blank with declared normalization', () => {
  const questions = [
    { id: 'order', type: 'ordering', prompt: 'Order', items: [{ id: 'a', text: 'I' }, { id: 'b', text: 'am' }], correctOrder: ['a', 'b'], points: 10 },
    { id: 'match', type: 'matching', prompt: 'Match', leftItems: [{ id: 'l', text: 'cat' }, { id: 'l2', text: 'dog' }], rightItems: [{ id: 'r', text: 'mèo' }, { id: 'x', text: 'chó' }], correctMatches: { l: 'r', l2: 'x' }, points: 10 },
    { id: 'blank', type: 'fill-blank', prompt: 'Fill', acceptedAnswers: ['Hello world'], normalization: { caseSensitive: false, collapseWhitespace: true }, points: 10 }
  ];
  const s = createRoomState({ roomCode: 'X', gameId: 'g', pace: 'self', maxPlayers: 1, now: 0 });
  apply(s, { role: 'system' }, 'contentLoaded', { bank: bank('types', questions) }, 1); apply(s, { role: 'system' }, 'addPlayer', { playerId: 'p', name: 'P' }, 2); apply(s, { role: 'teacher' }, 'start', { roundId: 'r' }, 3);
  for (const [qid, value] of [['order', ['a', 'b']], ['match', { l: 'r', l2: 'x' }], ['blank', '  HELLO   WORLD  ']]) { assert.equal(apply(s, { role: 'student', playerId: 'p' }, 'answer', { roundId: 'r', questionId: qid, answer: value }, 4).ok, true); assert.equal(s.players[0].results[qid].isCorrect, true); if (qid !== 'blank') apply(s, { role: 'student', playerId: 'p' }, 'advance', { roundId: 'r', questionId: qid }, 5); }
  assert.equal(s.players[0].score, 30);
});

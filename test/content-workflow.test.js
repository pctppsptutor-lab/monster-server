import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('draft/review/publish freezes a restorable bank snapshot', async () => {
  const data = mkdtempSync(path.join(tmpdir(), 'cg-content-test-'));
  process.env.DATA_DIR = data; process.env.CONTENT_HOSTS = 'content.test';
  let correct = 'a';
  globalThis.fetch = async () => new Response(JSON.stringify({ schemaVersion: 2, title: `Bank ${correct}`, questions: [{ id: 'q1', type: 'single-choice', prompt: 'Q', options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], correctOptionId: correct }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  const m = await import('../content-source.js');
  const url = 'https://content.test/bank.json';
  await m.setDraft('grade-3-game', url, 'owner'); await m.reviewDraft('grade-3-game', 'owner'); await m.publishDraft('grade-3-game', 'owner');
  assert.equal((await m.loadBankForGame('grade-3-game')).questions[0].correctOptionId, 'a');
  correct = 'b'; // changing the source alone must not bypass the publish gate
  assert.equal((await m.loadBankForGame('grade-3-game')).questions[0].correctOptionId, 'a');
  await m.setDraft('grade-3-game', url, 'owner'); await m.reviewDraft('grade-3-game', 'owner'); await m.publishDraft('grade-3-game', 'owner');
  assert.equal((await m.loadBankForGame('grade-3-game')).questions[0].correctOptionId, 'b');
  const status = await m.listSourceStatus(); assert.doesNotMatch(JSON.stringify(status), /correctOptionId|acceptedAnswers|correctOrder|correctMatches/);
  correct = 'b'; await m.restoreVersion('grade-3-game', 1, 'owner');
  assert.equal((await m.loadBankForGame('grade-3-game')).questions[0].correctOptionId, 'a');
  rmSync(data, { recursive: true, force: true });
});

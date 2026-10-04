import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateBank } from '../shared/question-bank.js';

test('validation reports exact question for missing answer and duplicate id', async () => {
  await assert.rejects(() => validateBank({ schemaVersion: 2, questions: [{ id: 'q1', type: 'single-choice', prompt: 'X', options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] }] }), /Câu 1: thiếu đáp án đúng/);
  await assert.rejects(() => validateBank({ schemaVersion: 2, questions: [
    { id: 'same', type: 'fill-blank', prompt: 'A', acceptedAnswers: ['a'] },
    { id: 'same', type: 'fill-blank', prompt: 'B', acceptedAnswers: ['b'] }
  ] }), /Câu 2: trùng mã "same"/);
});

test('media question types require the matching media kind', async () => {
  await assert.rejects(() => validateBank({ schemaVersion: 2, questions: [{ id: 'q', type: 'listening-choice', prompt: 'Listen', media: { kind: 'image', src: 'assets/a.png' }, options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], correctOptionId: 'a' }] }), /media.kind="audio"/);
});

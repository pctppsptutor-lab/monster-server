import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authenticateTeacher } from '../auth.js';

test('teacher fallback uses separate identities and rejects the old shared key model', async () => {
  process.env.TEACHER_ACCOUNTS = JSON.stringify({ lan: 'lan-secret-123456789', minh: 'minh-secret-123456789' });
  assert.deepEqual(await authenticateTeacher({}, { teacherId: 'lan', teacherKey: 'lan-secret-123456789' }), { teacherId: 'lan' });
  assert.equal(await authenticateTeacher({}, { teacherId: 'minh', teacherKey: 'lan-secret-123456789' }), null);
  assert.equal(await authenticateTeacher({}, { teacherKey: 'lan-secret-123456789' }), null);
});

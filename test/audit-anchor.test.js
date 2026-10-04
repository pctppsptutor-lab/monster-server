import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAudit } from '../audit.js';

test('external audit anchor detects tail truncation', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'cg-audit-anchor-')), data = path.join(root, 'data');
  process.env.AUDIT_ANCHOR_FILE = path.join(root, 'anchor', 'checkpoint.json');
  const audit = createAudit(data, { echo: false });
  await audit.record('one'); await audit.record('two'); await audit.checkpoint(); await audit.record('three');
  assert.equal((await audit.verify()).ok, true);
  const lines = readFileSync(audit.file, 'utf8').trim().split('\n'); writeFileSync(audit.file, lines[0] + '\n');
  const broken = await audit.verify(); assert.equal(broken.ok, false); assert.match(broken.message, /bị cắt/);
  rmSync(root, { recursive: true, force: true }); delete process.env.AUDIT_ANCHOR_FILE;
});

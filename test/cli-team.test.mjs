import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/pi-link.mjs');

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: root });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('team show reports the configured manifest through the public CLI', async () => {
  const result = await run(['team', 'show']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Team: demo/);
  assert.match(result.stdout, /Hub role: advisor/);
});

test('team check rejects the fixture when its referenced files are absent', async () => {
  const result = await run(['team', 'check']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /roles\.advisor\.profile is missing/);
});

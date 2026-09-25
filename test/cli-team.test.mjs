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

test('team inspection reports the configured manifest through the public CLI', async () => {
  const result = await run(['--team']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Team: demo/);
  assert.match(result.stdout, /Hub role: advisor/);
});

test('--team --json emits machine-readable discovery output', async () => {
  const result = await run(['--team', '--json']);
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout);
  // Declared roles resolve relative to the repo root, so a launcher can consume
  // the paths directly.
  assert.equal(payload.manifest.team.name, 'demo');
  assert.equal(
    payload.manifest.roles.advisor.profile,
    path.join(root, '.agents', 'advisor.agent.md'),
  );
  // The internal validation aid is not part of the reported team state.
  assert.equal('existingDirs' in payload, false);
});

test('--team-check rejects the fixture when its referenced files are absent', async () => {
  const result = await run(['--team-check']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /roles\.advisor\.profile is missing/);
});

// The subcommand form made a session named `team` unreachable. It must resolve as
// a session name again, so a following token is treated as an unexpected
// positional rather than a subcommand.
test('a session named "team" is reachable, not captured by the flag surface', async () => {
  const result = await run(['team', 'show']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Unexpected argument after session name/);
  assert.doesNotMatch(result.stderr, /--team/);
});

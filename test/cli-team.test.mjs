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

// ─── --team-init / --team-run ────────────────────────────────────────────────

// These run in a throwaway repo, not the shared fixture: --team-init --write
// creates a manifest, and the fixture's own manifest is the subject of the
// discovery tests above.
async function tempRepo() {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-link-cli-'));
  await mkdir(path.join(dir, '.omp', 'agents'), { recursive: true });
  await writeFile(
    path.join(dir, '.omp', 'agents', 'advisor.md'),
    '---\nname: advisor\ndescription: d\nrole: Lead\nlinkName: advisor\n---\nYou advise.\n',
  );
  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

function runIn(dir, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: dir });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// Printing is the default so a user can see the proposal before committing to it.
test('--team-init prints a manifest and writes nothing by default', async () => {
  const repo = await tempRepo();
  try {
    const result = await runIn(repo.dir, ['--team-init', '--hub', 'advisor']);
    assert.equal(result.code, 0);
    const manifest = JSON.parse(result.stdout);
    assert.equal(manifest.hub.role, 'advisor');
    assert.deepEqual(Object.keys(manifest.roles), ['advisor']);
    assert.match(result.stderr, /Nothing written/);

    // Nothing on disk: the default must not have side effects.
    const check = await runIn(repo.dir, ['--team-check']);
    assert.equal(check.code, 1);
  } finally {
    await repo.cleanup();
  }
});

// The built manifest has to pass the same gate every hand-written manifest does.
test('--team-init --write produces a manifest that --team-check accepts', async () => {
  const repo = await tempRepo();
  try {
    const init = await runIn(repo.dir, ['--team-init', '--write', '--hub', 'advisor', '--group', 'demo']);
    assert.equal(init.code, 0);
    assert.match(init.stdout, /Wrote .*team\.json/);

    const check = await runIn(repo.dir, ['--team-check']);
    assert.equal(check.code, 0, check.stderr);
    assert.match(check.stdout, /Team manifest valid/);
  } finally {
    await repo.cleanup();
  }
});

// Clobbering a manifest discards a composition decision, so it refuses.
test('--team-init --write refuses to overwrite an existing manifest', async () => {
  const repo = await tempRepo();
  try {
    await runIn(repo.dir, ['--team-init', '--write', '--hub', 'advisor']);
    const second = await runIn(repo.dir, ['--team-init', '--write', '--hub', 'advisor']);
    assert.equal(second.code, 1);
    assert.match(second.stderr, /refusing to overwrite/);
  } finally {
    await repo.cleanup();
  }
});

// --dry-run resolves the whole plan without spawning anything: the argv, the
// resolved profile path and the prompt the role would receive.
test('--team-run --dry-run prints the plan without launching', async () => {
  const repo = await tempRepo();
  try {
    await runIn(repo.dir, ['--team-init', '--write', '--hub', 'advisor']);
    const result = await runIn(repo.dir, ['--team-run', '--dry-run']);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Launch plan \(1 role\):/);
    assert.match(result.stdout, /advisor \[hub\]/);
    assert.match(result.stdout, /--link-name advisor/);
    // The body of the profile, not its frontmatter.
    assert.match(result.stdout, /prompt: {2}\d+ bytes/);
  } finally {
    await repo.cleanup();
  }
});

// A plan with errors must not half-launch, so --dry-run exits nonzero and names
// the broken role.
test('--team-run --dry-run exits nonzero when the plan has errors', async () => {
  const repo = await tempRepo();
  try {
    await runIn(repo.dir, ['--team-init', '--write', '--hub', 'advisor']);
    // Break the manifest by pointing it at a profile that does not exist.
    const { readFile, writeFile } = await import('node:fs/promises');
    const manifestPath = path.join(repo.dir, '.pi-link', 'team.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.roles.advisor.profile = 'gone.md';
    await writeFile(manifestPath, JSON.stringify(manifest));

    const result = await runIn(repo.dir, ['--team-run', '--dry-run']);
    assert.equal(result.code, 1);
    // Declared paths are normalized to absolute on load, so the error names the
    // resolved location rather than the manifest's relative spelling.
    assert.match(result.stdout, /ERROR roles\.advisor\.profile is not readable: .*gone\.md/);
    assert.match(result.stdout, /ERROR hub\.role "advisor" is not among the launched roles/);
  } finally {
    await repo.cleanup();
  }
});

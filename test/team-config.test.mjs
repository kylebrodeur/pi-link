import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discoverTeam, loadTeamConfig, validateTeamConfig, formatTeamReport } from '../bin/team-config.mjs';

async function tempRepo() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'pi-link-team-'));
}

test('loads a JSON team manifest and normalizes role paths relative to the repository', async () => {
  const root = await tempRepo();
  await fs.mkdir(path.join(root, '.pi-link'));
  await fs.writeFile(path.join(root, '.pi-link', 'team.json'), JSON.stringify({
    version: 1,
    team: { name: 'demo', group: 'demo' },
    hub: { role: 'advisor', mode: 'designated' },
    roles: {
      advisor: {
        role: 'coordinator',
        profile: '.omp/agents/advisor.md',
        skills: { required: ['team-workflow'] },
        tools: { required: ['read'], requestable: ['browser'] }
      }
    }
  }));

  const config = await loadTeamConfig(root);
  assert.equal(config.team.name, 'demo');
  assert.equal(config.roles.advisor.profile, path.join(root, '.omp/agents/advisor.md'));
  assert.deepEqual(config.roles.advisor.tools.requestable, ['browser']);
});

test('loads a YAML team manifest using standard YAML features', async () => {
  const root = await tempRepo();
  await fs.mkdir(path.join(root, '.pi-link'));
  await fs.writeFile(path.join(root, '.pi-link', 'team.yml'), [
    'version: 1',
    'team:',
    '  name: demo',
    '  group: demo',
    'hub:',
    '  role: advisor',
    '  mode: designated',
    'roles:',
    '  advisor:',
    '    role: coordinator',
    '    profile: .omp/agents/advisor.md',
    // A colon inside a quoted scalar must not be treated as a key separator.
    '    summary: "Coordinate: keep peers unblocked"',
    '    skills:',
    '      required: [team-workflow]',
    '    tools:',
    '      required: [read]',
    '      requestable:',
    '        - browser',
    '  builder:',
    '    role: member',
    // A block scalar with real newlines must survive parsing intact.
    '    instructions: |',
    '      Build the thing.',
    '      Then verify it.',
  ].join('\n'));

  const config = await loadTeamConfig(root);
  assert.equal(config.team.group, 'demo');
  assert.equal(config.roles.advisor.summary, 'Coordinate: keep peers unblocked');
  assert.deepEqual(config.roles.advisor.skills.required, ['team-workflow']);
  assert.deepEqual(config.roles.advisor.tools.requestable, ['browser']);
  assert.equal(config.roles.builder.instructions, 'Build the thing.\nThen verify it.\n');
});

test('discovers profiles, skills, and launch scripts without writing files', async () => {
  const root = await tempRepo();
  await fs.mkdir(path.join(root, '.omp', 'agents'), { recursive: true });
  await fs.mkdir(path.join(root, '.omp', 'skills', 'workflow'), { recursive: true });
  await fs.mkdir(path.join(root, '.agents'), { recursive: true });
  await fs.mkdir(path.join(root, 'scripts'), { recursive: true });
  await fs.writeFile(path.join(root, '.omp', 'agents', 'advisor.md'), '---\nrole: coordinator\n---\n');
  await fs.writeFile(path.join(root, '.agents', 'tester.agent.md'), '---\nrole: member\n---\n');
  await fs.writeFile(path.join(root, '.omp', 'skills', 'workflow', 'SKILL.md'), '# Workflow');
  await fs.writeFile(path.join(root, 'scripts', 'start-team.sh'), '#!/bin/sh');

  const result = await discoverTeam(root);
  assert.deepEqual(result.profiles.map((entry) => entry.path), [
    path.join(root, '.agents', 'tester.agent.md'),
    path.join(root, '.omp', 'agents', 'advisor.md')
  ].sort());
  assert.deepEqual(result.skills.map((entry) => entry.id), ['workflow']);
  assert.deepEqual(result.launchScripts.map((entry) => entry.path), [path.join(root, 'scripts', 'start-team.sh')]);
});

test('reports missing required profile and hub role as validation errors', async () => {
  const result = validateTeamConfig({
    version: 1,
    team: { name: 'demo', group: 'demo' },
    hub: { role: 'missing', mode: 'designated' },
    roles: {
      worker: { role: 'member', profile: '/not-present.md', skills: { required: ['missing'] }, tools: { required: [], requestable: [] } }
    }
  }, { existingPaths: new Set(), skillIds: new Set() });

  assert.deepEqual(result.errors, [
    'hub.role "missing" does not name a configured role',
    'roles.worker.profile is missing: /not-present.md',
    'roles.worker.skills.required references missing skill: missing'
  ]);
});

test('requires a hub role even when no hub mode is declared', () => {
  const result = validateTeamConfig({
    version: 1,
    team: { name: 'demo', group: 'demo' },
    roles: {
      worker: { role: 'member', profile: '/present.md' }
    }
  }, { existingPaths: new Set(['/present.md']), skillIds: new Set() });

  assert.deepEqual(result.errors, ['hub.role is required']);
});

test('formats a concise discovery report', () => {
  const text = formatTeamReport({
    root: '/repo',
    manifest: null,
    profiles: [{ path: '/repo/.omp/agents/advisor.md', id: 'advisor', role: 'coordinator' }],
    skills: [{ path: '/repo/.omp/skills/workflow/SKILL.md', id: 'workflow' }],
    launchScripts: [{ path: '/repo/scripts/start-team.sh', id: 'start-team.sh' }]
  });
  assert.match(text, /Profiles \(1\):/);
  assert.match(text, /advisor.*coordinator/);
  assert.match(text, /Skills \(1\): workflow/);
  assert.match(text, /Launch scripts \(1\):/);
});

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

test('a declared profile outside the scanned roots validates, and warns it is not OMP-resolvable', async () => {
  const root = await tempRepo();
  // A role's profile may sit beside its own session dir rather than under a
  // discovery root (`.omp/agents`). Real case: folia-app keeps
  // `.omp/plantfluent-agents/plantfluent-pen-porter.md`, and its launcher reads
  // that path directly. So it must validate — but OMP would not load it as a
  // subagent, and that difference has to be visible.
  await fs.mkdir(path.join(root, '.omp', 'plantfluent-agents'), { recursive: true });
  await fs.mkdir(path.join(root, '.pi-link'), { recursive: true });
  await fs.writeFile(
    path.join(root, '.omp', 'plantfluent-agents', 'plantfluent-pen-porter.md'),
    '---\nname: pen-porter\nmodel: kimi-k2.7-code\n---\nbody\n',
  );
  await fs.writeFile(path.join(root, '.pi-link', 'team.json'), JSON.stringify({
    version: 1,
    team: { name: 'demo', group: 'demo' },
    hub: { role: 'pen-porter' },
    roles: {
      'pen-porter': { profile: '.omp/plantfluent-agents/plantfluent-pen-porter.md' }
    }
  }));

  const inventory = await discoverTeam(root);
  // Discovery does not treat it as a discoverable profile...
  assert.deepEqual(inventory.profiles, []);
  // ...so validation passes (the file exists) but says OMP will not resolve it.
  const result = validateTeamConfig(inventory.manifest, {
    existingPaths: inventory.existingPaths,
    existingDirs: inventory.existingDirs,
    skillIds: new Set(),
    skills: [],
    profiles: inventory.profiles,
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /outside OMP's agent roots/);
  assert.match(result.warnings[0], /a launcher can still pass it by path/);
});

test('a profile under a real OMP root does not warn', async () => {
  const root = await tempRepo();
  await fs.mkdir(path.join(root, '.omp', 'agents'), { recursive: true });
  await fs.mkdir(path.join(root, '.pi-link'), { recursive: true });
  await fs.writeFile(
    path.join(root, '.omp', 'agents', 'advisor.md'),
    '---\nname: advisor\nmodel: glm-5.3\n---\nbody\n',
  );
  await fs.writeFile(path.join(root, '.pi-link', 'team.json'), JSON.stringify({
    version: 1,
    team: { name: 'demo', group: 'demo' },
    hub: { role: 'advisor' },
    roles: { advisor: { profile: '.omp/agents/advisor.md' } }
  }));

  const inventory = await discoverTeam(root);
  assert.deepEqual(inventory.profiles.map((profile) => profile.id), ['advisor']);
  assert.equal(inventory.profiles[0].source, 'project');

  const result = validateTeamConfig(inventory.manifest, {
    existingPaths: inventory.existingPaths,
    existingDirs: inventory.existingDirs,
    skillIds: new Set(),
    skills: [],
    profiles: inventory.profiles,
  });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

test('a YAML manifest is not picked up, so the JSON path stays authoritative', async () => {
  const root = await tempRepo();
  await fs.mkdir(path.join(root, '.pi-link'));
  await fs.writeFile(path.join(root, '.pi-link', 'team.yml'), 'version: 1\nteam:\n  name: demo\n');

  assert.equal(await loadTeamConfig(root), null);
});

test('rejects a manifest that is not a JSON object', async () => {
  const root = await tempRepo();
  await fs.mkdir(path.join(root, '.pi-link'));
  await fs.writeFile(path.join(root, '.pi-link', 'team.json'), '[1, 2, 3]');

  await assert.rejects(() => loadTeamConfig(root), /must be a JSON object/);
});

test('reports malformed JSON as a read failure rather than a partial config', async () => {
  const root = await tempRepo();
  await fs.mkdir(path.join(root, '.pi-link'));
  await fs.writeFile(path.join(root, '.pi-link', 'team.json'), '{ "version": 1,');

  await assert.rejects(() => loadTeamConfig(root));
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

test('does not treat skill reference documents as profiles', async () => {
  const root = await tempRepo();
  // `.agents/` holds both profiles and a `skills/` tree; a recursive profile
  // scan would report every bundled skill .md as a role.
  await fs.mkdir(path.join(root, '.agents', 'skills', 'workflow'), { recursive: true });
  await fs.writeFile(path.join(root, '.agents', 'tester.agent.md'), '---\nrole: member\n---\n');
  await fs.writeFile(path.join(root, '.agents', 'skills', 'workflow', 'SKILL.md'), '# Workflow');
  await fs.writeFile(path.join(root, '.agents', 'skills', 'workflow', 'reference.md'), '# Ref');

  const result = await discoverTeam(root);
  assert.deepEqual(result.profiles.map((entry) => entry.id), ['tester']);
});

test('follows a symlinked skill directory', async () => {
  const root = await tempRepo();
  // Real repos link skills in from elsewhere (e.g. .omp/skills/<name> ->
  // ../../.claude/skills/...). readdir reports a symlink as neither file nor
  // directory, so an unresolved walker silently drops the skill.
  await fs.mkdir(path.join(root, 'shared', 'team-workflow'), { recursive: true });
  await fs.writeFile(path.join(root, 'shared', 'team-workflow', 'SKILL.md'), '# Workflow');
  await fs.mkdir(path.join(root, '.omp', 'skills'), { recursive: true });
  await fs.symlink(
    path.join(root, 'shared', 'team-workflow'),
    path.join(root, '.omp', 'skills', 'team-workflow'),
  );

  const result = await discoverTeam(root);
  assert.deepEqual(result.skills.map((entry) => entry.id), ['team-workflow']);
});

test('reads the flat frontmatter fields a real profile declares', async () => {
  const root = await tempRepo();
  await fs.mkdir(path.join(root, '.omp', 'agents'), { recursive: true });
  await fs.writeFile(path.join(root, '.omp', 'agents', 'advisor.md'), [
    '---',
    'name: advisor',
    'description: Coordinates the team',
    'model: glm-5.2:cloud',
    'autoloadSkills: team-workflow, context-management',
    '---',
    'Body text that must not be parsed as a field.',
  ].join('\n'));

  const result = await discoverTeam(root);
  const [profile] = result.profiles;
  assert.equal(profile.model, 'glm-5.2:cloud');
  assert.deepEqual(profile.skills, ['team-workflow', 'context-management']);
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

// A skill in both a source root and an install root is the normal
// source-to-install relationship, so it is a warning, not an error: it matters
// only when the install is stale and shadows source edits.
test('warns when a skill id appears in more than one root', () => {
  const result = validateTeamConfig({
    version: 1,
    team: { name: 'demo', group: 'demo' },
    hub: { role: 'worker' },
    roles: {
      worker: { role: 'member', profile: '/present.md' }
    }
  }, {
    existingPaths: new Set(['/present.md']),
    skillIds: new Set(['workflow']),
    skills: [
      { id: 'workflow', root: '.agents/skills', path: '/repo/.agents/skills/workflow/SKILL.md' },
      { id: 'workflow', root: 'skills', path: '/repo/skills/workflow/SKILL.md' },
      { id: 'other', root: 'skills', path: '/repo/skills/other/SKILL.md' }
    ]
  });

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, [
    'skill "workflow" appears in 2 skill roots, so an installed copy may shadow source edits: '
    + '.agents/skills, skills'
  ]);
});

test('formats a concise discovery report', () => {
  const text = formatTeamReport({
    root: '/repo',
    manifest: null,
    profiles: [{ path: '/repo/.omp/agents/advisor.md', id: 'advisor', role: 'coordinator' }],
    skills: [{ path: '/repo/.omp/skills/workflow/SKILL.md', id: 'workflow' }],
    launchScripts: [{ path: '/repo/scripts/start-team.sh', id: 'start-team.sh' }]
  });
  assert.match(text, /Profiles available \(1\):/);
  assert.match(text, /advisor.*coordinator/);
  assert.match(text, /Skills \(1\): workflow/);
  assert.match(text, /Launch scripts \(1\):/);
});

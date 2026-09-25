import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discoverTeam, loadTeamConfig, validateTeamConfig, formatTeamReport, buildTeamManifest, resolveLaunchPlan, formatLaunchPlan, profilePromptBody } from '../bin/team-config.mjs';

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

test('a declared profile outside every harness root validates, and warns it will not load', async () => {
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
  assert.match(result.warnings[0], /outside every harness's agent roots/);
  assert.match(result.warnings[0], /a launcher can still pass it by path/);
});

test('a profile under a real OMP root does not warn', async () => {
  const root = await tempRepo();
  await fs.mkdir(path.join(root, '.omp', 'agents'), { recursive: true });
  await fs.mkdir(path.join(root, '.pi-link'), { recursive: true });
  await fs.writeFile(
    path.join(root, '.omp', 'agents', 'advisor.md'),
    '---\nname: advisor\ndescription: coordinates\nmodel: glm-5.3\n---\nbody\n',
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

// Pi resolves `.pi/agents` and pi-subagents' legacy `.agents`; OMP resolves
// neither. A profile there IS loadable, just by the other harness, so it must
// not warn — warning would claim nothing loads it, which is false.
test('a Pi-resolvable root does not warn, because Pi loads it', async () => {
  for (const dir of ['.pi/agents', '.agents']) {
    const root = await tempRepo();
    await fs.mkdir(path.join(root, dir), { recursive: true });
    await fs.mkdir(path.join(root, '.pi-link'), { recursive: true });
    await fs.writeFile(
      path.join(root, dir, 'builder.md'),
      '---\nname: builder\ndescription: member\nmodel: kimi-k2.7-code\n---\nbody\n',
    );
    await fs.writeFile(path.join(root, '.pi-link', 'team.json'), JSON.stringify({
      version: 1,
      team: { name: 'demo', group: 'demo' },
      hub: { role: 'builder' },
      roles: { builder: { profile: `${dir}/builder.md` } }
    }));

    const inventory = await discoverTeam(root);
    assert.deepEqual(inventory.profiles.map((p) => p.id), ['builder'], dir);

    const result = validateTeamConfig(inventory.manifest, {
      existingPaths: inventory.existingPaths,
      existingDirs: inventory.existingDirs,
      skillIds: new Set(),
      skills: [],
      profiles: inventory.profiles,
    });
    assert.deepEqual(result.errors, [], dir);
    assert.deepEqual(result.warnings, [], dir);
  }
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

// The harness matters: OMP resolves `.omp/agents`, Pi resolves `.pi/agents`, and
// `.agents` is pi-subagents' legacy dir (Pi-only for profiles — OMP reads it for
// skills/rules/prompts, never agent definitions). A report that said only
// "[project]" would imply every harness loads every profile.
test('records which harness resolves each profile root', async () => {
  const root = await tempRepo();
  for (const dir of ['.omp/agents', '.pi/agents', '.agents']) {
    await fs.mkdir(path.join(root, dir), { recursive: true });
    await fs.writeFile(path.join(root, dir, 'role.md'), `---\nname: ${dir.replace(/\W/g, '')}\ndescription: d\n---\n`);
  }

  const result = await discoverTeam(root);
  const byRoot = new Map(result.profiles.map((p) => [p.root, p]));
  assert.equal(byRoot.get('.omp/agents').harness, 'omp');
  assert.equal(byRoot.get('.pi/agents').harness, 'pi');
  assert.equal(byRoot.get('.agents').harness, 'pi');
  assert.equal(byRoot.get('.agents').legacy, true);
  assert.equal(byRoot.get('.omp/agents').legacy, false);
});

// A profile in a correct root still does not register without `name` AND
// `description`: pi-subagents skips such files outright, and OMP does the same
// (verified against the real binary — a name-only profile is absent from the
// subagent list while an otherwise identical one with a description appears).
// The path existing is not the same as the agent existing.
test('marks a profile inert when its frontmatter lacks name or description', async () => {
  const root = await tempRepo();
  await fs.mkdir(path.join(root, '.omp', 'agents'), { recursive: true });
  await fs.writeFile(path.join(root, '.omp', 'agents', 'ok.md'), '---\nname: ok\ndescription: d\n---\n');
  await fs.writeFile(path.join(root, '.omp', 'agents', 'nodesc.md'), '---\nname: nodesc\n---\n');
  await fs.writeFile(path.join(root, '.omp', 'agents', 'noname.md'), '---\ndescription: d\n---\n');
  await fs.writeFile(path.join(root, '.omp', 'agents', 'neither.md'), '---\nrole: member\n---\n');

  const result = await discoverTeam(root);
  const byId = new Map(result.profiles.map((p) => [p.id, p]));
  assert.equal(byId.get('ok').loadable, true);
  assert.equal(byId.get('ok').notLoadableBecause, undefined);
  assert.equal(byId.get('nodesc').loadable, false);
  assert.equal(byId.get('nodesc').notLoadableBecause, 'missing description');
  assert.equal(byId.get('noname').loadable, false);
  assert.equal(byId.get('noname').notLoadableBecause, 'missing name');
  assert.equal(byId.get('neither').loadable, false);
  assert.equal(byId.get('neither').notLoadableBecause, 'missing name and description');
});

// A declared role pointing at an inert profile is a composition bug the launcher
// cannot see: the file exists and the root is right, yet no agent registers.
test('warns when a declared role points at an inert profile', async () => {
  const root = await tempRepo();
  await fs.mkdir(path.join(root, '.omp', 'agents'), { recursive: true });
  await fs.mkdir(path.join(root, '.pi-link'), { recursive: true });
  await fs.writeFile(path.join(root, '.omp', 'agents', 'quiet.md'), '---\nname: quiet\n---\n');
  await fs.writeFile(path.join(root, '.pi-link', 'team.json'), JSON.stringify({
    version: 1,
    team: { name: 'demo', group: 'demo' },
    hub: { role: 'quiet' },
    roles: { quiet: { profile: '.omp/agents/quiet.md' } }
  }));

  const inventory = await discoverTeam(root);
  const result = validateTeamConfig(inventory.manifest, {
    existingPaths: inventory.existingPaths,
    existingDirs: inventory.existingDirs,
    skillIds: new Set(),
    skills: [],
    profiles: inventory.profiles,
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /missing description/);
  assert.match(result.warnings[0], /no harness will register it/);
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
    profiles: [
      { path: '/repo/.omp/agents/advisor.md', id: 'advisor', role: 'coordinator', source: 'project', harness: 'omp', legacy: false },
      { path: '/repo/.agents/old.md', id: 'old', role: null, source: 'project', harness: 'pi', legacy: true }
    ],
    skills: [{ path: '/repo/.omp/skills/workflow/SKILL.md', id: 'workflow' }],
    launchScripts: [{ path: '/repo/scripts/start-team.sh', id: 'start-team.sh' }]
  });
  assert.match(text, /Profiles available \(2\):/);
  assert.match(text, /advisor.*coordinator/);
  // The harness is named, because OMP and Pi resolve different roots.
  assert.match(text, /\[project omp\] advisor/);
  assert.match(text, /\[project, legacy pi\] old/);
  assert.match(text, /Skills \(1\): workflow/);
  assert.match(text, /Launch scripts \(1\):/);
});

// ─── Manifest building ───────────────────────────────────────────────────────

// The builder exists so a manifest can be created from discovery rather than by
// hand. Its output has to satisfy the same validator every other manifest does,
// or the scaffold is worse than useless.
test('builder output round-trips through the validator', async () => {
  const root = await tempRepo();
  await fs.mkdir(path.join(root, '.omp', 'agents'), { recursive: true });
  await fs.writeFile(
    path.join(root, '.omp', 'agents', 'advisor.md'),
    '---\nname: advisor\ndescription: d\nrole: Lead\nlinkName: advisor\n---\nbody\n',
  );

  const inventory = await discoverTeam(root);
  const { manifest, notes } = buildTeamManifest(inventory, { hub: 'advisor' });
  assert.equal(manifest.hub.role, 'advisor');
  assert.deepEqual(Object.keys(manifest.roles), ['advisor']);

  // Write it, then validate the written file the way --team-check does.
  await fs.mkdir(path.join(root, '.pi-link'), { recursive: true });
  await fs.writeFile(path.join(root, '.pi-link', 'team.json'), JSON.stringify(manifest));
  const written = await discoverTeam(root);
  const result = validateTeamConfig(written.manifest, {
    existingPaths: written.existingPaths,
    existingDirs: written.existingDirs,
    skillIds: new Set(written.skills.map((s) => s.id)),
    skills: written.skills,
    profiles: written.profiles,
  });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(notes, []);
});

// A role is named the way the team names it. A repo whose file is
// `plantfluent-advisor.md` has a role called `advisor`, so `--hub advisor` must
// resolve rather than silently failing to match anything.
test('builder keys roles by declared linkName, not the profile filename', async () => {
  const root = await tempRepo();
  await fs.mkdir(path.join(root, '.omp', 'agents'), { recursive: true });
  await fs.writeFile(
    path.join(root, '.omp', 'agents', 'plantfluent-advisor.md'),
    '---\nname: plantfluent-advisor\ndescription: d\nlinkName: advisor\n---\nbody\n',
  );

  const inventory = await discoverTeam(root);
  const { manifest, notes } = buildTeamManifest(inventory, { hub: 'advisor' });
  assert.deepEqual(Object.keys(manifest.roles), ['advisor']);
  assert.equal(manifest.roles.advisor.linkName, 'advisor');
  assert.equal(manifest.hub.role, 'advisor');
  assert.deepEqual(notes, []);
});

// The hub is a decision, not an inference. With two plausible coordinators the
// builder must omit hub.role and say so, rather than picking one arbitrarily.
test('builder omits an ambiguous hub instead of guessing', async () => {
  const root = await tempRepo();
  await fs.mkdir(path.join(root, '.omp', 'agents'), { recursive: true });
  for (const id of ['advisor', 'coordinator']) {
    await fs.writeFile(
      path.join(root, '.omp', 'agents', `${id}.md`),
      `---\nname: ${id}\ndescription: d\nrole: Lead\n---\nbody\n`,
    );
  }

  const inventory = await discoverTeam(root);
  const { manifest, notes } = buildTeamManifest(inventory);
  assert.equal(manifest.hub, undefined);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /hub\.role omitted/);
});

// An inert profile still launches: the launcher reads the body via
// --system-prompt and never consults frontmatter. Dropping it would produce an
// empty team for a repo whose roles work, so it is kept and annotated.
test('builder keeps an inert profile and notes why it is inert', async () => {
  const root = await tempRepo();
  await fs.mkdir(path.join(root, '.omp', 'agents'), { recursive: true });
  await fs.writeFile(path.join(root, '.omp', 'agents', 'quiet.md'), '---\nname: quiet\n---\nbody\n');

  const inventory = await discoverTeam(root);
  const { manifest, notes } = buildTeamManifest(inventory);
  assert.deepEqual(Object.keys(manifest.roles), ['quiet']);
  // Two notes: the inert profile, and the omitted hub (a profile named "quiet"
  // is not a coordinator, so none is proposed).
  assert.equal(notes.length, 2);
  assert.match(notes.join('\n'), /inert as a subagent \(missing description\)/);
  assert.match(notes.join('\n'), /hub\.role omitted/);
});

// A user-level profile is machine-local. Writing its absolute path into a
// committed manifest would break for every other clone of the repository.
test('builder excludes user-level profiles from a committed manifest', async () => {
  const root = await tempRepo();
  await fs.mkdir(path.join(root, '.omp', 'agents'), { recursive: true });
  await fs.writeFile(
    path.join(root, '.omp', 'agents', 'project-role.md'),
    '---\nname: project-role\ndescription: d\n---\nbody\n',
  );

  const inventory = await discoverTeam(root);
  inventory.profiles.push({
    path: path.join(os.homedir(), '.omp', 'agent', 'agents', 'local-role.md'),
    id: 'local-role', source: 'user', harness: 'omp', loadable: true, role: null, model: null, skills: [],
  });
  const { manifest } = buildTeamManifest(inventory);
  assert.deepEqual(Object.keys(manifest.roles), ['project-role']);
});

// ─── Launch planning ─────────────────────────────────────────────────────────

test('profilePromptBody strips frontmatter and keeps the body', () => {
  assert.equal(profilePromptBody('---\nname: a\nmodel: m\n---\nYou are A.\n'), 'You are A.\n');
  // No frontmatter at all: the whole file is the prompt.
  assert.equal(profilePromptBody('You are A.\n'), 'You are A.\n');
  // An unterminated block is not frontmatter; returning empty here would launch
  // a role with no instructions at all.
  assert.equal(profilePromptBody('---\nname: a\nYou are A.\n'), '---\nname: a\nYou are A.\n');
});

// The point of the launch plan: profile paths come from the manifest, not from a
// filename convention. This is the `pen-porter` failure — a role whose profile
// sits outside `.omp/agents/` got a stub prompt because the launcher derived the
// path instead of reading it.
test('launch plan resolves a profile that sits outside the naming convention', async () => {
  const root = await tempRepo();
  await fs.mkdir(path.join(root, '.omp', 'plantfluent-agents'), { recursive: true });
  await fs.mkdir(path.join(root, '.pi-link'), { recursive: true });
  await fs.writeFile(
    path.join(root, '.omp', 'plantfluent-agents', 'pen-porter.md'),
    '---\nname: pen-porter\n---\nYou port pens.\n',
  );
  await fs.writeFile(path.join(root, '.pi-link', 'team.json'), JSON.stringify({
    version: 1,
    team: { name: 'demo', group: 'demo' },
    hub: { role: 'pen-porter' },
    roles: { 'pen-porter': { profile: '.omp/plantfluent-agents/pen-porter.md' } }
  }));

  const inventory = await discoverTeam(root);
  const plan = await resolveLaunchPlan(inventory);
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.roles.length, 1);
  // The real body, not a placeholder stub.
  assert.match(plan.roles[0].promptBody, /You port pens\./);
  assert.equal(plan.roles[0].isHub, true);
});

// A hub naming a role that does not launch means nothing coordinates the team.
test('launch plan rejects a hub that is not a launched role', async () => {
  const root = await tempRepo();
  await fs.mkdir(path.join(root, '.pi-link'), { recursive: true });
  await fs.writeFile(path.join(root, 'role.md'), '---\nname: r\n---\nbody\n');
  await fs.writeFile(path.join(root, '.pi-link', 'team.json'), JSON.stringify({
    version: 1,
    team: { name: 'demo', group: 'demo' },
    hub: { role: 'absent' },
    roles: { r: { profile: 'role.md' } }
  }));

  const inventory = await discoverTeam(root);
  const plan = await resolveLaunchPlan(inventory);
  assert.match(plan.errors.join('\n'), /hub\.role "absent" is not among the launched roles/);
});

// A missing profile is reported for every role at once, so one bad entry does
// not hide the others behind an early exit.
test('launch plan collects every unreadable profile rather than stopping at the first', async () => {
  const root = await tempRepo();
  await fs.mkdir(path.join(root, '.pi-link'), { recursive: true });
  await fs.writeFile(path.join(root, '.pi-link', 'team.json'), JSON.stringify({
    version: 1,
    team: { name: 'demo', group: 'demo' },
    hub: { role: 'a' },
    roles: {
      a: { profile: 'missing-a.md' },
      b: { profile: 'missing-b.md' }
    }
  }));

  const inventory = await discoverTeam(root);
  const plan = await resolveLaunchPlan(inventory);
  assert.equal(plan.roles.length, 0);
  // Both unreadable profiles are named, plus the hub that consequently never
  // launched — the point is that one bad entry does not hide the others.
  assert.equal(plan.errors.length, 3);
  assert.match(plan.errors.join('\n'), /missing-a\.md/);
  assert.match(plan.errors.join('\n'), /missing-b\.md/);
  assert.match(plan.errors.join('\n'), /hub\.role "a" is not among the launched roles/);
});

// --roles narrows the launch, and naming a role the manifest does not declare is
// a warning rather than silence: a typo would otherwise launch nothing.
test('launch plan honours --roles and warns on an unknown name', async () => {
  const root = await tempRepo();
  await fs.mkdir(path.join(root, '.pi-link'), { recursive: true });
  await fs.writeFile(path.join(root, 'a.md'), '---\nname: a\n---\nA\n');
  await fs.writeFile(path.join(root, 'b.md'), '---\nname: b\n---\nB\n');
  await fs.writeFile(path.join(root, '.pi-link', 'team.json'), JSON.stringify({
    version: 1,
    team: { name: 'demo', group: 'demo' },
    hub: { role: 'a' },
    roles: { a: { profile: 'a.md' }, b: { profile: 'b.md' } }
  }));

  const inventory = await discoverTeam(root);
  const plan = await resolveLaunchPlan(inventory, { roles: ['b', 'typo'] });
  assert.deepEqual(plan.roles.map((r) => r.name), ['b']);
  assert.match(plan.warnings.join('\n'), /"--roles named "typo""|named "typo"/);
});

test('formatLaunchPlan names the hub and each prompt size', () => {
  const text = formatLaunchPlan({
    roles: [{
      name: 'advisor', linkName: 'advisor', cwd: '/repo', sessionDir: '/repo/s',
      config: null, isHub: true, argv: ['--link-name', 'advisor'], promptBody: 'x'.repeat(10),
    }],
    warnings: [], errors: [],
  });
  assert.match(text, /Launch plan \(1 role\):/);
  assert.match(text, /advisor \[hub\]/);
  assert.match(text, /prompt: {2}10 bytes/);
});

// A role's model must reach the launch. Without it a role silently runs on the
// harness default while its profile says otherwise, and nothing reports the gap.
test('launch plan passes the model from the manifest, then from the profile', async () => {
  const root = await tempRepo();
  await fs.mkdir(path.join(root, '.omp', 'agents'), { recursive: true });
  await fs.mkdir(path.join(root, '.pi-link'), { recursive: true });
  await fs.writeFile(
    path.join(root, '.omp', 'agents', 'from-profile.md'),
    '---\nname: from-profile\ndescription: d\nmodel: glm-5.3\n---\nbody\n',
  );
  await fs.writeFile(
    path.join(root, '.omp', 'agents', 'from-manifest.md'),
    '---\nname: from-manifest\ndescription: d\nmodel: glm-5.3\n---\nbody\n',
  );
  await fs.writeFile(path.join(root, '.pi-link', 'team.json'), JSON.stringify({
    version: 1,
    team: { name: 'demo', group: 'demo' },
    hub: { role: 'from-profile' },
    roles: {
      'from-profile': { profile: '.omp/agents/from-profile.md' },
      // An explicit model wins over the profile's, so a manifest can override.
      'from-manifest': { profile: '.omp/agents/from-manifest.md', model: 'kimi-k2.7-code' },
    }
  }));

  const inventory = await discoverTeam(root);
  const plan = await resolveLaunchPlan(inventory);
  const byName = new Map(plan.roles.map((role) => [role.name, role]));
  assert.equal(byName.get('from-profile').model, 'glm-5.3');
  assert.equal(byName.get('from-manifest').model, 'kimi-k2.7-code');
  assert.ok(byName.get('from-profile').argv.includes('--model'));
  assert.equal(byName.get('from-profile').argv[byName.get('from-profile').argv.indexOf('--model') + 1], 'glm-5.3');
});

// The builder records model so the manifest is complete for launching.
test('builder records the profile model in the manifest', async () => {
  const root = await tempRepo();
  await fs.mkdir(path.join(root, '.omp', 'agents'), { recursive: true });
  await fs.writeFile(
    path.join(root, '.omp', 'agents', 'advisor.md'),
    '---\nname: advisor\ndescription: d\nmodel: glm-5.3\nrole: Lead\nlinkName: advisor\n---\nbody\n',
  );

  const inventory = await discoverTeam(root);
  const { manifest } = buildTeamManifest(inventory, { hub: 'advisor' });
  assert.equal(manifest.roles.advisor.model, 'glm-5.3');
});

// A role whose profile sits outside every discovery root has an unread
// frontmatter, so no model is known. The harness default then applies, and that
// must be reported rather than passed over — the same failure shape as the
// pen-porter stub, where a silent fallback stood in for the real thing.
test('launch plan warns when no model is known for a role', async () => {
  const root = await tempRepo();
  await fs.mkdir(path.join(root, '.omp', 'agents'), { recursive: true });
  await fs.mkdir(path.join(root, '.pi-link'), { recursive: true });
  await fs.writeFile(
    path.join(root, '.omp', 'agents', 'known.md'),
    '---\nname: known\ndescription: d\nmodel: glm-5.3\n---\nbody\n',
  );
  // Outside the discovery roots, so discovery never reads its frontmatter.
  await fs.mkdir(path.join(root, 'elsewhere'), { recursive: true });
  await fs.writeFile(path.join(root, 'elsewhere', 'unknown.md'), '---\nname: unknown\n---\nbody\n');
  await fs.writeFile(path.join(root, '.pi-link', 'team.json'), JSON.stringify({
    version: 1,
    team: { name: 'demo', group: 'demo' },
    hub: { role: 'known' },
    roles: {
      known: { profile: '.omp/agents/known.md' },
      unknown: { profile: 'elsewhere/unknown.md' }
    }
  }));

  const inventory = await discoverTeam(root);
  const plan = await resolveLaunchPlan(inventory);
  assert.deepEqual(plan.errors, []);
  const unknown = plan.roles.find((role) => role.name === 'unknown');
  assert.equal(unknown.model, null);
  assert.equal(unknown.argv.includes('--model'), false);
  assert.match(plan.warnings.join('\n'), /roles\.unknown declares no model/);

  // The known role is unaffected: it still gets its model.
  const known = plan.roles.find((role) => role.name === 'known');
  assert.equal(known.model, 'glm-5.3');
});

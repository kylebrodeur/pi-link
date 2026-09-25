import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Team composition manifest. JSON only, matching pi-link's own configuration
// surface: the CLI already parses JSON for settings.json, session entries,
// package.json and the hub status payload, and the wire protocol is JSON.
// A JSON manifest needs no runtime dependency, so pi-link keeps its single
// runtime dependency (`ws`).
//
// The manifest is looked up side by side with Pi's own config, not inside it:
// `.pi-link/` is pi-link's namespace, so a team manifest never writes into
// Pi's `<cwd>/.pi/settings.json`.
const MANIFEST_CANDIDATES = [
  '.pi-link/team.json',
];

// Pi/OMP profile frontmatter is YAML-shaped, but every field we read is a flat
// `key: value` scalar. Pi's own subagent tooling parses those by hand and keeps
// a YAML library for complex nested fields only, so we follow that precedent
// instead of taking a dependency to read four strings.
// Profile roots, by the harness that actually resolves them.
//
// Two harnesses read agent definitions, out of *different* config dirs, and a
// profile is only loadable by the harness whose dir it sits in. Verified by
// placing a profile in each candidate and asking that harness to list its
// subagents — `omp --print` for OMP, pi-subagents' own resolver for Pi (Pi's
// subagent package is configDir-driven, reading the running harness's
// `piConfig.configDir`):
//
//   project              OMP   Pi     user                        OMP   Pi
//   .omp/agents/*.md     yes   no     ~/.omp/agent/agents/*.md    yes   no
//   .pi/agents/*.md      no    yes    ~/.pi/agent/agents/*.md     no    yes
//   .agents/*.md         no    yes    ~/.agents/*.md              no    yes
//
// `.agents/` is pi-subagents' legacy agent dir, so Pi still reads profiles from
// it. OMP *does* read `.agents` — but only for skills, rules, prompts, commands
// and AGENTS.md, never for agent definitions. That asymmetry is exactly why
// `.agents` cannot be reported as a plain "loadable" root, and why the harness
// is recorded per profile: "resolvable" is a question about one harness, not
// about the filesystem.
//
// OMP's own binary contains no `.pi/agents` literal at all and declares `.omp`
// as its config dir, so OMP never resolves `.pi/agents`.
//
// Discovery is NOT the roster. Everything here is reported as available
// inventory; a role joins the team only by being declared in the manifest.
const PROJECT_PROFILE_ROOTS = [
  { path: '.omp/agents', harness: 'omp' },
  { path: '.pi/agents', harness: 'pi' },
  { path: '.agents', harness: 'pi', legacy: true },
];
const USER_PROFILE_ROOTS = [
  { path: '.omp/agent/agents', harness: 'omp' },
  { path: '.pi/agent/agents', harness: 'pi' },
  { path: '.agents', harness: 'pi', legacy: true },
];
const SKILL_ROOTS = ['.omp/skills', '.agents/skills', 'skills'];
const SCRIPT_ROOT = 'scripts';

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// Classify a dirent that may be a symlink. `withFileTypes` reports a symlink as
// neither file nor directory, so a skills tree that links a skill in from
// elsewhere (e.g. `.omp/skills/<name>` -> `../../.claude/skills/...`) would be
// skipped entirely. Resolve those before deciding.
async function classify(entryPath, entry) {
  if (entry.isDirectory()) return 'dir';
  if (entry.isFile()) return 'file';
  if (!entry.isSymbolicLink()) return 'other';
  try {
    const stat = await fs.stat(entryPath);
    if (stat.isDirectory()) return 'dir';
    if (stat.isFile()) return 'file';
  } catch {
    // A broken link is not an error here; it simply contributes nothing.
  }
  return 'other';
}

// Profile roots hold profile files directly (`<root>/advisor.md`,
// `<root>/tester.agent.md`). They must not be walked recursively: an
// `.agents/` root also contains `skills/`, and recursing pulls every bundled
// skill document in as a bogus profile.
async function listFiles(root, extension) {
  if (!(await exists(root))) return [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    const kind = await classify(entryPath, entry);
    if (kind === 'file' && (!extension || entry.name.endsWith(extension))) files.push(entryPath);
  }
  return files;
}

// Skill roots nest one level (`<root>/<skill-name>/SKILL.md`), so this one
// recurses; the caller filters on the exact `SKILL.md` basename.
async function walkFiles(root, basename) {
  if (!(await exists(root))) return [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    const kind = await classify(entryPath, entry);
    if (kind === 'dir') {
      files.push(...(await walkFiles(entryPath, basename)));
    } else if (kind === 'file' && (!basename || entry.name === basename)) {
      files.push(entryPath);
    }
  }
  return files;
}

// Immediate subdirectories of a root. Two levels are enough for the layouts a
// team uses: `.omp/<team-name>/<role>` session dirs and `<root>/<skill>/`.
async function listDirs(root, depth = 2) {
  if (!(await exists(root)) || depth < 1) return [];
  const dirs = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if ((await classify(entryPath, entry)) !== 'dir') continue;
    dirs.push(entryPath);
    dirs.push(...(await listDirs(entryPath, depth - 1)));
  }
  return dirs;
}

// Read the flat `key: value` scalars from YAML-shaped frontmatter. Values keep
// their text; quotes are stripped, inline lists split on commas. This is not a
// YAML parser and does not try to be: nested mappings, block scalars, anchors
// and multi-line strings are out of scope, and a field using them is simply not
// reported rather than mis-reported.
function parseFrontmatter(text) {
  const fields = {};
  if (!text.startsWith('---')) return fields;
  const end = text.indexOf('\n---', 3);
  if (end < 0) return fields;

  for (const line of text.slice(4, end).split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    // Only top-level scalars: a leading indent means a nested block we skip.
    if (/^\s/.test(line)) continue;
    const separator = line.indexOf(':');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    if (!rawValue) continue;
    if (rawValue.startsWith('|') || rawValue.startsWith('>')) continue;
    fields[key] = parseScalar(rawValue);
  }
  return fields;
}

function parseScalar(rawValue) {
  if (
    (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
    (rawValue.startsWith("'") && rawValue.endsWith("'"))
  ) {
    return rawValue.slice(1, -1);
  }
  if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
    const body = rawValue.slice(1, -1).trim();
    return body ? body.split(',').map((item) => parseScalar(item.trim())) : [];
  }
  return rawValue;
}

// A JSON manifest must be a plain object. `JSON.parse` yields `null`, an array,
// a scalar, or an object; only the last is a usable manifest. The prototype
// check names the shape at the boundary without a runtime `typeof` narrowing.
function isPlainJsonObject(value) {
  return value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

// Parse a JSON manifest at its I/O boundary. A manifest that is not a JSON
// object (array, scalar, null) is a malformed manifest, so the shape is
// rejected here rather than re-inspected at each use site.
function parseManifestJson(text, manifestPath) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new Error(`team manifest is not valid JSON: ${manifestPath}`, { cause });
  }
  if (!isPlainJsonObject(parsed)) {
    throw new Error(`team manifest must be a JSON object: ${manifestPath}`);
  }
  return parsed;
}

// Frontmatter values arrive from `parseScalar`, which yields a string or an
// array of strings. Normalise both shapes into a list of skill ids.
function toStringList(value) {
  if (Array.isArray(value)) return value.map((item) => `${item}`);
  if (!value) return [];
  return `${value}`
    .split(',')
    .map((skill) => skill.trim())
    .filter(Boolean);
}

function normalizeRole(role, root) {
  const normalized = {
    ...role,
    skills: {
      required: role.skills?.required ?? role.requiredSkills ?? [],
      optional: role.skills?.optional ?? role.optionalSkills ?? [],
    },
    tools: {
      required: role.tools?.required ?? role.requiredTools ?? [],
      requestable: role.tools?.requestable ?? role.requestableTools ?? [],
      denied: role.tools?.denied ?? role.deniedTools ?? [],
    },
  };
  // Launch facts a role declares. `profile`/`prompt`/`config` are files;
  // `sessionDir`/`cwd` are directories. All are repo-relative by convention and
  // resolved against the repo root, so a manifest never carries absolute paths
  // that only work on one machine.
  for (const key of ['profile', 'prompt', 'config', 'sessionDir', 'cwd']) {
    if (normalized[key] && !path.isAbsolute(normalized[key])) normalized[key] = path.resolve(root, normalized[key]);
  }
  return normalized;
}

export async function loadTeamConfig(root) {
  for (const relativePath of MANIFEST_CANDIDATES) {
    const manifestPath = path.join(root, relativePath);
    if (!(await exists(manifestPath))) continue;
    const parsed = parseManifestJson(await fs.readFile(manifestPath, 'utf8'), manifestPath);
    const roles = Object.fromEntries(
      Object.entries(parsed.roles ?? {}).map(([name, role]) => [name, normalizeRole(role, root)]),
    );
    return {
      ...parsed,
      manifestPath,
      root,
      roles,
    };
  }
  return null;
}

// Read one profile's identity and the fields a launcher needs. `name` comes
// from frontmatter when present, because that is the identity the harness
// registers and the filename is only a fallback. `source`, `root` and `harness`
// record where it was found, so a report can distinguish a committed project
// profile from a machine-local user one and say which harness would load it.
//
// `loadable` mirrors the gate both harnesses apply before registering a
// profile: pi-subagents skips any file whose frontmatter lacks `name` or
// `description` (`if (!frontmatter.name || !frontmatter.description) continue`),
// and OMP behaves the same — verified by placing a name-only profile in
// `.omp/agents` and asking `omp --print` to list its subagents: it does not
// appear, while the same file with a `description` does. A profile in a correct
// root can therefore still be invisible, which is exactly the confusing case
// this flag makes visible. The filename fallback below is for reporting only; it
// never makes an unloadable file loadable.
async function readProfile(filePath, origin) {
  const frontmatter = parseFrontmatter(await fs.readFile(filePath, 'utf8'));
  const fallbackId = path.basename(filePath).replace(/\.agent\.md$|\.md$/, '');
  // A profile with no frontmatter at all (a plain markdown role brief) is a real
  // case: it still launches via --system-prompt, so it must not be dropped just
  // because it declares nothing. It has no name or description, which is the
  // same shape as an inert profile, so it is reported the same way.
  const loadable = Boolean(frontmatter.name && frontmatter.description);
  const profile = {
    ...origin,
    // A declared role's own name wins: the manifest is what the team calls it,
    // and the filename is only a fallback for a conventionally found profile.
    id: origin.declaredName ?? frontmatter.name ?? fallbackId,
    role: frontmatter.role ?? frontmatter.type ?? frontmatter.description ?? null,
    model: origin.declaredModel ?? frontmatter.model ?? null,
    skills: toStringList(frontmatter.autoloadSkills),
    // The terminal name a profile asks to be known by. A team calls this role
    // "advisor" even when the profile file is `plantfluent-advisor.md`, so it is
    // the name a manifest and `--hub` should use.
    linkName: frontmatter.linkName ?? null,
    loadable,
  };
  // Why it will not register, so the report can say it rather than leaving the
  // reader to infer it from a missing field.
  if (!loadable) {
    if (!frontmatter.name && !frontmatter.description) profile.notLoadableBecause = 'missing name and description';
    else if (!frontmatter.name) profile.notLoadableBecause = 'missing name';
    else profile.notLoadableBecause = 'missing description';
  }
  return profile;
}

export async function discoverTeam(root) {
  const profiles = [];
  for (const rootSpec of PROJECT_PROFILE_ROOTS) {
    for (const filePath of await listFiles(path.join(root, rootSpec.path), '.md')) {
      profiles.push(await readProfile(filePath, {
        path: filePath,
        root: rootSpec.path,
        source: 'project',
        harness: rootSpec.harness,
        legacy: rootSpec.legacy ?? false,
      }));
    }
  }
  // User-level profiles are not part of the repository, so they are labelled and
  // never resolved against `root`. They are still worth reporting: a harness
  // loads them, so a same-named project profile shadows one.
  for (const rootSpec of USER_PROFILE_ROOTS) {
    const userRoot = path.join(os.homedir(), rootSpec.path);
    for (const filePath of await listFiles(userRoot, '.md')) {
      profiles.push(await readProfile(filePath, {
        path: filePath,
        root: rootSpec.path,
        source: 'user',
        harness: rootSpec.harness,
        legacy: rootSpec.legacy ?? false,
      }));
    }
  }

  // A manifest may declare a profile outside every discovery root — a role file
  // kept beside its own session dir, which is legitimate (a launcher reads it by
  // path). Those roles are invisible to the scans above, so reading the manifest
  // back is the only way `--team-init` can rebuild the team it declared instead
  // of silently producing a manifest missing them. Labelled `declared` so a
  // report never presents them as conventionally discoverable.
  const priorManifest = await loadTeamConfig(root);
  const knownPaths = new Set(profiles.map((profile) => profile.path));
  for (const [name, role] of Object.entries(priorManifest?.roles ?? {})) {
    if (!role.profile) continue;
    const profilePath = path.resolve(root, role.profile);
    if (knownPaths.has(profilePath)) continue;
    if (!(await exists(profilePath))) continue;
    knownPaths.add(profilePath);
    profiles.push(await readProfile(profilePath, {
      path: profilePath,
      root: null,
      source: 'declared',
      harness: null,
      legacy: false,
      declaredName: name,
      // The manifest's own fields win for a declared role: `--team-run` reads
      // them, and they are what the team already agreed.
      declaredModel: role.model ?? null,
    }));
  }

  // `root` is recorded so a report can tell a tracked source skill from a local
  // install. Install roots are conventionally gitignored, so the distinction is
  // not visible from the path alone.
  const skills = [];
  for (const relativeRoot of SKILL_ROOTS) {
    for (const filePath of await walkFiles(path.join(root, relativeRoot), 'SKILL.md')) {
      const relativeRootPath = path.join(root, relativeRoot);
      const parts = path.relative(relativeRootPath, filePath).split(path.sep);
      skills.push({
        path: filePath,
        root: relativeRoot,
        id: parts.length > 1 ? parts[0] : path.basename(path.dirname(filePath)),
      });
    }
  }

  const launchScripts = [];
  for (const filePath of await listFiles(path.join(root, SCRIPT_ROOT), null)) {
    if (!/\.(sh|bash|zsh|mjs|js|py)$/.test(filePath)) continue;
    const basename = path.basename(filePath).toLowerCase();
    const body = await fs.readFile(filePath, 'utf8');
    if (/agent|team|omp|zellij|tmux|pi-link/i.test(`${basename}\n${body}`)) {
      launchScripts.push({ path: filePath, id: path.basename(filePath) });
    }
  }

  // Per-session OMP config overlays (`--config`), e.g. `.omp/light-session.yml`.
  const sessionConfigs = [];
  for (const filePath of await listFiles(path.join(root, '.omp'), null)) {
    if (/\.ya?ml$/.test(filePath)) {
      sessionConfigs.push({ path: filePath, id: path.basename(filePath) });
    }
  }

  // Directories a role can legitimately point at. The scan roots below cover the
  // team's own layout, but a role's working directory can be any directory in
  // the repo (`iot-rig/ui-lab`), so directories named by the manifest itself are
  // added too. Without this, a declared cwd outside `.omp/` could never
  // validate. Only directories that actually exist are recorded.
  const existingDirs = new Set();
  for (const relativeRoot of ['.', '.omp', SCRIPT_ROOT]) {
    const rootPath = path.join(root, relativeRoot);
    if (await exists(rootPath)) existingDirs.add(rootPath);
  }
  for (const relativeRoot of ['.omp', SCRIPT_ROOT]) {
    for (const dir of await listDirs(path.join(root, relativeRoot))) {
      existingDirs.add(dir);
    }
  }
  // A manifest may legitimately reference a file that exists outside the scanned
  // roots — a role profile kept beside its own session dir, for instance. The
  // discovery roots are a convention, not a constraint, so declared paths are
  // verified against the filesystem and recorded here. Without this, a real file
  // in an unconventional location is reported as missing.
  const existingPaths = new Set([
    ...profiles.map((profile) => profile.path),
    ...sessionConfigs.map((config) => config.path),
  ]);
  const declared = await loadTeamConfig(root);
  for (const role of Object.values(declared?.roles ?? {})) {
    for (const key of ['profile', 'prompt', 'config']) {
      if (role[key] && (await exists(role[key]))) existingPaths.add(role[key]);
    }
  }
  for (const role of Object.values(declared?.roles ?? {})) {
    for (const key of ['cwd', 'sessionDir']) {
      if (role[key] && (await exists(role[key]))) existingDirs.add(role[key]);
    }
  }

  return {
    root,
    manifest: declared,
    profiles: profiles.sort((a, b) => a.path.localeCompare(b.path)),
    skills: skills.sort((a, b) => a.id.localeCompare(b.id)),
    launchScripts: launchScripts.sort((a, b) => a.path.localeCompare(b.path)),
    sessionConfigs: sessionConfigs.sort((a, b) => a.id.localeCompare(b.id)),
    existingDirs,
    existingPaths,
  };
}

// Skill ids discovered in more than one root. Skill roots span both tracked
// source (`skills/`) and local installs (`.agents/skills/`, typically gitignored
// alongside `skills-lock.json`), so a repeat is normally an installed copy of a
// source skill rather than an ambiguity. It is still worth surfacing: an install
// that was not refreshed after source edits goes stale, and nothing else says so.
function shadowedSkillIds(skills) {
  const byId = new Map();
  for (const skill of skills) {
    const entries = byId.get(skill.id) ?? [];
    entries.push(skill);
    byId.set(skill.id, entries);
  }
  return [...byId.entries()]
    .filter(([, entries]) => entries.length > 1)
    .map(([id, entries]) => ({ id, roots: entries.map((entry) => entry.root) }));
}

export function validateTeamConfig(config, inventory) {
  const errors = [];
  const warnings = [];
  // Tolerate a caller that supplies only file paths: directory checks are
  // then simply unavailable rather than crashing.
  const existingDirs = inventory.existingDirs ?? new Set();
  if (!config || config.version !== 1) errors.push('team config version must be 1');
  if (!config?.team?.name) errors.push('team.name is required');
  if (!config?.team?.group) errors.push('team.group is required');
  if (!config?.roles || Object.keys(config.roles).length === 0) errors.push('roles must contain at least one role');
  if (!config?.hub?.role) errors.push('hub.role is required');
  else if (!config.roles?.[config.hub.role]) {
    errors.push(`hub.role "${config.hub.role}" does not name a configured role`);
  }
  // Skill roots include both tracked source (`skills/`) and local installs
  // (`.agents/skills/`, typically gitignored alongside `skills-lock.json`). The
  // same id in both is the normal source-to-install relationship, not an
  // ambiguity — but a stale install can shadow source edits, and nothing else
  // reports that, so surface it without claiming which one wins.
  for (const shadowed of shadowedSkillIds(inventory.skills ?? [])) {
    warnings.push(
      `skill "${shadowed.id}" appears in ${shadowed.roots.length} skill roots, so an installed copy may shadow source edits: ${shadowed.roots.join(', ')}`,
    );
  }
  const linkNames = new Map();
  const linkDirs = new Map();
  // Profile paths each harness would actually resolve. "Resolvable" is a
  // question about one harness, not about the filesystem: `.omp/agents` is
  // OMP-only, `.pi/agents` and `.agents` are Pi-only. A profile with a null
  // harness belongs to no discovery root at all (it was read back from the
  // manifest because it lives outside every one), so neither harness loads it as
  // an agent definition; a launcher may still read it (by path, as
  // `--system-prompt`), so this is a warning rather than an error — but it must
  // not look like a normal team member.
  //
  // Tolerate a caller that supplies only file paths: without a discovery result
  // the question is unanswerable, so it is skipped rather than answered wrongly.
  const resolvableBy = inventory.profiles === undefined
    ? null
    : new Map(inventory.profiles.map((profile) => [profile.path, profile.harness]));
  // A profile in a correct root can still fail to register when its frontmatter
  // lacks `name` or `description`. That is the silent one: the path exists, the
  // root is right, and the agent still never appears. Warn, because a declared
  // role that cannot register is a composition bug a launcher cannot see.
  const inertProfiles = inventory.profiles === undefined
    ? null
    : new Map(
      inventory.profiles
        .filter((profile) => profile.loadable === false)
        .map((profile) => [profile.path, profile.notLoadableBecause]),
    );
  for (const [name, role] of Object.entries(config?.roles ?? {})) {
    if (!role.profile) errors.push(`roles.${name}.profile is required`);
    else if (!inventory.existingPaths.has(role.profile)) errors.push(`roles.${name}.profile is missing: ${role.profile}`);
    else if (resolvableBy && !resolvableBy.get(role.profile)) {
      // `.has` is not enough: a discovered-but-out-of-root profile is present
      // with a null harness, and neither harness loads it as an agent
      // definition. Only a truthy harness means it would resolve.
      warnings.push(
        `roles.${name}.profile is outside every harness's agent roots, so it will not load as a subagent (a launcher can still pass it by path): ${role.profile}`,
      );
    } else if (inertProfiles?.has(role.profile)) {
      warnings.push(
        `roles.${name}.profile is in a loadable root but its frontmatter is ${inertProfiles.get(role.profile)}, so no harness will register it: ${role.profile}`,
      );
    }
    // Optional launch facts: when declared, they must exist. A role that points
    // at a directory the launcher will not create is the failure this catches.
    for (const key of ['prompt', 'config']) {
      if (role[key] && !inventory.existingPaths.has(role[key])) {
        errors.push(`roles.${name}.${key} is missing: ${role[key]}`);
      }
    }
    // `cwd` must already exist: a role cannot start in a directory that is not
    // there. `sessionDir` is different — launchers create it (`mkdir -p`) before
    // first use, so a missing one is normal on a clean checkout and is reported
    // as a warning, not an error.
    if (role.cwd && !existingDirs.has(role.cwd)) {
      errors.push(`roles.${name}.cwd is not an existing directory: ${role.cwd}`);
    }
    if (role.sessionDir && !existingDirs.has(role.sessionDir)) {
      warnings.push(`roles.${name}.sessionDir does not exist yet (created on first launch): ${role.sessionDir}`);
    }
    for (const skill of role.skills?.required ?? []) {
      if (!inventory.skillIds.has(skill)) errors.push(`roles.${name}.skills.required references missing skill: ${skill}`);
    }
    for (const skill of role.skills?.optional ?? []) {
      if (!inventory.skillIds.has(skill)) warnings.push(`roles.${name}.skills.optional references missing skill: ${skill}`);
    }
    if (role.linkName) {
      const previous = linkNames.get(role.linkName);
      if (previous) errors.push(`roles.${name}.linkName duplicates roles.${previous}: ${role.linkName}`);
      linkNames.set(role.linkName, name);
    }
    // Two roles sharing a session dir would resume the same history under
    // different identities; that is a composition mistake, not a preference.
    if (role.sessionDir) {
      const previous = linkDirs.get(role.sessionDir);
      if (previous) errors.push(`roles.${name}.sessionDir is shared with roles.${previous}: ${role.sessionDir}`);
      linkDirs.set(role.sessionDir, name);
    }
  }
  return { errors, warnings };
}

export function formatTeamReport(result) {
  const lines = [];
  lines.push(`Root: ${result.root}`);
  lines.push(result.manifest ? `Manifest: ${result.manifest.manifestPath}` : 'Manifest: none');
  // Inventory, not roster: these are the profiles OMP can load here. A role is on
  // the team only by being declared in the manifest.
  lines.push(`Profiles available (${result.profiles.length}):`);
  for (const profile of result.profiles) {
    const bits = [profile.role ? ` (${profile.role})` : '', profile.model ? ` · ${profile.model}` : ''].join('');
    // Name the harness that resolves this root: `.omp/agents` is OMP-only and
    // `.pi/agents` is Pi-only, so "[project]" alone would imply both load it.
    const loadable = profile.harness ? ` ${profile.harness}` : '';
    const legacy = profile.legacy ? ', legacy' : '';
    // A profile in a correct root still does not register without name+
    // description, so say so here rather than listing it as if it were usable.
    const inert = profile.loadable === false ? `  (INERT: ${profile.notLoadableBecause})` : '';
    lines.push(`  [${profile.source ?? 'project'}${legacy}${loadable}] ${profile.id}${bits} — ${profile.path}${inert}`);
  }
  lines.push(`Skills (${result.skills.length}): ${result.skills.map((skill) => skill.id).join(', ') || 'none'}`);
  // A skill found in both a source root and an install root is expected, but the
  // repeat is invisible in the flat list above, so name the roots explicitly.
  for (const entry of shadowedSkillIds(result.skills)) {
    lines.push(`  shadowed: ${entry.id} — found in ${entry.roots.join(', ')}`);
  }
  if (result.sessionConfigs?.length) {
    lines.push(`Session configs: ${result.sessionConfigs.map((config) => config.id).join(', ')}`);
  }
  lines.push(`Launch scripts (${result.launchScripts.length}):`);
  for (const script of result.launchScripts) lines.push(`  ${script.id} — ${script.path}`);
  return lines.join('\n');
}

// ─── Manifest building ───────────────────────────────────────────────────────

// Guess a coordinator from role text. The builder does not decide the hub; it
// only proposes one, and only when exactly one role looks like a coordinator.
// Two candidates is an ambiguity a human resolves, not something to pick from.
const COORDINATOR_PATTERN = /advisor|coordinator|lead|chief|architect|orchestrat/i;

function looksLikeCoordinator(profile) {
  return COORDINATOR_PATTERN.test(`${profile.role ?? ''} ${profile.id}`);
}

// Strip the leading frontmatter block, returning the prompt body. This is the
// same transformation a launcher has to do before handing a profile to
// `--system-prompt`: the frontmatter is metadata for the harness, not prompt
// text, and passing it through would inject YAML into the model's instructions.
export function profilePromptBody(content) {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return content;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') return lines.slice(i + 1).join('\n').replace(/^\n+/, '');
  }
  // An unterminated block is not frontmatter; treat the file as body-only rather
  // than silently returning an empty prompt.
  return content;
}

// A manifest is committed, so its paths must be repo-relative. `loadTeamConfig`
// resolves declared paths against the repo root on read, which is right for
// validating them but wrong to write back: an absolute path only works on the
// machine that produced it. Convert back, and leave a path that genuinely sits
// outside the repo absolute rather than inventing `../..` chains.
function relativize(root, absolute) {
  const relative = path.relative(root, absolute).split(path.sep).join('/');
  return relative.startsWith('..') ? absolute : (relative || '.');
}

// Build a manifest from discovery. This is a scaffold, not a guesser: every
// `profile` comes from a discovered path, and anything discovery cannot know —
// cwd, sessionDir, config — is omitted rather than invented. `--team-check`
// then reports the gaps instead of the manifest asserting wrong values.
//
// Inert profiles are included, not dropped. `description` gates *subagent
// registration*, which is not the same as being usable as a launch prompt: a
// launcher reads the profile body via `--system-prompt` and never consults
// frontmatter. Excluding them would silently produce an empty team for a repo
// whose roles launch perfectly well — the opposite of a useful scaffold. They
// are named in the notes instead, and `--team-check` warns on each.
export function buildTeamManifest(inventory, options = {}) {
  const {
    roles: onlyRoles,
    hub,
    name,
    group,
  } = options;
  const notes = [];
  const root = inventory.root;

  // Project profiles only: a user-level profile is machine-local, so writing its
  // absolute path into a committed manifest would break for every other clone.
  // `declared` profiles come from the manifest being rebuilt, so they stay.
  const candidates = (inventory.profiles ?? [])
    .filter((profile) => profile.source === 'project' || profile.source === 'declared');
  // A role is keyed by the name the team actually calls it — the profile's
  // declared `linkName` when present, else its id. A repo whose files are
  // `plantfluent-advisor.md` still has a role called `advisor`, and the manifest
  // is written in the vocabulary the team uses (`--hub advisor` must resolve).
  const roleName = (profile) => profile.linkName ?? profile.id;
  const byId = new Map(candidates.map((profile) => [roleName(profile), profile]));

  let selected = candidates;
  if (onlyRoles?.length) {
    selected = candidates.filter((profile) => onlyRoles.includes(roleName(profile)));
    for (const id of onlyRoles) {
      if (!byId.has(id)) notes.push(`--roles named "${id}", but no project profile has that name`);
    }
  }
  for (const profile of selected) {
    if (profile.loadable === false) {
      notes.push(`"${roleName(profile)}" is inert as a subagent (${profile.notLoadableBecause}); it still launches via --system-prompt`);
    }
    // A role the previous manifest declared is carried through under its own
    // name, even when its profile sits outside every discovery root. Dropping it
    // would make rebuilding a manifest silently shrink the team.
    if (profile.source === 'declared' && profile.root === null) {
      notes.push(`"${roleName(profile)}" is declared but sits outside the discovery roots; kept from the existing manifest`);
    }
  }

  const teamName = name ?? path.basename(root);
  const declaredRoles = inventory.manifest?.roles ?? {};
  const roles = {};
  for (const profile of selected) {
    const key = roleName(profile);
    // A role the existing manifest declared is carried through unchanged where
    // it has no discovery-visible source: its `cwd`, `sessionDir` and `config`
    // are real launch facts the manifest already agreed, and rebuilding must not
    // discard them. Discovery cannot know these values, so losing them would
    // degrade a working manifest into a scaffold.
    const prior = profile.source === 'declared' ? declaredRoles[key] : null;
    const entry = {
      profile: path.relative(root, profile.path).split(path.sep).join('/'),
      // Recorded explicitly rather than left implicit in the key: a launcher
      // reads this field, and `--link-name` must not silently follow a rename.
      linkName: prior?.linkName ?? key,
    };
    if (prior?.role ?? profile.role) entry.role = prior?.role ?? profile.role;
    // Recorded so `--team-run` can pass `--model` and the manifest is complete
    // for launching. Without it a role's model lives only in frontmatter, and a
    // launcher reading the manifest would run the default instead.
    if (profile.model) entry.model = profile.model;
    if (profile.skills?.length) entry.skills = { required: [...profile.skills] };
    if (prior?.cwd) entry.cwd = relativize(root, prior.cwd);
    if (prior?.sessionDir) entry.sessionDir = relativize(root, prior.sessionDir);
    if (prior?.config) entry.config = relativize(root, prior.config);
    if (prior?.tools) entry.tools = prior.tools;
    roles[prior?.linkName ?? key] = entry;
  }

  // Hub: explicit wins. Otherwise propose only a single unambiguous candidate.
  let hubRole = hub ?? null;
  if (!hubRole) {
    const coordinators = selected.filter(looksLikeCoordinator);
    if (coordinators.length === 1) {
      hubRole = roleName(coordinators[0]);
      notes.push(`proposed hub.role "${hubRole}" from role text — confirm or override with --hub`);
    } else if (coordinators.length > 1) {
      notes.push(`hub.role omitted: ${coordinators.length} roles look like a coordinator (${coordinators.map(roleName).join(', ')}); set one with --hub`);
    } else {
      notes.push('hub.role omitted: no role looks like a coordinator; set one with --hub');
    }
  } else if (!roles[hubRole]) {
    notes.push(`--hub named "${hubRole}", which is not among the selected roles`);
    hubRole = null;
  }

  const manifest = {
    version: 1,
    team: { name: teamName, group: group ?? teamName },
    roles,
  };
  if (hubRole) manifest.hub = { role: hubRole, mode: 'designated' };

  return { manifest, notes };
}

// ─── Launch planning ─────────────────────────────────────────────────────────

// Resolve a manifest into the argv each role needs, and read each profile's
// prompt body. This is what makes the manifest the single source of truth for a
// launch: the launcher stops deriving paths from a naming convention and reads
// the declared path instead, so a profile that sits outside the convention (a
// role file kept beside its own session dir) still resolves.
//
// Every failure here is collected rather than thrown, so `--dry-run` can report
// a whole plan's problems at once instead of stopping at the first.
export async function resolveLaunchPlan(inventory, options = {}) {
  const errors = [];
  const warnings = [];
  const manifest = inventory.manifest;
  if (!manifest) return { roles: [], errors: ['no team manifest found'], warnings };

  const root = inventory.root;
  const onlyRoles = options.roles?.length ? new Set(options.roles) : null;
  const resolvedBy = new Map(
    (inventory.profiles ?? []).map((profile) => [profile.path, profile]),
  );

  const roles = [];
  for (const [name, role] of Object.entries(manifest.roles ?? {})) {
    if (onlyRoles && !onlyRoles.has(name)) continue;
    if (!role.profile) {
      errors.push(`roles.${name}.profile is required`);
      continue;
    }
    const profilePath = path.resolve(root, role.profile);
    let body;
    try {
      body = profilePromptBody(await fs.readFile(profilePath, 'utf8'));
    } catch {
      errors.push(`roles.${name}.profile is not readable: ${role.profile}`);
      continue;
    }
    const discovered = resolvedBy.get(profilePath);
    if (discovered?.loadable === false) {
      // The prompt still reaches the model via --system-prompt, so this is a
      // warning about subagent registration, not a launch blocker.
      warnings.push(`roles.${name} profile is inert (${discovered.notLoadableBecause}), so no harness will register it as a subagent: ${role.profile}`);
    }

    // Model: the manifest wins if it declares one, otherwise the profile's own
    // frontmatter. Without this a role silently launches on the default model
    // and its declared model is ignored — the profile says `glm-5.3` and the
    // terminal runs something else, with nothing reporting the difference.
    const model = role.model ?? discovered?.model ?? null;
    if (!model) {
      // Say it rather than letting the harness default stand in silently. This
      // is the case for a profile outside every discovery root: the manifest
      // knows the path but discovery never read its frontmatter, so no model is
      // known and `--model` is omitted.
      warnings.push(`roles.${name} declares no model and its profile was not discovered, so the harness default will be used: ${role.profile}`);
    }

    const cwd = role.cwd ? path.resolve(root, role.cwd) : root;
    const sessionDir = role.sessionDir ? path.resolve(root, role.sessionDir) : null;
    const argv = ['--link-name', role.linkName ?? name, '--cwd', cwd];
    if (model) argv.push('--model', model);
    if (sessionDir) argv.push('--session-dir', sessionDir);
    if (role.config) argv.push('--config', path.resolve(root, role.config));

    roles.push({
      name,
      linkName: role.linkName ?? name,
      model,
      cwd,
      sessionDir,
      config: role.config ? path.resolve(root, role.config) : null,
      isHub: manifest.hub?.role === name,
      argv,
      promptBody: body,
    });
  }

  // The hub has to be a role that actually launches, or nothing coordinates.
  if (manifest.hub?.role && !roles.some((role) => role.isHub)) {
    errors.push(`hub.role "${manifest.hub.role}" is not among the launched roles`);
  }
  if (onlyRoles) {
    for (const wanted of onlyRoles) {
      if (!roles.some((role) => role.name === wanted)) {
        warnings.push(`--roles named "${wanted}", which is not a declared role`);
      }
    }
  }
  return { roles, errors, warnings };
}

export function formatLaunchPlan(plan) {
  const lines = [];
  lines.push(`Launch plan (${plan.roles.length} role${plan.roles.length === 1 ? '' : 's'}):`);
  for (const role of plan.roles) {
    const hub = role.isHub ? ' [hub]' : '';
    lines.push(`  ${role.linkName}${hub} — cwd ${role.cwd}`);
    if (role.model) lines.push(`      model:   ${role.model}`);
    if (role.sessionDir) lines.push(`      session: ${role.sessionDir}`);
    if (role.config) lines.push(`      config:  ${role.config}`);
    lines.push(`      prompt:  ${role.promptBody.length} bytes`);
    lines.push(`      argv:    ${role.argv.join(' ')}`);
  }
  for (const warning of plan.warnings) lines.push(`WARN ${warning}`);
  for (const error of plan.errors) lines.push(`ERROR ${error}`);
  return lines.join('\n');
}

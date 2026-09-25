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
  const loadable = Boolean(frontmatter.name && frontmatter.description);
  const profile = {
    ...origin,
    id: frontmatter.name ?? fallbackId,
    role: frontmatter.role ?? frontmatter.type ?? frontmatter.description ?? null,
    model: frontmatter.model ?? null,
    skills: toStringList(frontmatter.autoloadSkills),
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
  // OMP-only, `.pi/agents` and `.agents` are Pi-only. A declared profile outside
  // every root is not loaded by either as an agent definition; a launcher may
  // still read it (by path, as `--system-prompt`), so this is a warning rather
  // than an error — but it must not look like a normal team member.
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
    else if (resolvableBy && !resolvableBy.has(role.profile)) {
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

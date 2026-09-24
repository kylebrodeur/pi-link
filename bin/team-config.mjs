import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

const MANIFEST_CANDIDATES = [
  '.pi-link/team.yml',
  '.pi-link/team.yaml',
  '.pi-link/team.json',
];

const PROFILE_ROOTS = ['.omp/agents', '.agents'];
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

async function walkFiles(root) {
  if (!(await exists(root))) return [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(filePath));
    else files.push(filePath);
  }
  return files;
}

function parseManifest(text, manifestPath) {
  if (manifestPath.endsWith('.json')) return JSON.parse(text);
  const parsed = parseYaml(text);
  // An empty manifest is a valid but empty configuration, not a parse failure.
  return parsed ?? {};
}

function parseFrontmatter(text) {
  if (!text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 3);
  if (end < 0) return {};
  try {
    return parseYaml(text.slice(4, end)) ?? {};
  } catch {
    return {};
  }
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
  for (const key of ['profile', 'prompt', 'sessionDir', 'cwd']) {
    if (normalized[key] && !path.isAbsolute(normalized[key])) normalized[key] = path.resolve(root, normalized[key]);
  }
  return normalized;
}

export async function loadTeamConfig(root) {
  for (const relativePath of MANIFEST_CANDIDATES) {
    const manifestPath = path.join(root, relativePath);
    if (!(await exists(manifestPath))) continue;
    const text = await fs.readFile(manifestPath, 'utf8');
    const parsed = parseManifest(text, manifestPath);
    const roles = Object.fromEntries(Object.entries(parsed.roles ?? {}).map(([name, role]) => [name, normalizeRole(role, root)]));
    return {
      ...parsed,
      manifestPath,
      root,
      roles,
    };
  }
  return null;
}

export async function discoverTeam(root) {
  const profiles = [];
  for (const relativeRoot of PROFILE_ROOTS) {
    for (const filePath of await walkFiles(path.join(root, relativeRoot))) {
      if (!filePath.endsWith('.md')) continue;
      const frontmatter = parseFrontmatter(await fs.readFile(filePath, 'utf8'));
      profiles.push({
        path: filePath,
        id: path.basename(filePath).replace(/\.agent\.md$|\.md$/, ''),
        role: frontmatter.role ?? frontmatter.type ?? null,
        capabilities: Array.isArray(frontmatter.capabilities) ? frontmatter.capabilities : [],
      });
    }
  }

  const skills = [];
  for (const relativeRoot of SKILL_ROOTS) {
    for (const filePath of await walkFiles(path.join(root, relativeRoot))) {
      if (path.basename(filePath) !== 'SKILL.md') continue;
      const relativeRootPath = path.join(root, relativeRoot);
      const relative = path.relative(relativeRootPath, filePath);
      const parts = relative.split(path.sep);
      skills.push({ path: filePath, id: parts.length > 1 ? parts[0] : path.basename(path.dirname(filePath)) });
    }
  }

  const launchScripts = [];
  for (const filePath of await walkFiles(path.join(root, SCRIPT_ROOT))) {
    if (!/\.(sh|bash|zsh|mjs|js|py)$/.test(filePath)) continue;
    const basename = path.basename(filePath).toLowerCase();
    const body = await fs.readFile(filePath, 'utf8');
    if (/agent|team|omp|zellij|tmux|pi-link/i.test(`${basename}\n${body}`)) {
      launchScripts.push({ path: filePath, id: path.basename(filePath) });
    }
  }

  return {
    root,
    manifest: await loadTeamConfig(root),
    profiles: profiles.sort((a, b) => a.path.localeCompare(b.path)),
    skills: skills.sort((a, b) => a.id.localeCompare(b.id)),
    launchScripts: launchScripts.sort((a, b) => a.path.localeCompare(b.path)),
  };
}

export function validateTeamConfig(config, inventory) {
  const errors = [];
  const warnings = [];
  if (!config || config.version !== 1) errors.push('team config version must be 1');
  if (!config?.team?.name) errors.push('team.name is required');
  if (!config?.team?.group) errors.push('team.group is required');
  if (!config?.roles || Object.keys(config.roles).length === 0) errors.push('roles must contain at least one role');
  if (!config?.hub?.role) errors.push('hub.role is required');
  else if (!config.roles?.[config.hub.role]) {
    errors.push(`hub.role "${config.hub.role}" does not name a configured role`);
  }
  const linkNames = new Map();
  for (const [name, role] of Object.entries(config?.roles ?? {})) {
    if (!role.profile) errors.push(`roles.${name}.profile is required`);
    else if (!inventory.existingPaths.has(role.profile)) errors.push(`roles.${name}.profile is missing: ${role.profile}`);
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
  }
  return { errors, warnings };
}

export function formatTeamReport(result) {
  const lines = [];
  lines.push(`Root: ${result.root}`);
  lines.push(result.manifest ? `Manifest: ${result.manifest.manifestPath}` : 'Manifest: none');
  lines.push(`Profiles (${result.profiles.length}):`);
  for (const profile of result.profiles) lines.push(`  ${profile.id}${profile.role ? ` (${profile.role})` : ''} — ${profile.path}`);
  lines.push(`Skills (${result.skills.length}): ${result.skills.map((skill) => skill.id).join(', ') || 'none'}`);
  lines.push(`Launch scripts (${result.launchScripts.length}):`);
  for (const script of result.launchScripts) lines.push(`  ${script.id} — ${script.path}`);
  return lines.join('\n');
}

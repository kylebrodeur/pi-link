---
name: pi-link-team-setup
description: Discover and configure a repository's Pi/OMP agent team without duplicating existing profiles, skills, launchers, or policy files.
---

# Pi-Link Team Setup

Use this skill when a user asks to discover, define, validate, or start a local Pi/OMP agent team.

## Principles

- Inspect before proposing changes.
- Reuse existing `.omp/agents/`, `.pi/agents/`, `.agents/`, `.omp/skills/`, `skills/`, and `scripts/` artifacts.
- Remember the harness split: OMP loads profiles from `.omp/agents/`, Pi from `.pi/agents/` and the legacy `.agents/`. A profile only registers in the harness whose root it sits in, and `--team` labels each with the harness that resolves it.
- Treat repository policy files such as `AGENTS.md`, handoff docs, and ownership records as authoritative project policy.
- Treat `.pi-link/team.json` as a composition manifest, not a replacement for role prompts or project policy.
- Never overwrite an existing manifest, profile, skill, or launcher without explicit approval.
- Group names scope normal pi-link visibility and routing; they are not authentication.
- A declared coordinator/hub role is a startup convention until the runtime enforces it.
- A capability request cannot grant a tool that Pi/OMP does not expose.
- A profile needs both `name` and `description` in frontmatter to register at all; without them it is inert no matter how correct its path is. `--team` marks these `(INERT: …)` and `--team-check` warns when a declared role points at one.
- Declare `model` in the manifest. It is the primary driver: a declared model wins over the profile's frontmatter, and `--team-run` passes `--model` from it. `--team-check` validates the value against what the harness actually reports.
- The harness matters for launching, not just discovery: `pi` rejects `--link-name`, `--cwd` and `--config`, which `omp` accepts. `--team-run` infers the harness from the repo's profile roots and takes `--harness` to override.

## Discovery workflow

1. Run `pi-link --team` from the repository root.
2. Inspect the discovered profiles, skills, and launch scripts.
3. Read the relevant profile frontmatter and body for each proposed role.
4. Identify an existing coordinator/advisor role if one exists.
5. Identify the intended group name. Prefer a stable project/team slug.
6. Identify required and optional skills from role prompts and repository instructions.
7. Identify tools explicitly used by each role. Do not infer access from a role name.
8. Show the proposed composition to the user before writing anything.

Prefer `pi-link --team-init` over hand-writing the manifest: it derives role paths
from discovery, so a path that does not exist cannot be written. Add `--hub` to
name the coordinator (never let the builder guess between two candidates), then
`--write`. Finish the omitted fields (`cwd`, `sessionDir`, `config`) by hand —
discovery cannot know them, and that is deliberate.

The manifest is load-bearing, not documentation: `pi-link --team-run` launches
from it. A role's prompt comes from the declared `profile` path, so a profile
outside the usual naming convention still resolves. `--team-run --dry-run` first
to see the resolved argv and prompt sizes before anything starts.

## Interactive setup questions

Ask only for information discovery cannot establish:

- What should the team/project be called?
- What group suffix should its terminals use?
- Which role coordinates the team?
- Which discovered roles should be included?
- Which missing skills/tools are required versus optional?
- Should the existing launcher remain authoritative for now?

## Manifest rules

Write `.pi-link/team.json` only after the user confirms the proposal. Reference existing files instead of copying their contents:

```json
{
  "version": 1,
  "team": { "name": "project-name", "group": "project-name" },
  "hub": { "role": "advisor", "mode": "designated" },
  "roles": {
    "advisor": {
      "profile": ".omp/agents/advisor.md",
      "skills": { "required": ["team-workflow"] },
      "tools": { "required": ["read", "link_list", "link_send"], "requestable": ["browser"] }
    }
  }
}
```

After writing, run:

```bash
pi-link --team-check
pi-link --team
```

Report required errors separately from optional warnings. A missing optional skill should not be presented as a startup failure.

## Advisor capability requests

When an advisor asks another agent to load a skill or use a tool:

1. Name the capability exactly.
2. State why it is needed.
3. Ask the recipient to report one of: `available`, `loaded`, `missing`, `denied`, or `requires_user_action`.
4. Do not assume a skill or tool exists because another role has it.
5. Do not tell an agent that a request granted a capability unless the recipient confirms it.

Example request:

```text
Load the `browser-qa` skill and report `loaded` or `missing` before checking the mobile layout.
```

If a tool is not active, the recipient should report that fact and use an approved alternative or stop for user action. Pi-link coordinates the request; Pi/OMP remains authoritative over actual skill loading and tool availability.

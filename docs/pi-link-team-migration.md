# Migrating a repo to `pi-link --team`

Practical migration for an existing multi-agent repo — the kind that already has
a launcher script, agent profiles, and (often) a Zellij or tmux layout. Written
from the two repos we migrated: `folia-app` (six roles) and `enviro-grow-pico`
(four roles, `iot-rig`).

This is an internal document. It is not part of the upstream contribution.

## What `--team` is

Inspection (read-only):

- `--team` discovers the profiles, skills, launch scripts and OMP session configs
  already in a repo, and prints them, plus the declared manifest summary.
- `--team --json` prints the same as JSON for a launcher or CI step.
- `--team-check` validates the declared manifest against what exists. Exit 1 on
  errors, 0 when only warnings fired.

Composition (writes a manifest):

- `--team-init` builds a manifest from discovery and prints it; `--write` creates
  `.pi-link/team.json` and refuses to overwrite an existing one.

Launch (spawns roles):

- `--team-run` launches every role the manifest declares, reading the profile
  path, `cwd`, `sessionDir`, `config` and `linkName` from the manifest.
  `--dry-run` prints the resolved plan — argv, paths and prompt size — without
  spawning anything.

`--team` and `--team-check` remain strictly read-only: they report and never
write. `--team-init` is the only writing mode, and it only writes when asked.
`--team-run` is a launcher.

## Why a manifest that can launch

A manifest that only *describes* a team drifts from whatever actually starts it.
A launcher that hardcodes each role's model, cwd and prompt path is a second
description of the same team, and the two disagree silently.

Real example from this migration: a role file lived at
`.omp/plantfluent-agents/plantfluent-pen-porter.md`, but the launcher derived its
prompt path from a naming convention (`.omp/agents/plantfluent-<role>.md`). That
file did not exist, so the launcher fell back to a placeholder and the role
started with a 19-byte stub prompt instead of its 1.5 KB profile — for months,
without an error. The manifest declared the correct path the whole time. Nothing
read it.

`--team-run` reads the declared path, so that failure cannot recur by
construction.

## Zellij / tmux is a different layer

This trips people up, because both layers talk about "roles" and "the team":

```
Launch layer      how the team RUNS
  .zellij/<name>.kdl              pane layout: which roles, how tiled, focus
  scripts/<name>-agent-layout.sh  generates a filtered layout from --roles
  scripts/<name>-agent-terminal.sh per-role model, cwd, prompt, restart loop
  omp --link-name <role>

Declaration layer   what the team IS
  .pi-link/team.json   the manifest
  pi-link --team       reports it
  pi-link --team-check validates it

Manifest launch     the two layers meeting
  pi-link --team-run   spawns the declared roles directly
```

`--team-run` is an *alternative* to Zellij, not an integration with it: it spawns
one process per role with no panes, tiling or focus. A repo that depends on a
Zellij layout should keep it, and can still add the preflight below. A repo that
only needs the roles running can drop the layout entirely.

`pi-link` contains no reference to Zellij or tmux. Migrating to the manifest
means **adding a manifest**, not changing an existing layout.

The one thing worth adding to a Zellij-based launcher is a preflight, before
Zellij is invoked:

```zsh
# In the start script, before the `exec zellij ...` line.
pi-link --team-check >/dev/null || {
  print -u2 "team manifest invalid — run: pi-link --team-check"
  exit 1
}
```

That turns "a pane died on startup because a profile went missing" into a clear
failure before any pane is created.

## Step 1 — see what discovery already finds

Run this from the repo root with the manifest absent:

```bash
pi-link --team
```

Everything it lists is already there and needs no migration. Check three things:

- **Profiles** — each role's profile, with its `role` and `model` read from
  frontmatter. A role whose profile is missing will not appear (the launcher may
  still handle it with a fallback prompt; discovery will not invent one).
- **Skills** — ids, with a `shadowed:` line when an id appears in more than one
  skill root. See [Skills and install roots](#skills-and-install-roots).
- **Session configs** — the `.omp/*.yml` overlays a launcher passes with
  `--config`.

## Step 2 — write `.pi-link/team.json`

```json
{
  "version": 1,
  "team": { "name": "my-project", "group": "my-project" },
  "hub": { "role": "advisor", "mode": "designated" },
  "roles": {
    "advisor": {
      "profile": ".omp/agents/advisor.md",
      "cwd": ".",
      "sessionDir": ".omp/team-agents/advisor",
      "config": ".omp/advisor-session.yml"
    },
    "builder": {
      "profile": ".omp/agents/builder.md",
      "cwd": "src",
      "sessionDir": ".omp/team-agents/builder",
      "config": ".omp/light-session.yml",
      "skills": { "required": ["team-workflow"], "optional": ["browser-tools"] },
      "tools": { "required": ["read", "link_list", "link_send"] }
    }
  }
}
```

### Field reference

Top level: `version` (must be `1`), `team.name`, `team.group`, `hub.role`.
`hub.role` must name a role in `roles`. `hub.mode` is carried but not validated —
any value is accepted, including a typo, so it currently documents intent only.

Per role:

| Key | Kind | Rule |
|---|---|---|
| `profile` | file | **Required.** Repo-relative. |
| `prompt` | file | Optional. Must exist. |
| `config` | file | Optional. Must exist. |
| `cwd` | dir | Optional. **Must already exist.** |
| `sessionDir` | dir | Optional. Need not exist — created on first launch. |
| `linkName` | string | Optional. Two roles may not share one. |
| `skills.required` | string[] | Missing → **error**. |
| `skills.optional` | string[] | Missing → **warning**. |
| `tools.*` | string[] | Declared intent only; never granted. |

Aliases accepted: `requiredSkills`, `optionalSkills`, `requiredTools`,
`requestableTools`, `deniedTools`.

### `cwd` vs `sessionDir` — the one non-obvious rule

`cwd` must already exist: a role cannot start in a directory that is not there.

`sessionDir` is different — launchers create it (`mkdir -p`) before first use, so
a missing one is **normal on a clean checkout** and warns rather than failing.

Getting this backwards makes `--team-check` fail on a fresh clone.

### Paths are repo-relative

Every path resolves against the repo root, so a manifest never carries an
absolute path that works on one machine only.

## Step 3 — validate, then wire in the preflight

```bash
pi-link --team-check
```

Iterate until it exits 0. The two warnings you should expect on a clean checkout
are `sessionDir does not exist yet` and any shadowed skill.

Then add the preflight from above to your start script if you want the gate.

## Skills and install roots

Skill discovery spans three roots, in this order:

```
.omp/skills      .agents/skills      skills
```

The last two are different things and both are legitimate:

- **`skills/`** — tracked source you author, often distributed via `npx skills`.
- **`.agents/skills/`** — a *local install* of those skills, normally gitignored
  alongside `skills-lock.json`.

The same id in both is the **normal source-to-install relationship**, not a
mistake. `--team-check` warns rather than failing, because it is still worth
knowing: an install not refreshed after source edits goes stale silently.

If you see the warning and the install is current, ignore it. If it is stale,
re-run your skill installer.

## Migration from pre-release builds of this branch

Only relevant if you ran an early build from `feat/team-setup-discovery`.

### The interface moved from a subcommand to flags

| Old | New |
|---|---|
| `pi-link team discover` | `pi-link --team` |
| `pi-link team show` | `pi-link --team` (the summary is always printed) |
| `pi-link team explain` | `pi-link --team` |
| `pi-link team check` | `pi-link --team-check` |

`discover` and `explain` were identical, and `show` differed only by the manifest
summary, so four subcommands became two flags.

**Why it changed.** A `team` subcommand captured a session literally named
`team`, making it unreachable — the same reserved-word collision upstream removed
in 0.1.15 when `list` and `resolve` became flags. Verify the fix:

```bash
pi-link team my-session   # must NOT print a --team usage error
```

### The manifest moved from YAML to JSON

`.pi-link/team.yml` and `.yaml` are no longer read. Rename to `.pi-link/team.json`
and convert:

```yaml
version: 1
team:
  name: demo
  group: demo
```

```json
{
  "version": 1,
  "team": { "name": "demo", "group": "demo" }
}
```

JSON needs no parser dependency, so pi-link keeps its single runtime dependency
(`ws`). Profile frontmatter keeps its YAML-shaped `key: value` scalars, read by
hand — that is a frontmatter concern, not a manifest one.

## Installing and testing before you commit to it

The CLI works with no install at all — run it by path:

```bash
node /path/to/pi-link/bin/pi-link.mjs --team
```

To test as a plugin without disturbing an existing install, use an isolated OMP
profile. A `#branch` spec pulls the **pushed** tip, not local commits:

```bash
omp --profile team-test plugin install \
  'git:github.com/kylebrodeur/pi-link#feat/team-setup-discovery'
omp --profile team-test plugin list      # only pi-link
omp plugin list                          # default profile unchanged
```

A local-path install symlinks the checkout instead, so committed edits appear
without reinstalling:

```bash
omp --profile team-test plugin install /path/to/pi-link
readlink ~/.omp/profiles/team-test/plugins/node_modules/pi-link
```

Cleanup is deleting the profile directory:

```bash
rm -rf ~/.omp/profiles/team-test
```

## What still duplicates after migrating

Be honest about this: the manifest **does not remove duplication**, it makes
breakage visible. A launcher's `case` block still states a model and a cwd that
the profile frontmatter may also state. `folia-app` carries the model in both,
and they agree today with nothing enforcing it.

What the manifest catches is the failure, not the redundancy: a profile deleted,
a session dir claimed by two roles, a required skill removed, a `cwd` that moved.

Closing the duplication means having the launcher read `model` from the profile
frontmatter it already parses instead of a `case` block — a small change to the
launcher, and a separate one from this migration.

## Checklist

```
[ ] pi-link --team            runs, lists what you expect
[ ] .pi-link/team.json        written, one role per real role
[ ] cwd values exist          (sessionDir need not)
[ ] pi-link --team-check      exit 0
[ ] warnings reviewed         shadowed skill, new sessionDirs
[ ] preflight added           optional, before the zellij/tmux exec
[ ] launcher still works      ./scripts/start-<team>-agents.sh unchanged
```

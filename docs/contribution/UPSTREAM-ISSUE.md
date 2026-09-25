# Upstream issue draft — team composition discovery for `pi-link`

Status: **draft, not filed.** For review before anything is sent to `alvivar/pi-link`.

Target repo: https://github.com/alvivar/pi-link
Proposed title: **Team composition is undeclared: discovery, validation, and setup for multi-terminal fleets**

---

## Summary

`pi-link` handles *transport* well — terminals find each other, send, list, and compact.
What it does not have is any notion of a **team**: which terminals a given repo expects,
which role each one plays, which one coordinates, and which skills/tools each role needs
before it can do its job.

In practice that composition is re-invented per repository as a set of launch scripts,
a hand-written prompt per terminal, and tribal knowledge about who talks to whom. When a
new repo adopts the pattern, or an existing one onboards a contributor, there is nothing to
check against: a typo'd profile path or a renamed skill fails at runtime, in the middle of a
run, as a tool error or silence, rather than before anything starts.

This issue proposes a small, additive, read-only **discovery + validation** surface, and asks
whether upstream wants it (and in what shape) before a PR.

## Use cases (concrete)

The maintainer asked for practical use cases on a previous PR, so leading with them.

**1. Onboard a repo you did not build.**
Clone a repo that uses linked agents. Today: read `AGENTS.md`, find the launch script, guess
which terminal coordinates, guess which skills matter. With discovery: one command lists the
profiles that exist, the skills they reference, the launch scripts present, and reports which
referenced paths are already missing. You know what you are walking into before starting N
terminals.

**2. Catch a broken reference before starting the fleet.**
Someone renames `skills/team-workflow/` or moves `advisor.md`. Today that surfaces mid-run as a
worker silently lacking a capability. With validation: `check` exits non-zero and names the
offending role and path, before any terminal starts.

**3. Make the fleet's shape reviewable.**
A declared manifest is a reviewable artifact. A diff to team composition shows up as a diff,
the way a CI matrix or a docker-compose file does — instead of being spread across prose and
shell scripts.

**4. Give an advisor a factual basis for delegation.**
An advisor deciding what to hand to whom currently reasons from prose. A declared
role → skills/tools mapping lets it check "does this worker actually have the browser tool"
instead of assuming from a role name.

**5. Stop re-writing the same bootstrap per repo.**
Every repo using the pattern writes its own launcher and prompt scaffolding. A shared,
declared composition means the per-repo part is only the genuinely project-specific policy.

## Proposed scope (if upstream wants it)

A CLI surface — **read-only first** — that:

- discovers existing artifacts rather than owning them: `.omp/agents/`, `.agents/`,
  `.omp/skills/`, `.agents/skills/`, `skills/`, `scripts/`
- reads an optional declared composition at `.pi-link/team.json`
- normalizes and validates it: referenced profiles exist, referenced skills exist,
  a coordinator role is declared and names a real role, declared terminal names do not collide
- reports required *errors* separately from optional *warnings*
- exits non-zero on error, so it can gate a launcher or CI

The surface is two flags, matching the convention upstream already established for
`--list`, `--status` and `--resolve`:

```text
pi-link --team         # discovery report + declared manifest summary
pi-link --team --json  # the same report, machine-readable for launchers/CI
pi-link --team-check   # validate only; exit 1 on errors
```

Composition is deliberately a **thin manifest that references** existing files — never a copy
of role prompts, skills, or project policy. Repository policy files keep their authority.

Sketch:

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

## Explicit non-goals

- No new transport, no remote/LAN mode, no authentication. The existing localhost trust
  boundary and the existing group rule are unchanged.
- No replacing or reimplementing group scoping. (That landed in 0.5.0 and is untouched.)
- No process lifecycle in the first cut: no `--team-start` that spawns terminals.
- No capability granting. A manifest *declares intent*; Pi/OMP stays authoritative over what
  tools and skills actually exist at runtime.
- No second message bus. Everything rides existing `link_send` semantics.

## Design decisions

Both of the questions we flagged in the first draft are now settled in the implementation
below. Neither needs a maintainer answer before review; both are easy to reverse if upstream
disagrees.

### 1. We use the flag form, not a subcommand

Upstream deliberately **removed** the `list` / `resolve` subcommands in favor of `--list` /
`--resolve` flags, specifically because the subcommand form made sessions named `list` or
`resolve` unreachable (0.1.15 changelog: *"This fixes the reserved-word collision that
prevented sessions named `list` or `resolve`…"*).

A `pi-link team …` subcommand reintroduces exactly that collision. We verified it against the
first prototype, where `team` was a subcommand:

```text
pi-link team              -> exit 64, usage error   (should resolve the session "team")
pi-link team my-session   -> exit 64, usage error   (should open "my-session")
```

**We changed it to flags** rather than argue for our shape. `pi-link team` now resolves a
session named `team` again, and `--team` / `--team-check` join `--list`, `--status` and
`--resolve` as modes. This is a design choice we made, not an open question — if upstream
would rather have a subcommand, the change is contained to the arg parser.

### 2. Manifest format — we chose JSON-only to keep the single dependency

`package.json` declares exactly one runtime dependency (`ws`), and the README documents
that as deliberate: *"At runtime pi-link needs one package, `ws`."* Reading a manifest
therefore has a real cost, and we weighed three options:

| Option | Trade-off |
|---|---|
| YAML via `yaml` | human-authored config, but a second runtime dep |
| **JSON only** | **zero new deps, matches pi-link's existing JSON surfaces, no comments** |
| Restricted hand-rolled YAML | zero deps, but silently unsupported syntax (we built and then rejected this) |

**We ship JSON-only.** It needs no parser dependency, and it matches the configuration
surface pi-link already has: `settings.json`, session entries, `package.json`, the hub
status payload, and the wire protocol are all JSON. Profile frontmatter keeps its
YAML-shaped `key: value` scalars, read by hand the way Pi's own subagent tooling reads
them — that is a frontmatter concern, not a manifest one.

If upstream would rather have YAML and is willing to take the dependency, the format is a
small change; everything else in the prototype is unaffected.

### Also worth deciding

- Manifest location: `.pi-link/team.json` vs a root-level file vs Pi-native config.
- Whether `link_list` should eventually surface declared-vs-actual role, or whether that is
  scope creep.

## Reference implementation

Available for review on a fork branch, with tests:

https://github.com/kylebrodeur/pi-link/tree/feat/team-setup-discovery

Read-only flags only (`--team`, `--team --json`, `--team-check`), a companion skill, and
Node's built-in test runner. Not opened as a PR yet.

## Why not just a local convention?

A per-repo launcher plus a README section is what we have today, and it is what every repo
reinvents. The value here is a *shared, checkable* declaration, not a new capability — the
transport already does the hard part.

# Pi-Link Team Setup Implementation Plan

> **For agentic workers:** Implement this plan task-by-task with focused verification after each task. Preserve the existing pi-link CLI, group routing, and repository-specific launchers until a migration is explicitly approved.

**Goal:** Extend pi-link with discovery, validation, and gradual setup of repository-defined Pi/OMP agent teams without duplicating existing profiles, skills, tools, or project policy.

**Architecture:** Add a small team-config library under the existing `bin/` CLI boundary, used by additive `pi-link team` commands. The library discovers existing repository artifacts and validates a `.pi-link/team.yml`/`.yaml`/`.json` composition manifest. Existing agent profiles remain authoritative for role prompts and model data; Pi/OMP remains authoritative over actual runtime tools and skills; existing pi-link group routing remains unchanged.

**Tech Stack:** Node.js ESM CLI, JSON, YAML via a direct runtime dependency selected after parser verification, Node built-in test runner, Markdown skills.

**Spec:** The reviewed design in the conversation preceding this plan: single-machine local teams, discovery first, manifest validation, capability reporting, advisor requests later, no remote transport/authentication in this sequence.

## Global Constraints

- Existing pi-link session/list/status/resolve commands must remain behaviorally compatible.
- Existing `groupOf()`, `visibleTerminals()`, `targetNotFound()`, and `routeMessage()` behavior is not replaced by this work.
- Discovery is read-only; initialization must ask before writing or overwriting.
- Repository profiles, skills, handoffs, ownership rules, and verification commands remain repository-owned.
- A manifest declares intended capabilities; Pi/OMP remains authoritative over actual tool and skill availability.
- No LAN/Tailscale transport, authentication, formal security permissions, or distributed leader election is included in this sequence.
- Published npm contents must include every runtime import used by `bin/pi-link.mjs`.

---

## Task 1: Stabilize the discovery slice

**Files:**
- Modify: `package.json` — add the chosen YAML parser dependency; keep the existing `files` allowlist unchanged because the helper lives under `bin/`.
- Modify: `package-lock.json` — lock the runtime dependency.
- Modify: `bin/team-config.mjs` — replace the restricted YAML parser with the selected parser API; retain JSON support.
- Modify: `README.md` — add team discovery/manifest documentation without replacing existing sections.
- Modify: `test/team-config.test.mjs` — cover real YAML features accepted by the parser.
- Modify: `test/cli-team.test.mjs` — add packed-artifact smoke coverage if practical.

**Decision:** The Pi runtime currently has `yaml` 2.8.3 installed, but pi-link is independently published and cannot rely on another extension's transitive dependency. `pi-agent-bus` independently declares `js-yaml` as a direct dependency and parses Markdown frontmatter with it. Use a direct pi-link runtime dependency rather than a hidden reliance on Pi/OMP installation. Prefer the already-proven `yaml` package/API if package compatibility and lockfile resolution are straightforward; otherwise use direct `js-yaml` following agent-bus.

**Steps:**

- [ ] Keep the existing `package.json.files` allowlist; do not add a new top-level package boundary.
- [ ] Add the chosen YAML library to `dependencies`.
- [ ] Replace the hand-rolled parser.
- [ ] Add a YAML fixture containing quoted strings, nested objects, arrays, and a multiline instruction.
- [ ] Run `node --test test/team-config.test.mjs test/cli-team.test.mjs` and confirm the tests pass.
- [ ] Run `npm pack --dry-run` and confirm both `bin/pi-link.mjs` and `bin/team-config.mjs` are listed.
- [ ] Pack into a temporary directory and run the packaged `bin/pi-link.mjs --version` and `team discover` commands.
- [ ] Add the README section documenting commands and manifest ownership.
- [ ] Commit as `feat: stabilize pi-link team discovery`.

**Acceptance:** Existing CLI behavior still passes its focused smoke checks; YAML parsing is standards-based; the packed npm artifact contains the existing `bin` and `skills` trees, including both CLI modules; discovery and validation work from both the checkout and packed artifact.

## Task 2: Add manifest proposal mode

**Files:**
- Modify: `bin/team-config.mjs` — add deterministic proposal generation from discovered profiles/skills/scripts.
- Modify: `bin/pi-link.mjs` — add `pi-link team init --dry-run`.
- Create: `test/team-init.test.mjs`.
- Modify: `README.md` — document proposal behavior.

**Interface:**

```js
proposeTeamConfig(inventory, options) -> TeamConfig
formatTeamConfig(config) -> string
```

The proposal must identify likely coordinator roles only from explicit profile metadata or conservative name matches such as `advisor`; ambiguous cases remain unset and are reported.

**Acceptance:** `team init --dry-run` is read-only, deterministic, includes existing profile/skill paths, never overwrites a manifest, and reports ambiguous coordinator/group choices.

## Task 3: Add confirmed manifest initialization

**Files:**
- Modify: `bin/pi-link.mjs` — add interactive `pi-link team init`.
- Modify: `bin/team-config.mjs` — add safe manifest write helper.
- Create: `test/team-init-write.test.mjs`.

**Interface:**

```js
writeTeamConfig(root, config, { force?: boolean }) -> Promise<string>
```

**Acceptance:** Existing manifests are never overwritten without explicit `--force`/confirmation; paths are repository-relative where possible; generated YAML remains readable; writing is limited to `.pi-link/team.yml`.

## Task 4: Add profile and capability inventory

**Files:**
- Modify: `bin/team-config.mjs` — parse recognized Markdown frontmatter and manifest capability declarations.
- Modify: `bin/pi-link.mjs` — show per-role profile/model/role/skill/tool state.
- Create: `test/team-capabilities.test.mjs`.
- Modify: `skills/pi-link-team-setup/SKILL.md` — document capability state semantics.

```text
present, missing, optional-missing, requestable, denied, unknown
```

**Acceptance:** `team show` distinguishes required from optional missing capabilities and never claims a tool is active solely because it is listed in a manifest.

## Task 5: Add live capability advertisement

**Files:**
- Modify: `index.ts` — extend optional register/welcome/status metadata with capability snapshots while preserving old-client compatibility.
- Modify: `skills/pi-link-tools/SKILL.md` — document capability fields and absent-data behavior.
- Create/modify: focused protocol tests if the repository gains a test harness for this path.

**Interface:**

```ts
type CapabilitySnapshot = {
  profile?: string;
  role?: string;
  skills?: string[];
  tools?: string[];
};
```

**Acceptance:** Missing capability metadata is tolerated; existing clients still connect; new clients can report their baseline profile/role/skill/tool information without changing group routing.

## Task 6: Add structured capability requests

**Files:**
- Modify: `index.ts` — add request/response envelope handling over existing direct messages.
- Modify: `skills/pi-link-tools/SKILL.md` — document request IDs, response states, and runtime authority.
- Create: focused protocol tests.

**Envelope:**

```json
{
  "kind": "capability_request",
  "requestId": "req-123",
  "action": "load_skill|check_tool|report_capabilities",
  "name": "browser-qa",
  "reason": "Verify mobile layout"
}
```

**Responses:** `available`, `loaded`, `missing`, `denied`, `requires_user_action`, `timeout`.

**Acceptance:** Requests correlate by ID, ordinary text messages remain unchanged, and requests cannot grant tools or skills without Pi/OMP confirmation.

## Task 7: Add team start dry-run

**Files:**
- Modify: `lib/team-config.mjs` — create a launch plan from manifest roles.
- Modify: `bin/pi-link.mjs` — add `pi-link team start --dry-run`.
- Create: `test/team-start.test.mjs`.
- Modify: `README.md` — document migration from existing launch scripts.

**Acceptance:** The dry-run identifies coordinator-first ordering, selected roles, session directories, profile prompts, and existing launch-script overlap. It does not spawn processes or modify files.

## Task 8: Add team process lifecycle

**Files:**
- Modify: `bin/pi-link.mjs` — add `team start`, `team stop`, and `team reset` only after dry-run behavior is stable.
- Modify: `lib/team-config.mjs` — execute the previously verified launch plan.
- Create: focused lifecycle tests using fake launch commands.

**Acceptance:** Role selection, fresh/reset scope, coordinator-first startup, crash/exit reporting, and stop behavior are deterministic. Existing repository launchers remain usable during migration.

## Verification gates

After each task:

```bash
node --test <focused tests>
node --check bin/pi-link.mjs
node bin/pi-link.mjs --version
```

Before merging the complete feature:

```bash
npm pack --dry-run
npm test  # only if a repository test script exists by then
```

Also verify against representative repository patterns from Enviro Grow, Folia, Slate, and pi-agent-bus without modifying those repositories.

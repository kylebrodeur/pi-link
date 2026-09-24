# `pi-link team` Runbook

How to test the new `pi-link team` discovery commands **without touching any currently
installed pi-link**, and how to promote the work if it looks right.

## What this adds

Additive CLI subcommands. Nothing in the existing pi-link contract changes:

```text
pi-link team discover   # list profiles, skills, launch scripts, manifest
pi-link team show       # discover + parsed manifest summary
pi-link team explain    # human-readable discovery report
pi-link team check      # validate manifest, exit 1 on errors
```

Existing commands (`--version`, `--list`, `--status`, `--resolve`, `<session-name>`)
behave exactly as before.

## Isolation guarantee

All testing runs the CLI **directly out of the git worktree**:

```text
/private/tmp/pi-link-team-setup/bin/pi-link.mjs
```

That is a path invocation (`node <path>`), not the installed `pi-link` binary. It:

- does **not** install to npm global,
- does **not** modify `~/.pi/agent/settings.json`,
- does **not** shadow a `pi-link` on `PATH`,
- does **not** require `npm link`,
- only **reads** a target repo's `.pi-link/`, `.omp/`, `.agents/`, `skills/`, `scripts/`.

The only writes anywhere in this runbook happen inside throwaway `/private/tmp`
sandboxes, which you can delete at any time.

## Prerequisites

Node 20+ (this box runs v22.23.2). Install the one runtime dependency in the worktree:

```bash
cd /private/tmp/pi-link-team-setup
npm install --omit=dev
```

`yaml` (^2.9.x) is the real YAML parser; it is declared in `package.json` and locked.

## Step 1 — Confirm the worktree CLI runs

```bash
cd /private/tmp/pi-link-team-setup
node bin/pi-link.mjs --version          # prints 0.5.1
node bin/pi-link.mjs team discover      # "Manifest: none" is correct in the pi-link repo itself
```

The second command reports the pi-link repo's own artifacts — it has no `.pi-link/team.yml`,
so `Manifest: none` is the expected result.

## Step 2 — Build a sandbox repo

```bash
SB=/private/tmp/pi-link-team-e2e
rm -rf "$SB"
mkdir -p "$SB/.omp/agents" "$SB/.omp/skills/team-workflow" "$SB/scripts" "$SB/.pi-link"

printf -- '---\nrole: coordinator\nmodel: glm-5.3\n---\nYou coordinate.\n' > "$SB/.omp/agents/advisor.md"
printf -- '---\nrole: member\n---\nYou build.\n'                        > "$SB/.omp/agents/builder.md"
printf '# Team Workflow\n'                                              > "$SB/.omp/skills/team-workflow/SKILL.md"
printf '#!/bin/sh\necho start\n'                                        > "$SB/scripts/start-team.sh"

cat > "$SB/.pi-link/team.yml" <<'YAML'
version: 1
team:
  name: e2e
  group: e2e
hub:
  role: advisor
  mode: designated
roles:
  advisor:
    role: coordinator
    profile: .omp/agents/advisor.md
    summary: "Coordinate: keep peers unblocked"
    skills:
      required: [team-workflow]
    tools:
      required: [read, link_list, link_send]
      requestable:
        - browser
  builder:
    role: member
    profile: .omp/agents/builder.md
    instructions: |
      Build the thing.
      Then verify it.
YAML
```

## Step 3 — Exercise the commands

```bash
CLI=/private/tmp/pi-link-team-setup/bin/pi-link.mjs
cd /private/tmp/pi-link-team-e2e

node "$CLI" team discover    # lists 2 profiles, 1 skill, 1 launch script
node "$CLI" team show        # adds Team/Group/Hub role + role lines
node "$CLI" team explain     # report only
node "$CLI" team check       # "Team manifest valid: .../team.yml", exit 0
```

Every command must exit `0` on this sandbox.

## Step 4 — Confirm validation actually rejects bad input

```bash
B=/private/tmp/pi-link-team-neg
rm -rf "$B"; mkdir -p "$B/.pi-link" "$B/.omp/agents"
printf -- '---\nrole: member\n---\n' > "$B/.omp/agents/advisor.md"

# 4a. Missing profile file -> exit 1
cat > "$B/.pi-link/team.yml" <<'YAML'
version: 1
team: { name: neg, group: neg }
hub: { role: advisor, mode: designated }
roles:
  advisor:
    role: coordinator
    profile: .omp/agents/does-not-exist.md
YAML
(cd "$B" && node "$CLI" team check); echo "exit=$?"   # ERROR ... profile is missing / exit=1

# 4b. No hub at all -> exit 1
cat > "$B/.pi-link/team.yml" <<'YAML'
version: 1
team: { name: neg, group: neg }
roles:
  advisor:
    role: coordinator
    profile: .omp/agents/advisor.md
YAML
(cd "$B" && node "$CLI" team check); echo "exit=$?"   # ERROR hub.role is required / exit=1

# 4c. Malformed YAML -> clean error, exit 1 (no stack trace)
cat > "$B/.pi-link/team.yml" <<'YAML'
version: 1
roles:
  advisor:
    profile: [
YAML
(cd "$B" && node "$CLI" team check); echo "exit=$?"
# ERROR failed to read team manifest: <yaml message> / exit=1
```

## Step 5 — Verify the packed artifact (packaging regression guard)

This is the check that catches a helper file being excluded from the npm tarball.

```bash
cd /private/tmp/pi-link-team-setup
PKG=$(npm pack --silent | tail -1)
tar -tzf "$PKG" | sort                      # must include bin/pi-link.mjs AND bin/team-config.mjs

D=$(mktemp -d); tar -xzf "$PKG" -C "$D"
(cd "$D/package" && npm install --omit=dev --silent)
(cd /private/tmp/pi-link-team-e2e && node "$D/package/bin/pi-link.mjs" team check)
# "Team manifest valid: ..." -> the packed CLI resolves yaml standalone
rm -rf "$D"; rm -f "$PKG"
```

## Step 6 — Unit tests

```bash
cd /private/tmp/pi-link-team-setup
node --test test/team-config.test.mjs test/cli-team.test.mjs   # 8 pass
node --check bin/pi-link.mjs && node --check bin/team-config.mjs
```

## Cleanup

```bash
rm -rf /private/tmp/pi-link-team-e2e /private/tmp/pi-link-team-neg /private/tmp/pi-link-team-*
```

Removing the worktree does not affect the branch (commits live in git).

## Promoting the work

Nothing here has touched `master` or any installed copy. When you are satisfied:

```bash
cd /Users/kylebrodeur/workspace/pi-link
git merge feat/team-setup-discovery      # fast-forwardable from master@a7c1851
git push origin master
```

Only then does anything become permanent. Publishing to npm is a separate, explicit step.

## Known state / caveats

- `link_prompt` is **not** registered in this checkout. The four-tool set present is
  `link_send`, `link_compact`, `link_list` (all `loadMode: "essential"` via
  `TOP_LEVEL_TOOL`), plus `link_prompt` is absent from `index.ts` entirely.
  That is pre-existing in the branch base, unrelated to the team commands.
- There is an untracked stray file at
  `/Users/kylebrodeur/workspace/pi-link/bin/team-config.mjs` (31KB, a near-duplicate of the
  CLI) in the **main** checkout. It is not part of this branch and was left untouched.

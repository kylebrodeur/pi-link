# `pi-link --team` Runbook

Test the new `pi-link --team` discovery flags **without touching the pi-link you already
have installed**.

## What is currently installed (verified on this machine)

```text
omp 18.2.1                        /Users/kylebrodeur/.local/bin/omp
pi  0.84.4                        node v22.23.2 global
pi-link@0.5.1                     npm plugin, enabled in OMP's DEFAULT profile
  path: ~/.omp/plugins/node_modules/pi-link
```

Confirm before you start:

```bash
omp plugin list
# npm Plugins:
#   ● pi-context@2.1.2
#   ● pi-link@0.5.1      <-- the install we must not disturb
#   ● superpowers@6.3.0
```

`pi-link` is **not** in Pi's package list, and there is no `pi-link` on `PATH`. Only OMP's
default profile has it.

## What this adds

Additive CLI modes. No existing pi-link contract changes, and no session name is captured:

```text
pi-link --team         # discovery report + declared manifest summary
pi-link --team --json  # the same report, machine-readable
pi-link --team-check   # validate manifest, exit 1 on errors
```

The flag form is required, not cosmetic: a `team` subcommand would make a session named
`team` unreachable — the same reserved-word collision upstream removed in 0.1.15 by
deleting the `list` and `resolve` subcommands.

## Isolation model — three independent layers

There are three safe ways to test, in order of preference. **Layer 1 is the important one.**

### Layer 1 — OMP profile isolation (recommended, fully verified)

`omp --profile <name>` gives a completely separate plugin tree:
`~/.omp/profiles/<name>/plugins/`. Verified fact: a fresh profile reports
`No plugins installed` even though the default profile has three.

```bash
# Prove the default install is untouched before/after
omp plugin list                       # 3 plugins incl. pi-link@0.5.1

# Install the branch into a throwaway profile (github method, branch ref works here)
omp --profile runbook-test plugin install \
  'git:github.com/kylebrodeur/pi-link#feat/team-setup-discovery'

# The profile sees only itself ...
omp --profile runbook-test plugin list          # just pi-link
# ... and the default profile is unchanged
omp plugin list                                 # still pi-context, pi-link, superpowers

# Landed here, isolated:
#   ~/.omp/profiles/runbook-test/plugins/node_modules/pi-link

# Cleanup
rm -rf ~/.omp/profiles/runbook-test
```

A local-path variant works too and is faster while iterating — it **symlinks** the worktree,
so your committed edits show up immediately with no reinstall:

```bash
omp --profile runbook-test plugin install /Users/kylebrodeur/workspace/pi-link
# ✔ Linked pi-link from /Users/kylebrodeur/workspace/pi-link
readlink ~/.omp/profiles/runbook-test/plugins/node_modules/pi-link
# -> /Users/kylebrodeur/workspace/pi-link
```

### Layer 2 — Pi project-local install

Pi supports `-l` for project scope, which writes only `<cwd>/.pi/settings.json`.
Verified: global Pi settings stayed clean (`pi-link in global: false`).

```bash
mkdir -p /private/tmp/pi-scope && cd /private/tmp/pi-scope
pi install -l --approve /Users/kylebrodeur/workspace/pi-link
# writes .pi/settings.json -> {"packages":["../../pi-link-team-setup"]}

rm -rf /private/tmp/pi-scope     # cleanup is just deleting the directory
```

**Pi's github method is default-branch only.** Verified: `git:github.com/kylebrodeur/pi-link`
clones `master` (commit `a7c1851`) and does **not** understand `#branch` — it fails with
`is this a git repository?`. So for Pi, either merge the branch to master first, or use the
local-path form above.

### Layer 3 — direct path invocation (no install at all)

Every command works with zero installation:

```bash
CLI=/Users/kylebrodeur/workspace/pi-link/bin/pi-link.mjs
node "$CLI" --team
```

This touches nothing: no npm global, no OMP profile, no Pi settings, no `PATH`.

## Prerequisites

```bash
cd /Users/kylebrodeur/workspace/pi-link
npm install --omit=dev      # installs `ws`, the only runtime dep
```

## Step 1 — sanity checks

```bash
cd /Users/kylebrodeur/workspace/pi-link
node bin/pi-link.mjs --version          # 0.5.1
node --test test/team-config.test.mjs test/cli-team.test.mjs   # 13 pass
node --check bin/pi-link.mjs && node --check bin/team-config.mjs
```

## Step 2 — build a sandbox repo

```bash
SB=/private/tmp/pi-link-team-e2e
rm -rf "$SB"
mkdir -p "$SB/.omp/agents" "$SB/.omp/skills/team-workflow" "$SB/scripts" "$SB/.pi-link"

printf -- '---\nrole: coordinator\nmodel: glm-5.3\n---\nYou coordinate.\n' > "$SB/.omp/agents/advisor.md"
printf -- '---\nrole: member\n---\nYou build.\n'                          > "$SB/.omp/agents/builder.md"
printf '# Team Workflow\n'                                                > "$SB/.omp/skills/team-workflow/SKILL.md"
printf '#!/bin/sh\necho start\n'                                          > "$SB/scripts/start-team.sh"

cat > "$SB/.pi-link/team.json" <<'JSON'
{
  "version": 1,
  "team": { "name": "e2e", "group": "e2e" },
  "hub": { "role": "advisor", "mode": "designated" },
  "roles": {
    "advisor": {
      "role": "coordinator",
      "profile": ".omp/agents/advisor.md",
      "summary": "Coordinate: keep peers unblocked",
      "skills": { "required": ["team-workflow"] },
      "tools": {
        "required": ["read", "link_list", "link_send"],
        "requestable": ["browser"]
      }
    },
    "builder": {
      "role": "member",
      "profile": ".omp/agents/builder.md",
      "instructions": "Build the thing.\nThen verify it."
    }
  }
}
JSON
```

## Step 3 — exercise the commands

```bash
CLI=/Users/kylebrodeur/workspace/pi-link/bin/pi-link.mjs
cd /private/tmp/pi-link-team-e2e

node "$CLI" --team           # 2 profiles, 1 skill, 1 launch script + manifest summary
node "$CLI" --team --json    # same report, machine-readable
node "$CLI" --team-check     # "Team manifest valid: ...", exit 0
```

## Step 4 — validation must reject bad input

```bash
B=/private/tmp/pi-link-team-neg
rm -rf "$B"; mkdir -p "$B/.pi-link" "$B/.omp/agents"
printf -- '---\nrole: member\n---\n' > "$B/.omp/agents/advisor.md"

# 4a. missing profile file -> exit 1
cat > "$B/.pi-link/team.json" <<'JSON'
{
  "version": 1,
  "team": { "name": "neg", "group": "neg" },
  "hub": { "role": "advisor", "mode": "designated" },
  "roles": {
    "advisor": { "role": "coordinator", "profile": ".omp/agents/does-not-exist.md" }
  }
}
JSON
(cd "$B" && node "$CLI" --team-check); echo "exit=$?"   # ERROR ... missing / exit=1

# 4b. no hub at all -> exit 1
cat > "$B/.pi-link/team.json" <<'JSON'
{
  "version": 1,
  "team": { "name": "neg", "group": "neg" },
  "roles": {
    "advisor": { "role": "coordinator", "profile": ".omp/agents/advisor.md" }
  }
}
JSON
(cd "$B" && node "$CLI" --team-check); echo "exit=$?"   # ERROR hub.role is required / exit=1

# 4c. malformed JSON -> clean error, exit 1 (no stack trace)
cat > "$B/.pi-link/team.json" <<'JSON'
{ "version": 1, "roles": { "advisor": { "profile": [
JSON
(cd "$B" && node "$CLI" --team-check); echo "exit=$?"   # ERROR team manifest is not valid JSON / exit=1
```

## Step 5 — packed artifact guard

Catches a helper being excluded from the npm tarball.

```bash
cd /Users/kylebrodeur/workspace/pi-link
PKG=$(npm pack --silent | tail -1)
tar -tzf "$PKG" | sort          # must list bin/pi-link.mjs AND bin/team-config.mjs
D=$(mktemp -d); tar -xzf "$PKG" -C "$D"
(cd "$D/package" && npm install --omit=dev --silent)
(cd /private/tmp/pi-link-team-e2e && node "$D/package/bin/pi-link.mjs" --team-check)
rm -rf "$D"; rm -f "$PKG"
```

## Cleanup

```bash
rm -rf /private/tmp/pi-link-team-e2e /private/tmp/pi-link-team-neg
rm -rf /private/tmp/pi-scope
rm -rf ~/.omp/profiles/<profile-name>
omp plugin list        # confirm still pi-context, pi-link@0.5.1, superpowers
```

## Promoting the work

Nothing above changes `master` or the installed pi-link. To ship:

```bash
cd /Users/kylebrodeur/workspace/pi-link
git merge feat/team-setup-discovery    # fast-forwardable from a7c1851
git push origin master
```

For Pi users to get the team commands via the github method, the code must be on `master`
(Pi clones the default branch only). OMP can pin the branch ref directly.

## Verified facts this runbook depends on

| Claim | How it was verified |
|---|---|
| OMP default profile has `pi-link@0.5.1` | `omp plugin list` |
| OMP profiles isolate plugins | fresh profile reported `No plugins installed` |
| Installing into a profile leaves default untouched | `omp plugin list` identical before/after |
| `omp` accepts `#branch` in a git spec | `git:...pi-link#feat/team-setup-discovery` installed fine |
| `omp` local-path install symlinks | `readlink` → `/Users/kylebrodeur/workspace/pi-link` |
| Pi `-l` writes project-local settings only | `.pi/settings.json` written; global stayed `false` |
| Pi github method ignores `#branch` | failed `is this a git repository?`; plain URL cloned `master` |
| Installed `pi-link@0.5.1` lacks team code | `bin/` had only `pi-link.mjs` |

## Known state

- `link_prompt` does **not** exist here. Upstream removed it in 0.3.0 (released in the
  project changelog): the tool, `prompt_request`/`prompt_response` wire messages, pending
  state and timeouts are gone. Registered tools are `link_send`, `link_compact`, `link_list`,
  all carrying `loadMode: "essential"` via `TOP_LEVEL_TOOL`.
- The branch is pushed to `origin/feat/team-setup-discovery` at `78f9db8`.
- There is an untracked stale CLI copy at
  `/Users/kylebrodeur/workspace/pi-link/bin/team-config.mjs` (31,296 B, byte-identical to the
  branch revision `92791f3:bin/pi-link.mjs`). It is redundant with git; left untouched.

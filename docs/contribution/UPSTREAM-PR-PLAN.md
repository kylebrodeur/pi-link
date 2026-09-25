# Upstream PR plan — team composition discovery

Status: **draft, not opened.** Nothing is sent until you approve.

## Decisions (both settled)

| # | Question | Resolution |
|---|---|---|
| 1 | Subcommand vs flag for the surface | **Flags**: `--team`, `--team --json`, `--team-check`. A subcommand made a session named `team` unreachable, the exact collision upstream removed in 0.1.15. |
| 2 | Manifest format: YAML dep vs JSON-only | **JSON-only**, no new dependency. Upstream could still prefer YAML, in which case the parser swaps and the shape stays. |

Neither needs a maintainer answer before review. Both are contained changes to reverse.

## What would be contributed

Current branch diff vs `master` (11 commits):

| File | Status | Notes |
|---|---|---|
| `bin/team-config.mjs` | new | discovery, normalize, validate, format |
| `bin/pi-link.mjs` | modified | `--team` / `--team-check` modes, `--json` support |
| `skills/pi-link-team-setup/SKILL.md` | new | the bundled skill |
| `test/team-config.test.mjs` | new | discovery + validation coverage |
| `test/cli-team.test.mjs` | new | CLI surface, including the session-name collision regression |
| `test/fixtures/.pi-link/team.json` | new | fixture |
| `package.json` | **unchanged** | no dependency added — JSON-only (see decision 2) |
| `package-lock.json` | **unchanged** | no dependency added |
| `docs/pi-link-team-setup-runbook.md` | new | **do not send** — internal runbook |
| `docs/superpowers/plans/…` | new | **do not send** — internal plan |

### Files to exclude from the PR

`docs/pi-link-team-setup-runbook.md` and `docs/superpowers/plans/2026-09-24-*.md` are internal
working documents (they reference local checkout paths, the local anti-slop gate, and our
fork's install isolation). They should not go upstream.

## Upstream conventions to match

Read from upstream's own history, not assumed:

- A feature lands as **one commit** carrying code **plus** `README.md` **plus** `CHANGELOG.md`
  **plus** a `package.json` version bump. Precedent — `1c2be02` (0.5.1) touched exactly
  `CHANGELOG.md`, `README.md`, `index.ts`, `package.json`, `package-lock.json`.
- The CHANGELOG entry is prose that explains *behavior and consequence*, not a commit log.
  Each entry states what changed and what it means, including compatibility notes.
- README has a **Table of Contents** and numbered sections; a new CLI section must be added to
  it, and the `## Dependencies` section must be updated if a dependency is added
  (it currently states the `ws`-only posture explicitly).
- The bundled skill is registered through `package.json` → `"pi": { "skills": ["./skills"] }`,
  so a new `skills/` subdirectory ships automatically. Verify the tarball includes it.

## Planned commit shape

A single commit, mirroring upstream's own feature commits:

```
Add team composition discovery and validation

<prose: what the commands do, what a manifest is for, what is deliberately
out of scope, and the compatibility posture>

Release as x.y.z.
```

Plus, in the same commit:

- `README.md`: new `## Teams` section + ToC entry; `## Dependencies` still states the `ws`-only posture (no dependency is added).
- `CHANGELOG.md`: new version section in upstream's prose style.
- `package.json`: version bump.
- `package-lock.json`: consistent lock.

## Pre-send checklist (run before opening anything)

```bash
# 1. branch is based on current upstream master
git fetch upstream && git merge-base --is-ancestor upstream/master HEAD

# 2. internal docs excluded
git diff --name-only upstream/master..HEAD | grep -E 'docs/(superpowers|pi-link-team-setup-runbook)' \
  && echo 'EXCLUDE THESE' || echo 'clean'

# 3. tests pass
node --test test/team-config.test.mjs test/cli-team.test.mjs

# 4. syntax
node --check bin/pi-link.mjs && node --check bin/team-config.mjs

# 5. packed artifact contains every runtime import
npm pack --dry-run        # must list bin/pi-link.mjs AND bin/team-config.mjs

# 6. CLI smoke, from a repo WITH a manifest and one WITHOUT
node bin/pi-link.mjs --team
node bin/pi-link.mjs --team-check
node bin/pi-link.mjs --team --json

# 7. no manifest-less crash: --team in a repo with no .pi-link/ still reports
# 8. the collision stays fixed: a session named "team" is reachable again
node bin/pi-link.mjs team some-session   # must NOT print a --team usage error
```

## Verification the maintainer will likely run

Anticipate these, since they are the failure modes this feature is about:

| Scenario | Expected |
|---|---|
| Repo with no `.pi-link/` | `--team` reports artifacts, `Manifest: none`; `--team-check` exits 1 with a clear message |
| Manifest referencing a missing profile | `--team-check` exits 1, names `roles.<x>.profile is missing: <path>` |
| Manifest with no `hub.role` | `--team-check` exits 1, `hub.role is required` |
| Malformed JSON | clean `ERROR team manifest is not valid JSON: …`, exit 1 — **no stack trace** |
| Relative paths in manifest | normalized against repo root |
| Skills referenced but absent | required → error; optional → warning |
| Duplicate terminal names | error |

These are covered by the branch's tests; each was also verified by hand against a sandbox repo.

## Risk notes to disclose in the PR

- **No session name is captured.** The surface is flags only, so a session named `team`
  resolves normally. Worth stating explicitly, because the first prototype used a subcommand
  and did capture it; the regression test covers this.
- **No** runtime dependency is added: the manifest is JSON, parsed with `JSON.parse`. The
  README's `ws`-only posture is preserved. If upstream prefers YAML, that becomes a dependency
  conversation, not a silent cost.
- Discovery reads directory trees; it is strictly read-only and writes nothing. State this
  plainly, since the natural fear is a tool that mutates a repo.

## Not planned for this PR

Deferring these keeps the first contribution small and reviewable:

- manifest proposal / write (`--team-init`)
- capability inventory and live capability advertisement
- structured capability requests over `link_send`
- process lifecycle (`--team-start` / `--team-stop`)

If upstream wants the feature, these are the natural follow-ups, and each is a separate
proposal.

## Sequencing

1. **Done:** flag surface + JSON-only manifest implemented; local gate works; runbook written.
2. **You review** the issue draft and this plan.
3. **File the issue** only if you approve.
4. **Add** the README section, CHANGELOG entry, and version bump per upstream convention.
5. **Re-verify** with the checklist above, including the packed-artifact check.
6. **Open the PR** referencing the issue.

Nothing from steps 3–7 happens without your explicit go-ahead.

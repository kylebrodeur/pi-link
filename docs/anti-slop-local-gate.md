# pi-link local anti-slop gate (NOT committed)

How we run the generic anti-slop rules against pi-link **without introducing any
of this tooling into the repository**, so nothing here can reach upstream when we
contribute the team work.

Established 2026-09-24.

## Why local-only

Upstream `alvivar/pi-link` has **no** lint, format, or test toolchain:

```text
scripts:            {}                    (no lint / typecheck / test)
devDependencies:    { "@types/ws": ... }  (that is the whole list)
tsconfig.json       absent
eslint / prettier   absent
```

Adding a linter, a husky hook, and a plugin tree would be an unsolicited
toolchain change in someone else's project. So the gate is wired locally and
excluded from git. The team feature itself is the only thing we intend to
contribute.

## Layout

| Path | Purpose | Git status |
|---|---|---|
| `tools/oxlint/anti-slop/` | vendored rule tree, byte-identical to the neutral SoT | **excluded** |
| `oxlint.config.ts` | 15 rules at `error`, ignores the vendored tree | **excluded** |
| `.husky/pre-commit` | fail-closed gate: secrets → anti-slop → tests | **excluded** |
| `docs/anti-slop-local-gate.md` | this file | **committed to our fork** |

The split is deliberate: the **machinery** is local-only so it can never reach upstream,
while the **documentation** is committed so the fork explains how its own gate works.

## Exclude mechanism

`git config extensions.worktreeConfig true` then `git config --worktree core.hooksPath .husky`
scopes hooks to this worktree; the main checkout keeps no `hooksPath`, so upstream
work is unaffected.

The machinery is ignored via **`.git/info/exclude`** (uncommitted by design):

```text
tools/
oxlint.config.ts
.husky/
```

Verify at any time:

```bash
for p in tools oxlint.config.ts .husky; do
  git check-ignore -q "$p" && echo "$p ignored ✓" || echo "$p WOULD COMMIT ✗"
done
git status --short --branch
```

## Install

`oxlint` and `@oxlint/plugins` are installed with **`--no-save`**, so
`package.json` and `package-lock.json` stay byte-identical to the committed
versions. Verified by checksum before/after.

```bash
npm install --no-save --no-audit --no-fund oxlint@^1.85.0 @oxlint/plugins@^1.85.0
```

## Vendoring parity

The rule tree is copied from the neutral source of truth and must stay identical:

```bash
diff -rq ~/workspace/component-tools/anti-slop/ tools/oxlint/anti-slop/   # empty
```

15 rules, 3 shared helpers, plus the SoT README. No product group (`folia/`,
`uofd/`) is vendored — those stay local to repos that own such policy.

## Run it

```bash
./node_modules/.bin/oxlint -c oxlint.config.ts index.ts bin test
```

## Results (measured 2026-09-24)

All findings are in **pre-existing upstream code**. Our team work is clean.

| File | Findings | Notes |
|---|---|---|
| `index.ts` | **20** | upstream, untouched by us |
| `bin/pi-link.mjs` | **16** | upstream, all in pre-existing lines 49–701 |
| `bin/team-config.mjs` | **0** | our new code |
| `test/team-config.test.mjs` | **0** | our new code |
| `test/cli-team.test.mjs` | **0** | our new code |

By rule:

```text
21  no-runtime-typeof
 7  require-safety-comment-for-type-assertion
 6  no-unsafe-dictionary-type
 2  no-conditional-empty-object-spread
```

No findings fall inside our team command block (`bin/pi-link.mjs` lines 269–310).

### Consequence for the gate design

Because the rules are `error`-level and upstream already carries 36 findings, the
hook lints **only staged files**. This keeps the gate honest about *new* slop
without blocking our fork on debt we are not introducing upstream. It is the
lint-staged idea, reimplemented inline since pi-link has no `lint-staged`.

## Deviations from the standard recipe

The standard recipe assumes a repo with eslint/prettier/lint-staged/typecheck.
pi-link has none, so:

| Recipe step | Here |
|---|---|
| `eslint --fix` in lint-staged | omitted — no eslint |
| `prettier --write` | omitted — no prettier |
| `oxlint -c oxlint.config.ts` | **kept**, scoped to staged files |
| `npm run typecheck` | replaced with `node --test test/*.test.mjs` — no typecheck script exists |

## The trufflehog index bug (important)

The recipe's trufflehog line is unsafe inside a **pre-commit hook in a git
worktree**, and the failure is silent data loss:

> git exports `GIT_DIR` and `GIT_INDEX_FILE` to hooks. trufflehog's internal git
> plumbing inherits them, so it writes through the **real** index and unstages
> every file. The commit then succeeds **without the staged changes**.

Reproduced:

```text
staged BEFORE: [hook-test-slop.mjs]  index hash=b841a4c8
trufflehog exit=0
staged AFTER:  []                    index hash=68350c83
```

A commit made in that state landed with the file **absent from the tree**.

Fix — scrub the variables for the scan only:

```sh
env -u GIT_DIR -u GIT_INDEX_FILE -u GIT_WORK_TREE \
  trufflehog git file://. --since-commit HEAD --only-verified --fail --no-update || exit 1
```

Verified both directions after the fix:

- slop file → commit **blocked**, exit 1, HEAD unmoved, file still staged
- clean file → commit **succeeded**, content present in the commit

Not reproducible in a plain checkout, only when `GIT_DIR`/`GIT_INDEX_FILE` are set
— which is exactly what a worktree hook gets. Anyone running the recipe's hook in
a worktree should apply this scrub.

## Re-verifying the gate end to end

```bash
cd /private/tmp/pi-link-team-setup

# 1. slop must be blocked
printf 'export function f(v){ if (typeof v === "string") return 1; return 2; }\n' > tmp-slop.mjs
git add -f tmp-slop.mjs
git commit -m 'must fail'          # expect exit 1, HEAD unmoved

# 2. clean must commit WITH content intact
git reset -q; rm -f tmp-slop.mjs
printf 'export const MARKER = "ok";\n' > tmp-clean.mjs
git add -f tmp-clean.mjs
git commit -m 'must pass'          # expect exit 0
git show HEAD:tmp-clean.mjs        # MUST print the line

# 3. clean up
git reset --hard HEAD~1; rm -f tmp-clean.mjs
```

## Uninstall

```bash
rm -rf tools oxlint.config.ts .husky
rm -rf node_modules        # or: npm prune (removes the --no-save packages)
# remove the four lines from .git/info/exclude
git config --worktree --unset core.hooksPath
git config --unset extensions.worktreeConfig   # optional
```

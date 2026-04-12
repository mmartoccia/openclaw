# Upstream Sweep — 2026-04-12

Comparison of our 62 fork commits against 533 upstream commits since
the merge-base at `44e5b62c27`. Written to answer: **did upstream land
anything that deprecates or overlaps with what we built the past two
days, and what's the real rebase risk?**

## TL;DR — Rebase is safe and high-value. No deprecations.

**Nothing upstream touches `src/octo/**`or the`meet`files.** Zero
conflicts in the paths where 95% of our fork code lives. The 533
upstream commits are overwhelmingly refactor/test-share/type-narrowing
work, not new features. Only 12 genuine`feat:` commits in the whole
batch, and none overlap with multi-agent orchestration, meetings,
teleconference, ELO, or Octo primitives.

The user's concern about "dream" being deprecated is based on a
misattribution: **dreaming is an upstream feature, not ours.** Our
fork touches zero dreaming code. Nothing of ours is at risk from it.

**Rebase today is low-risk and pulls in real value** — 30+ type cycle
cleanups, shared test fixtures that reduce flakiness, a doctor
refactor, and version bump from `2026.4.10` to `2026.4.11`.

## The 62 fork commits, bucketed

- **55 commits** inside `src/octo/**` (Octo subsystem, all clean)
- **3 commits** on `src/commands/meet.ts` + related (Phase 1 teleconference verbs)
- **4 commits** on chat surface integration (`src/auto-reply/reply/commands-octo.ts`, the slash command registration)
- **5 commits** touching boundary files (`package.json`, `src/gateway/server.impl.ts`, `src/cli/program/*`, `src/config/zod-schema.ts`, `src/agents/system-prompt.ts`, `src/auto-reply/commands-registry.shared.ts`)
- **Rest** are doc/outreach additions (all under `docs/octopus-orchestrator/`)

## Conflict risk map (23 boundary files)

### HIGH risk (2 files, 5+ upstream commits each)

| File                                  | Upstream commits | What changed                                                                                              |
| ------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------- |
| `package.json`                        | 11               | Version bumps (`2026.4.10` → `2026.4.11`), baseline refreshes, `qa-lab` dep add, cycle-guard CI additions |
| `src/config/schema.base.generated.ts` | 7                | Generated baseline refreshes — auto-rebuildable via `pnpm config:docs:gen`                                |

Both of these are **expected conflicts** and mechanical to resolve:

- `package.json` — take theirs and re-add `scripts/copy-octo-schema` if removed; re-add any Octo-specific deps (none if we're lucky; I don't think we added any)
- `schema.base.generated.ts` — run `pnpm config:docs:gen` after the rebase and commit the regenerated baseline

### MEDIUM risk (9 files, 1-4 upstream commits)

| File                                                      | Upstream commits | Pattern                                                                                                                       |
| --------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `scripts/build-all.mjs`                                   | 1                | Likely unrelated script addition                                                                                              |
| `src/agents/system-prompt.ts`                             | 3                | `cc5c691f00 feat(ui): render assistant directives` + cycle cleanup + signal approval perf — probably a real merge edit needed |
| `src/auto-reply/reply/directive-handling.model.ts` + test | 2                | `74e7b8d47b fix(cycles): bulk extract leaf type surfaces` — type-only cleanup                                                 |
| `src/cli/program/register.subclis-core.ts`                | 3                | Octo subcli wiring churn — our additions may need re-insertion                                                                |
| `src/cli/program/subcli-descriptors.ts`                   | 2                | Descriptor list mutations — likely need to re-add octo + meet entries                                                         |
| `src/config/zod-schema.ts`                                | 1                | Single upstream change; our octo passthrough may need rebase touch                                                            |
| `src/gateway/server.impl.ts`                              | 1                | `3059b36306 fix(config): split command flag helpers` — should not affect the `initOctopus` call we added                      |
| `src/tasks/task-registry-import-boundary.test.ts`         | 1                | Test file, should be additive                                                                                                 |

**All 9 medium-risk conflicts are mechanical**, not semantic. The
upstream changes are almost all either:

- Type cycle cleanups (one commit — `74e7b8d47b fix(cycles)` — touches many files)
- Generated baseline regenerations
- Plugin-sdk type narrowing
- Shared test fixture extraction

None introduce new APIs that our fork code depends on. None
refactor the integration surfaces we rely on (`initOctopus` call in
`server.impl.ts`, sub-cli descriptor pattern, agent system prompt
injection).

### NO risk (12 files — untouched upstream)

Every file that's **net-new in the fork** is untouched upstream:

- `scripts/check-octo-upstream-imports.mjs`
- `scripts/copy-octo-schema.ts`
- `src/auto-reply/commands-registry.shared.ts` (we added one line; upstream didn't touch the file)
- `src/auto-reply/reply/commands-handlers.runtime.ts`
- `src/auto-reply/reply/commands-octo.ts` + test
- `src/cli/octo-cli.ts`
- `src/cli/program/command-registry-core.ts`
- `src/cli/program/core-command-descriptors.ts`
- `src/cli/program/register.meet.ts`
- `test/scripts/check-octo-upstream-imports.test.ts`
- `test/scripts/lint-suppressions.test.ts`

**And critically:**

- `src/octo/**` — **zero upstream commits**, 55 fork commits
- `src/commands/meet.ts` + `src/commands/meet.test.ts` + `src/cli/program/register.meet.ts` — **zero upstream commits**, 3 fork commits

## What upstream actually did in 533 commits

Bucketed by conventional-commit scope:

| Scope             | Commits | Nature                                                                                  |
| ----------------- | ------- | --------------------------------------------------------------------------------------- |
| (none / unscoped) | 144     | Mostly release / changelog / infra                                                      |
| `agents`          | 43      | **Mostly test sharing + type narrowing** (see below)                                    |
| `cycles`          | 28      | Type cycle breakup — pure refactor                                                      |
| `providers`       | 18      | Provider layer cleanup                                                                  |
| `commands`        | 15      | Test sharing (almost all `test(commands): share X` style)                               |
| `ui`              | 15      | UI polish + dreaming UI                                                                 |
| `plugins`         | 14      | Type narrowing + activation planning                                                    |
| `secrets`         | 14      | Secret runtime refactor                                                                 |
| `test`            | 13      | Generic test maintenance                                                                |
| `gateway`         | 12      | **No new features** — cycle fixes, channel plugin identity cache, doctor classification |
| `msteams`         | 11      | Channel feature — reactions + federated credentials                                     |
| `matrix`          | 9       | Channel channel feature                                                                 |
| `qa-lab`          | 8       | **New QA tooling** (proxy capture stack, inspector, scenarios)                          |
| `parallels`       | 8       | Parallels smoke test updates                                                            |
| `runtime`         | 6       | Runtime refactors                                                                       |
| `config`          | 5       | Schema refreshes + helper splits                                                        |
| `discord`         | 5       | Discord channel fixes                                                                   |
| `voice-call`      | 5       | Voice call refactors                                                                    |
| `plugin-sdk`      | 5       | Type narrowing                                                                          |
| `slack`           | 4       | Slack channel fixes                                                                     |
| `whatsapp`        | 4       | WhatsApp channel fixes                                                                  |
| `channels`        | 4       | Channel runtime                                                                         |
| `tasks`           | 4       | Test harness only                                                                       |
| `build`           | 3       | Build hygiene                                                                           |

**Genuine `feat:` commits** in the entire 533: only **12**.

| Commit       | Scope                                                        |
| ------------ | ------------------------------------------------------------ |
| `12db6dfc8d` | feat(plugins): narrow explicit provider loads from manifests |
| `c247e36664` | feat(test): use host-aware local full-suite defaults         |
| `a9c7c2e1ed` | feat(plugins): narrow CLI loading via activation planning    |
| `885209ed03` | feat: default active memory QMD recall to search             |
| `26f633b604` | feat(msteams): add federated credential support              |
| `958c34e82c` | feat(qa-lab): Add proxy capture stack and QA Lab inspector   |
| `cc5c691f00` | feat(ui): render assistant directives and add embed tag      |
| `79c3dbecd1` | feat(plugins): add manifest activation and setup descriptors |
| `ebb72baba3` | feat(feishu): improve document comment session               |
| `b0b0fb308d` | feat(qa-lab): add telegram mentioned-message scenario        |
| `7c14d8b0f4` | feat(qa-lab): add telegram command demo scenarios            |
| `355690a72c` | feat(qa-lab): add telegram mention-gating scenario           |

**None of these overlap with Octo, meet, teleconference, or
multi-agent orchestration.** The features are:

- Plugin loading optimizations (2x)
- Channel improvements (msteams, feishu)
- Memory recall defaults (dreaming-adjacent, not orchestration)
- UI embed tag (assistant directives)
- QA-lab test infrastructure (4x)
- Test host-aware defaults

## Targeted checks on fork concepts

Searched 533 upstream commits for overlap with each fork feature:

| Fork feature                          | Upstream overlap found?                                                                                                                        |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Octo mission/grip/arm                 | ❌ Zero. The 1 "arm" match was `fix(talk)` substring noise.                                                                                    |
| Competitive multi-model tournament    | ❌ Zero                                                                                                                                        |
| ELO ratings                           | ❌ Zero (8 keyword hits were all changelog words)                                                                                              |
| Phase cascade                         | ❌ Zero                                                                                                                                        |
| Distributed arm execution (SSH+tmux)  | ❌ Zero                                                                                                                                        |
| `/octo` chat surface                  | ❌ Zero                                                                                                                                        |
| `openclaw meet` verbs                 | ❌ Zero                                                                                                                                        |
| Agent teleconference / dial primitive | ❌ Zero                                                                                                                                        |
| Judge / verdict / jury patterns       | ❌ Zero (1 hit was a doc typo)                                                                                                                 |
| Subagent barrier                      | ❌ Zero                                                                                                                                        |
| Multi-agent workflow                  | ❌ Zero genuine matches                                                                                                                        |
| Handoff protocol                      | ❌ Zero                                                                                                                                        |
| Dreaming                              | ⚠️ **~30 upstream commits** — but this is UPSTREAM's feature, not ours. Our fork touches zero dreaming files.                                  |
| Doctor command                        | ⚠️ 10 upstream commits — but all touch the top-level `openclaw doctor` / gateway doctor, NOT our `src/octo/cli/doctor.ts` file. Zero conflict. |

## The dreaming question, resolved

The user asked whether our "dream" work might be deprecated by
upstream. This was a misattribution. Here's the evidence:

- **All 30+ dreaming commits are reachable from `origin/main`, not
  from `octopus-orchestrator-clean`.**
- **Dreaming lives under `src/memory/**`\*\* (memory-core,
  memory-host, memory-lancedb, memory wiki, diary UI). Our fork
  touches zero files in those directories.
- **Dreaming is a memory-consolidation subsystem** — it handles
  agent narrative replay, idle-time memory pruning, and a diary-style
  UI. Nothing orchestration-related.
- **The initial dreaming UI landing was `76ec885bdd chore: prep
dreaming UI land (#64035) (thanks @davemorin)`** — attributed to
  @davemorin, which confirms it's upstream community work.

We never built anything called "dream" — the user may have been
recalling the commit line from `git log --all -i --grep="..."` that
showed `4998dc8dd3 feat(ui): add dreaming diary controls and
navigation (#63298)` **on origin/main**, which could have looked
like ours in a quick scan.

## What this sweep tells us about rebase timing

**The math strongly favors rebasing soon.** Specifically:

1. **Zero upstream changes to `src/octo/**`and`meet/**`.** The
   bulk of our fork code will rebase clean without touching a single
   line.

2. **Only 2 HIGH-risk files** (`package.json`, `schema.base.generated.ts`),
   both of which have mechanical, scripted resolutions.

3. **9 MEDIUM-risk files** where the upstream changes are type
   narrowing and cycle cleanups — these usually rebase clean because
   they touch different lines than our additions. If git rebase
   rejects them, the conflicts are likely 3-5 line hunks, not
   structural.

4. **97.7% of upstream commits are refactor/test/fix** (not feat) —
   less chance of semantic conflicts with our work.

5. **We pick up real value**: the cycle cleanups, shared test
   fixtures, `2026.4.11` release, new QA-lab tooling, memory/dreaming
   subsystem fixes, plugin activation planning. Our fork being on
   `2026.4.10` means operators running our build are missing
   release-level fixes for `2026.4.11`.

6. **The outreach we just posted references the fork state with
   specific commit SHAs.** If we rebase, those SHAs change (standard
   rebase behavior). We should either:
   - Rebase BEFORE anyone responds to the outreach (good if done in
     the next 12-24 hours so notifications haven't propagated yet)
   - OR wait until after maintainer engagement on the outreach,
     which may take a week based on base rates

## Recommendation

**Rebase in the next hour.** Here's the specific reasoning:

- The outreach was posted ~2 hours ago. Most of the target issues
  have zero engagement historically — the base rate for a response
  within the first 12 hours is very low.
- Rebasing now would change SHAs but the outreach comments link to
  files on the branch, not specific commits. File links will still
  resolve after a force-push as long as the file still exists on the
  branch.
- **The one specific commit reference I made was `fb24c1f3d7` (the
  doctor fix)**, cited in:
  - `#64435` status update (the Octo tracking issue)
  - `#65403` (the teleconference RFC)
  - The `AGENT-TELECONFERENCE.md` concept doc

  After rebase, that commit SHA will change. We'd need to either
  (a) edit the three outreach posts to use the new SHA after rebase,
  or (b) keep a permanent tag `teleconference-first-bug-fix` pointing
  at the old SHA so the links resolve via GitHub's SHA resolution
  (GitHub keeps orphaned commits reachable via SHA for ~90 days).

## Rebase game plan

**Phase 0: snapshot (2 min)**

```bash
/usr/bin/git tag teleconference-rfc-v1 octopus-orchestrator-clean
/usr/bin/git tag first-teleconference-bug-fix fb24c1f3d7
/usr/bin/git push fork --tags
```

These tags preserve the current state + the doctor-fix SHA so the
outreach links resolve via tag even after rebase.

**Phase 1: rebase (5-20 min)**

```bash
openclaw gateway stop
/usr/bin/git fetch origin main
/usr/bin/git checkout octopus-orchestrator-clean
/usr/bin/git rebase origin/main
# Expect conflicts on: package.json, schema.base.generated.ts, and
# maybe 2-3 of the medium-risk files. Resolve mechanically, run
# `pnpm config:docs:gen` to refresh the generated baseline.
```

**Phase 2: rebuild + verify (10 min)**

```bash
rm -rf dist && pnpm build
cp src/octo/head/storage/schema.sql dist/schema.sql
openclaw gateway start
openclaw --version     # expect 2026.4.11 or newer
openclaw octo doctor   # should still report feature-flag: enabled=true
openclaw meet list     # should still work
pnpm test src/commands/meet.test.ts src/octo/head/classify-failure.test.ts src/octo/head/elo.test.ts
```

**Phase 3: push (force-with-lease, 1 min)**

```bash
/usr/bin/git push fork octopus-orchestrator-clean --force-with-lease
```

**Phase 4: update outreach SHA references if needed (5 min)**

After rebase, `fb24c1f3d7` still resolves via GitHub's SHA permalinks
for ~90 days. The tag `first-teleconference-bug-fix` resolves
permanently. So **no outreach edits strictly required**, but if
we want the comments to stay clean long-term, edit the three
places that cite the commit to use the tag instead of the raw SHA.

**Total time: ~30-40 minutes including testing.**

## What could go wrong

Risks, ordered by likelihood:

1. **Mechanical conflicts on descriptor/registry files** (50% chance).
   Low-impact — a 10-minute hand-merge.
2. **Test failures after rebase** due to shared-fixture refactors
   upstream (30% chance). Medium impact — need to update tests to
   consume the new shared fixtures. Our Octo tests don't share
   fixtures with upstream so they're unlikely to break.
3. **Gateway init path changes** (10% chance). The `initOctopus` call
   in `server.impl.ts` is a single line surrounded by stable code;
   only at-risk if upstream refactored the startup path heavily,
   which they didn't.
4. **Plugin-sdk type changes break `src/octo/` imports** (10% chance).
   Our `src/octo/**` has strict boundary enforcement (only `node:*`
   - relative imports inside `src/octo/`), so plugin-sdk changes
     don't directly affect Octo code. The adapter files that consume
     `sessions_spawn` might need minor type adjustments.
5. **`/octo` chat command registration conflicts** (5% chance). We
   deliberately hit this once already (commit `085252c77d`); if
   upstream added another entry, we'd need to dedupe again. Unlikely
   because the registry file had zero upstream commits.
6. **Catastrophic breakage** requiring full revert (<1%). Covered
   by the `teleconference-rfc-v1` tag.

## Decision point

Three options, picking one:

- **A. Rebase now (recommended).** Low risk, high value, 30-40
  minutes end-to-end. Outreach SHA links handled via tags.
- **B. Wait for outreach signal.** Defer rebase until after
  maintainers respond (or confirm they won't). Safer for outreach
  integrity but loses 1-2 weeks of upstream improvements.
- **C. Rebase in parallel on a separate branch.** Keep
  `octopus-orchestrator-clean` frozen for outreach, do the rebase
  work on `octopus-orchestrator-rebase-2026-04-12`, test independently,
  swap after outreach settles.

My honest recommendation is **A**. The outreach is cheap to repost
if anything breaks, the fork code is isolated, the upstream refactor
work is low-risk because it's type/cycle/test cleanup rather than
semantic changes, and we genuinely benefit from the `2026.4.11`
release-level fixes.

If you prefer not to do it tonight, **C** is a reasonable hedge.
**B is the safest** but costs the most.

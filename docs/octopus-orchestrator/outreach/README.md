# Outreach Drafts — Agent Teleconference Protocol

Drafts for engaging with existing openclaw/openclaw issues + PRs on
agent-to-agent communication. Written after the 2026-04-12 landscape
scan that identified 15+ related proposals with near-zero convergence.

## Posting order (recommended)

Post in this order over ~1-2 days so each conversation has room to
breathe:

1. **[01-comment-51642.md](./01-comment-51642.md)** — on the closest
   prior art (Conference/Multi-Agent Sessions feature request). Cheapest
   place to start: acknowledges an existing community proposal,
   contributes evidence, invites collaboration.
2. **[02-comment-63789.md](./02-comment-63789.md)** — on the active
   draft PR with the closest philosophical alignment (minimal handoff
   protocol). Offer concrete implementation path.
3. **[03-comment-35203.md](./03-comment-35203.md)** — on the big
   architectural RFC (Capability Profiling + Blackboard + Layered
   Memory). Frame our primitive as a minimum-viable first layer.
4. **[04-comment-62581.md](./04-comment-62581.md)** — on the
   internal-only messaging feature request. Highlight direct overlap.
5. **[05-rfc-issue.md](./05-rfc-issue.md)** — a net-new RFC issue
   filed as the concrete proposal with cross-links to all four of
   the above. Submit **after** the comments have been posted for at
   least 24 hours so the cross-refs land in notification trees.

## Before posting

- Re-read each draft — tone should feel like **you**, not me. Edit freely.
- Replace any placeholder fork URL (e.g. `github.com/mmartoccia/openclaw`)
  if the fork branch name changes.
- The bug-fix commit referenced is `fb24c1f3d7` on branch
  `octopus-orchestrator-clean` — confirm it's still live before linking.
- No self-promotion language — every claim is backed by a commit or a
  concrete file. Keep it that way.

## After posting

- Watch for maintainer responses on the RFC issue (05). That's the
  signal that tells us whether to proceed with Phase 1 PR code.
- If silence for a week, fall back to "just ship the PR, let code
  speak" — see the outreach plan discussion in SESSION-LOG.

# Agent Note: Pending waits drop at generation death, not at resync

Status: implemented

English | [中文](2026-08-18-web-pending-waits-drop-at-generation-death.zh.md)

## Problem

The web GUI's question composer (and the approval panel) render from the session's pending-wait map, which the host repopulates on every connection generation: the mux stream replays still-pending `question/requested` and `approval/requested` frames with their stable rpcId from stream open — *before* the `onConnected` readiness handshake completes. The client cleared that map at the wrong point: `Session.resync()` (driven by `onConnected`) ran `pending.clear()` *after* the replayed frames had already been consumed and re-minted, so the replay never came again. When the connection dropped while a question was pending — the natural outcome of leaving a question unanswered through a long idle period — the composer takeover unmounted, the question text disappeared, and the tool row stayed at "Waiting answer" forever because the host still held the pending question while the client no longer had any carrier to answer it. A resync without any disconnect (subagent address change) lost pending waits the same way, with no replay at all to restore them.

## Decision

Pending waits are generation-scoped, so they drop at generation death — not at window rebuild. `Session.handleDisconnected()` (called from the manager's existing disconnect sweep, which runs on the 'reconnecting' state change, before any next-generation frame can arrive) clears the pending map; `Session.resync()` no longer touches it. The mux-open replay that re-sends still-pending requested frames therefore lands on an empty map, and its re-minted waits survive the `resync()` behind the handshake. A stale reference remains superseded, not settled: its `respond()` still reaches the host (the rpcId is unchanged). The manager's list-level `pendingInteractions` status already followed this lifecycle; the per-instance map is now consistent with it.

## Verification

Unit tests cover the lifecycle at both layers: resync keeps still-pending waits (same snapshot reference), `handleDisconnected` drops them, a replayed requested frame re-mints a fresh wait with the same key whose stale reference can still respond, the resync behind the handshake keeps the re-minted wait, and the manager's disconnect sweep reaches resident sessions' pending maps. The browser e2e question-composer scenario keeps its replay-mode flow and now asserts on a phone viewport that every footer action button stays inside the card's clip (the single-question fixture cannot show validation copy — Submit stays disabled until answered). The same two assertions — plain footer and validation-feedback footer — were verified against the deployed GUI in a live browser (375 px viewport, real question round trips), including a live reconnect: with a question pending, dropping and restoring the browser connection re-minted the question and the answer completed the turn.

## Alternatives considered

**Keep the clear in resync and delay frame delivery until after the handshake.** Rejected: delivery ordering is owned by the connection pump, and an interaction-frame readiness barrier would couple the connection and session layers over one frame kind.

**Reconcile the pending map at resync instead of clearing (drop only waits the replay did not re-send).** Rejected: resync cannot know the replay contents ahead of the frame stream; the disconnect-time drop is the only point where the generation boundary is known without ordering knowledge.

## Consequences

A pending question now survives a reconnect: the composer takeover stays (or reappears) answerable, and the tool row never strands at "waiting" without a carrier. A question resolved while disconnected still disappears correctly (no replay frame arrives for it). The same lifecycle applies to pending approvals. The mobile footer change in the same change (wrap the question-card footer on narrow viewports so the Submit button is never clipped out of the card) is a presentation fix with no lifecycle interaction.

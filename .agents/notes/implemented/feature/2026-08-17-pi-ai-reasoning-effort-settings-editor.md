# Agent Note: Per-Model Reasoning-Effort Editor on the Models Page

Status: implemented

English | [中文](2026-08-17-pi-ai-reasoning-effort-settings-editor.zh.md)

## Problem

The backend declaration vocabulary ([[2026-08-08-pi-ai-per-model-reasoning-declarations]]) gave `settings.yaml` a per-model `reasoningEfforts`, but the Models page — the only surface where a hand-declared pi-ai route's model list is edited — exposed `id`/`name`/`contextWindow`/`maxTokens` only. Aligning efforts per model still meant hand-writing `settings.yaml`, so a custom (pi-ai) provider never carried reasoning metadata unless an operator did that by hand. The user-visible symptom — "reasoning effort tidak tampil di custom provider" — is the composer's effort pane, which renders only when resolved model metadata carries `reasoning`: a hand-declared route got that metadata only from a declaration no UI could produce, and the user's expectation was the built-in behavior — the effort dropdown appears after model selection without any configuration.

## Decision

Two changes together make the composer's effort picker work for custom providers end to end:

- **Hand-declared models default to reasoning-capable.** In `llm-pi-ai`'s `resolveModelReasoning`, a model with no installed catalog entry and no `reasoningEfforts` declaration now materializes `reasoning: true` instead of `false`, so pi-ai offers its standard base level set — `off` plus `minimal`/`low`/`medium`/`high` — and `resolveModelInfo` reports those levels through the same seam catalog metadata uses. `xhigh`/`max` stay out until declared, per pi-ai's asymmetric defaulting, and a catalog-backed model keeps its installed entry's capability exactly as before (`reasoningEfforts` still exists for a gateway whose dialect or level set differs). The composer shows the effort pane with the standard levels the moment a custom model is selected, matching the built-in providers.
- **The Models page edits per-model declarations.** Each pi-ai model row gains a per-model reasoning-effort editor inside its advanced fold: a three-state select (unset / non-reasoning / custom levels), with custom rendering all seven levels as a checkbox plus a wire-value input — checking a level seeds its wire input with the level id, Off's empty wire means "send no reasoning parameter", and unchecking deletes the key. Validation mirrors the adapter's catalog rules exactly: an empty dict is refused, an only-Off declaration is refused, every level beyond Off needs a non-empty wire string, and unknown level names are refused. The editor writes through its own `patchEfforts` path, not the row's generic `patch`, because the generic patch drops `''`/`undefined` values while the dict may legitimately hold `null` and a transient `''`.

The admin gate on provider add/edit/delete — the role probe at `fetch('/api/auth/me')` and the `canMutate` flag in `store.ts` — is untouched; reasoning-effort selection stays available to every user, since the composer already offers efforts to all users. The per-model label is 推理档位 (`reasoningEfforts`), distinct from the composer's route-level 推理强度 which the provider card deliberately does not carry (still asserted by the existing e2e: `getByLabel('推理强度')` count is 0).

## Alternatives considered

- **A route-level effort control on the provider card.** Rejected: effort is a per-model capability, and a single value would break the models that do not accept it — the same reason the page stopped writing the route-level knob (#1860).
- **A free-form YAML/JSON textarea for `reasoningEfforts`.** Rejected: the card's curated-fold design trades schema-generic field coverage for the mockup layout; structured checkboxes keep validation in the same per-row checker as the other fields and keep the wire spelling editable.
- **A composer-side fallback that invents levels without adapter metadata.** Rejected: the adapter owns its reasoning capability; defaulting at the pi-ai seam keeps dispatch, validation, and metadata consistent, while a frontend-only fallback could offer levels the adapter would refuse at request time.

## Consequences

- A hand-declared pi-ai route's models now expose `reasoning` with the standard base level offer by default: declaration → pi-ai `resolveModelReasoning` → `LlmResolvedModelInfo.reasoning` → composer effort pane, with no composer change. `xhigh`/`max` and renamed wire spellings still require a declaration, and `reasoningEfforts: false` still strips reasoning from a catalog model.
- The `llm.models` RPC (which the composer reads) now carries `reasoning` for every hand-declared model, not just declared ones — the wire path is `resolveModelInfo` per model in `api-proxy.ts`.
- The two component specs now stub the role probe `fetch('/api/auth/me') → { role: 'admin' }` at module scope (the established `vi.stubGlobal` pattern), fixing a baseline regression where the role-gated section rendered read-only in jsdom — 75 failing tests, pre-existing since the role-gate commit and verified by a stash baseline on a clean tree. The gate itself is unchanged.
- The models-settings e2e gains a scenario that declares per-model reasoning efforts through the assembled browser and pins a new golden; existing goldens are unchanged because the collapsed surface is untouched.
- The README pairs (llm-pi-ai and ui-settings-models) replace the prior "hand-declared models do not reason" passage with the standard-default description; the known-limitations bullet now names `reasoningEfforts` among the curated fold fields.

Predecessor: [[2026-08-08-pi-ai-per-model-reasoning-declarations]] (the backend vocabulary, whose `reasoning: false` default for hand-declared models this note reverses; the declaration surface itself stands). This note adds the settings-page editor and the standard default.

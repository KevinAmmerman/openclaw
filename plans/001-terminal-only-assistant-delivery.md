# Plan 001: Enforce terminal-only assistant delivery for noisy models

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. Do
> not edit prompts, personality files, or add content regexes. Preserve all
> unrelated pre-existing worktree changes.
>
> **Drift check (run first)**:
> `git diff --stat 2efccc0ebf..HEAD -- src/config/types.models.ts src/config/zod-schema.core.ts src/agents/pi-embedded-subscribe.types.ts src/agents/pi-embedded-runner/run/attempt.ts src/agents/pi-embedded-subscribe.handlers.messages.ts src/agents/pi-embedded-runner/run/payloads.ts src/agents/pi-embedded-subscribe.handlers.messages.test.ts src/agents/pi-embedded-runner/run/payloads.test.ts`
>
> Also run `git diff -- <in-scope paths>` before editing. This worktree already
> contains uncommitted commentary-sanitizer changes in the message handler and
> its tests. Work with them; do not discard unrelated user changes.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `2efccc0ebf`, 2026-06-13
- **Implementation**: source complete and focused tests green on 2026-06-14.
  The local no-delivery canary is blocked before model invocation because this
  fork reports OpenClaw `2026.4.27` while its bundled `tokenjuice` plugin
  requires OpenClaw `>=2026.5.28`. Production promotion also remains pending.

## Why this matters

`zai/glm-5.2` correctly separates native reasoning into `thinking` blocks, but
it also emits narration such as "Lass mich ..." as ordinary assistant `text`
before tool calls. Those messages have `stopReason: "toolUse"`, no phase, and
no signature. OpenClaw accumulates them in `assistantTexts` and prefers that
array over the terminal assistant message during channel payload assembly, so
content regexes are the only thing currently standing between internal work
notes and Telegram. The fix must use turn lifecycle metadata, not wording.

## Verified evidence

- Live trajectory on 2026-06-13 showed repeated assistant messages containing
  `thinking`, ordinary `text`, and `toolCall`, with `stopReason: "toolUse"`.
  The text blocks had no `phase` and no `textSignature`.
- The same run's terminal assistant message used `stopReason: "stop"`.
- A no-delivery GLM 5.2 canary with `thinking=off` produced zero reasoning
  tokens and no `thinking` blocks. Therefore model thinking suppression works
  in the current runtime but is not sufficient for the observed leak class.
- `src/agents/pi-embedded-subscribe.handlers.messages.ts:41-43` suppresses only
  messages explicitly marked `phase: "commentary"`.
- `src/agents/pi-embedded-runner/run/payloads.ts:345-364` prefers accumulated
  non-empty `assistantTexts` over `fallbackAnswerText` from the terminal
  assistant message.
- The current worktree adds `stripLeakedCommentaryDeliveryText`, which guesses
  internal content from phrases. It is containment, not a reliable boundary.

## Repository conventions

- Runtime compatibility behavior is declared in `ModelCompatConfig` and
  validated by `ModelCompatSchema`.
- Subscriber behavior is covered in
  `src/agents/pi-embedded-subscribe.handlers.messages.test.ts`.
- Final payload selection is covered in
  `src/agents/pi-embedded-runner/run/payloads.test.ts`.
- Use existing phase suppression as the structural pattern, but key the new
  policy on lifecycle state rather than text content.

## Commands you will need

| Purpose                  | Command                                                                                                                                                                                                                                             | Expected on success      |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Focused handler tests    | `pnpm test -- src/agents/pi-embedded-subscribe.handlers.messages.test.ts`                                                                                                                                                                           | exit 0, all tests pass   |
| Focused payload tests    | `pnpm test -- src/agents/pi-embedded-runner/run/payloads.test.ts`                                                                                                                                                                                   | exit 0, all tests pass   |
| Related subscriber tests | `pnpm test -- src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.suppresses-commentary-phase-output.test.ts src/agents/pi-embedded-subscribe.subscribe-embedded-pi-session.keeps-assistanttexts-final-answer-block-replies-are.test.ts` | exit 0, all tests pass   |
| Core typecheck           | `pnpm tsgo:core`                                                                                                                                                                                                                                    | exit 0                   |
| Format check             | `pnpm format:check`                                                                                                                                                                                                                                 | exit 0 for touched files |

## Scope

**In scope**:

- `src/config/types.models.ts`
- `src/config/zod-schema.core.ts`
- Generated config schema/docs only if required by repository checks
- `src/agents/pi-embedded-subscribe.types.ts`
- `src/agents/pi-embedded-runner/run/attempt.ts`
- `src/agents/pi-embedded-subscribe.handlers.messages.ts`
- `src/agents/pi-embedded-runner/run/payloads.ts`
- The focused test files named above
- Z.AI model-definition/config wiring needed to enable the policy for
  `zai/glm-5.2`

**Out of scope**:

- `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, or any prompt/personality file
- New regexes, phrase lists, language detection, classifiers, or LLM judge calls
- Telegram-only filtering; the invariant belongs at shared assistant delivery
- Changing reasoning visibility semantics (`/reasoning`, `thinkingDefault`)
- Gateway restart or production promotion without explicit operator approval

## Target design

Add an explicit model compatibility setting with a name such as:

```ts
assistantTextDelivery?: "live" | "terminal_only";
```

Use the repository's final naming judgment, but preserve these semantics:

- `live` or unset: existing behavior.
- `terminal_only`: never emit partial/block/channel-visible assistant text while
  the run is non-terminal. Assistant messages with `stopReason: "toolUse"`
  remain in the transcript and model context but cannot enter `assistantTexts`
  or outbound channel payloads.
- On `stopReason: "stop"`, deliver only the final assistant message's visible
  text and directives.
- Error, approval, media, and deterministic tool-result paths retain their
  current explicit handling.
- The final payload builder must fail closed: under `terminal_only`, it must use
  the terminal `lastAssistant` extraction and must not fall back to accumulated
  intermediate `assistantTexts`.
- Enable the policy for `zai/glm-5.2` through model/provider metadata or the
  local model entry, not by matching prose or model output.

## Steps

### Step 1: Add and validate the compatibility policy

Add the optional enum to `ModelCompatConfig` and `ModelCompatSchema`. Update
generated schema artifacts only through the repository generator.

**Verify**: `pnpm config:schema:check` must exit 0 after generation/check.

### Step 2: Thread the resolved policy into the embedded subscriber

Resolve the active model's compatibility value in `attempt.ts` and pass a
boolean or enum through `SubscribeEmbeddedPiSessionParams`. Do not re-read
global config inside the message handler.

**Verify**: `pnpm tsgo:core` exits 0.

### Step 3: Suppress non-terminal text at the subscriber boundary

When terminal-only mode is active:

1. Do not forward assistant text updates through partial replies, block replies,
   or `assistantTexts` while the message is non-terminal.
2. On `message_end` with `stopReason: "toolUse"`, record usage and the last
   assistant message as today, then reset delivery buffers without emitting
   visible text.
3. On the terminal `stop` message, run the normal visible-text/directive/media
   extraction and emit that message once.

Do not infer intent from text. The decision inputs must be the compatibility
policy plus structured lifecycle fields (`stopReason`, phase, tool-call state).

**Verify**: focused handler and subscriber tests pass.

### Step 4: Make final payload assembly fail closed

Add the same policy to `buildEmbeddedRunPayloads`. In terminal-only mode,
derive answer payloads from `lastAssistant` only. Do not prefer or concatenate
`assistantTexts`, even if they are populated by a future bypass path.

Preserve raw final text when needed for media directives. Preserve existing
tool-error and deterministic-approval behavior.

**Verify**: focused payload tests pass.

### Step 5: Replace the regex containment after structural tests are green

Remove `stripLeakedCommentaryDeliveryText` and its marker/anchor helpers from
the current worktree only after the new tests prove terminal-only behavior.
Replace phrase-based tests with lifecycle tests. Keep unrelated changes in the
same files.

**Verify**:

`rg -n "stripLeakedCommentaryDeliveryText|countLeakedCommentaryReasoningSignals|isLikelyLeakedCommentaryParagraph" src/agents`

Expected: no matches.

### Step 6: Enable the policy for GLM 5.2 and run a no-delivery canary

Configure `zai/glm-5.2` to use terminal-only assistant delivery. Do not change
`AGENTS.md`, `SOUL.md`, or model personality prompts.

Run an isolated `openclaw agent --json` canary without `--deliver`. The prompt
must require multiple harmless read-only tool calls. Inspect the session JSONL
and result payload structurally.

Expected:

- Any pre-tool assistant text remains only in transcript records with
  `stopReason: "toolUse"`.
- `result.payloads` contains exactly one assistant text payload from the
  terminal `stop` message.
- No intermediate assistant text is in the result payload.
- Telegram is not contacted during this canary.

## Test plan

Add at least these cases:

1. Unphased `text + toolCall`, `stopReason: "toolUse"`, terminal-only enabled:
   no agent event, block reply, partial reply, or `assistantTexts` entry.
2. The same message with terminal-only disabled: existing behavior preserved.
3. Explicit `phase: "commentary"`: remains suppressed in both modes.
4. Terminal unphased `text`, `stopReason: "stop"`: emitted exactly once.
5. Accumulated intermediate `assistantTexts` plus terminal `lastAssistant`:
   terminal-only payload builder returns only terminal text.
6. Final media directive: preserved in terminal-only mode.
7. Terminal error/approval path: current warning or deterministic prompt
   behavior remains unchanged.
8. A German GLM-style pre-tool sentence and an unrelated normal sentence must
   produce identical suppression behavior when lifecycle metadata is equal,
   proving the implementation is content-independent.

## Done criteria

- [x] No prompt or personality file changed.
- [x] No new commentary regex, marker list, language heuristic, or classifier.
- [x] Terminal-only mode suppresses all `toolUse` assistant text delivery.
- [x] Terminal `stop` text and media deliver exactly once.
- [x] Final payload assembly ignores accumulated intermediate text in
      terminal-only mode.
- [x] GLM 5.2 is opted into the policy through structured model compatibility
      resolution, scoped exactly to `zai/glm-5.2` unless explicitly overridden.
- [ ] Focused tests, core typecheck, schema check, and format check pass.
      Focused tests, schema, and formatting pass. Core typecheck is blocked by
      two pre-existing errors in unchanged plugin files concerning
      `trustedOfficialInstall`.
- [ ] No-delivery GLM 5.2 canary proves one terminal payload and zero leaked
      intermediate payloads. Blocked before model invocation by the fork/plugin
      host-version mismatch documented in the implementation status above.
- [x] Existing phrase-based commentary sanitizer is removed or explicitly left
      as temporary defense with a follow-up removal task and documented reason.

## STOP conditions

Stop and report instead of improvising if:

- The active model definition is unavailable at subscriber construction time
  and threading it would require a broad runtime refactor.
- A channel bypasses both the subscriber and `buildEmbeddedRunPayloads`; name
  that path and add a separate plan rather than adding a text filter.
- Suppressing non-terminal text breaks approval prompts, media delivery, or
  explicit messaging-tool sends and the break cannot be isolated structurally.
- Tests reveal that a terminal answer can legitimately occur on a `toolUse`
  message without a later `stop` message for this provider.
- The implementation requires edits to prompt/personality files.

## Maintenance notes

- Treat terminal-only delivery as a model compatibility contract, not a
  Telegram quirk. Other models that emit unphased pre-tool narration can opt in.
- Keep transcript/model-context retention separate from user-visible delivery;
  suppressing delivery must not delete assistant tool-call turns from history.
- Review future changes to `assistantTexts` accumulation and payload fallback
  order against this invariant.
- `thinking=off` remains useful for cost and native reasoning suppression, but
  it is not the security boundary for ordinary assistant `text`.

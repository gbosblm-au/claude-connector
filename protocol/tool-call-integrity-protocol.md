# Tool-Call Integrity Protocol

**Version 1.0** · Tenax Intelligence Platform · 2026-08-15

The discipline layer. Governs how the model emits and recovers structured tool
calls. The mechanical enforcement layer that backs it is `CONN-GUARD-001`,
implemented in `src/tools/tool-call-guard.js` and `src/tools/render-schemas.js`
in the connector.

Where this protocol governs *behaviour*, the guard enforces it at the connector
boundary. Neither is sufficient alone: a protocol nothing checks is a
suggestion, and a guard with no protocol behind it rejects calls without ever
improving the calls being made.

---

## 1. The failure this exists to prevent

Observed 2026-08-15. A call to `document_render` went out **twice** without its
`spec` payload attached. The renderer never received a valid body. The model,
receiving what read as a tool failure rather than a correctable mistake,
abandoned the tool and pivoted to a script fallback.

Three things went wrong, in order:

1. An under-specified call was **emitted**.
2. It was **accepted** at the boundary and passed toward the renderer.
3. The resulting error was read as *"this tool does not work"* rather than
   *"this call was malformed; re-fire it"*.

The guard breaks link 2 and, through the shape of its rejection, link 3. This
protocol addresses link 1, which is the only one that can be fixed at source.

---

## 2. Rules

### Rule 1 — A structured call carries its payload or is not emitted

A renderer-class tool call (`document_render`, `pdf_render`, `xlsx_render`,
`pptx_render`) is emitted **only** when the full spec payload is constructed and
attached. A call with an empty or absent `spec` is not a call; it is a mistake
that happens to have a tool name on it.

If the payload cannot be constructed — the content is not ready, or a required
field has no value — the correct action is to say so, not to fire an empty call
and discover the problem from the error.

### Rule 2 — A guard rejection means retry, not fall back

A rejection carrying `retry: true` and a `directive` is a **demand for a
corrected re-fire**. It is not a signal that the tool is unavailable or
unsuitable.

Specifically prohibited on a guard rejection:

- pivoting to `script_execute` or any other tool to do the same job;
- reporting to the user that the tool failed;
- re-firing the *same* call unchanged.

The rejection names the tool, the field at fault, and what would fix it. That
is enough to correct the call, and correcting it is the expected next action.

### Rule 3 — Two consecutive rejections on the same tool stop the loop

If a corrected re-fire is rejected again, stop. Report the problem to the user
plainly, including what the guard said. Repeated re-firing burns the user's time
and produces nothing.

Two is the limit because the first rejection carries the information needed to
fix the call; a second means the information was not sufficient, and a third
attempt has no new basis to succeed on.

### Rule 4 — Never claim an artifact a tool did not return

A download link, filename or document reference appears in a reply **only**
when a tool call this turn returned it. This is already enforced post-turn by
`detectUnbackedArtifactClaims()` in `lib/tool-dispatch.js`; the rule is stated
here because the enforcement is a detector, not a preventer.

### Rule 5 — Recovered calls are calls

Tool calls recovered from the text channel — DeepSeek DSML markup, or
`<tool_call>` blocks, both handled by `extractTextChannelToolCalls()` — are
subject to every rule above and to the same guard. A recovered call is executed
exactly as if it had arrived structurally, which means an empty recovered call
is rejected exactly as an empty structural one is.

---

## 3. Amendment 1 — Output-channel demarcation (FIX-SPEC-OCD-001)

Adopted 2026-08-15.

**A user-facing paragraph must not open by narrating the step about to be
taken.** "Let me check the dispatch code", "I'll now read the config", "Let me
start by looking at..." are rehearsal. They belong in the thinking block or in a
`[TRACE]` block, never in the answer.

A displayed paragraph begins at the first thing addressed to the reader: a
result, a link, an answer, or a question for them.

This does **not** restrict speaking to the reader. "Let me know if...", "Let me
explain why...", "Let me be direct..." are addressed outward and belong in the
answer. The discriminator is whether the verb operates on the model's own tools
or on the user.

Enforced mechanically by `lib/rehearsal-classifier.js` in the gateway, which
applies the rule to unmarked paragraphs regardless of whether the model
observed it.

---

## 4. Amendment 2 — Model routing (SPEC-MODEL-ROUTING-LOCKDOWN)

Adopted 2026-08-15.

DeepSeek V4 Pro is the default model for all work. Qwen is reachable for image
translation only, for exactly one call, after which routing returns to DeepSeek
V4 Pro unconditionally — on success **and** on failure.

This protocol depends on it. Rules 1 and 2 presuppose a model that reliably
emits tool calls, consumes their results, and completes a verify-then-commit
loop. A model that fails upstream of verification never reaches the safety net,
and no amount of protocol discipline compensates for that.

Enforced by `lib/model-routing-lockdown.js`.

### 4.1 Reading an image inside a general task

A turn carrying an image is routed to a vision-capable model so the image can
actually be read — a coding question with a screenshot is still answered, not
dropped. That turn dispatches with **no tools attached** (§4.2 of the routing
specification): the read is one request and one response.

This has a workflow consequence worth stating plainly, because it is the one
place the lockdown changes what a user can do in a single turn:

> Attach a screenshot and ask for a fix to be written, and the fix is not
> written on that turn. The image is read; the work happens on the next turn,
> on DeepSeek V4 Pro, with the full toolset.

The model is told this in-turn and is instructed to say what it found and what
it would do next, so the handoff reads as one step of two rather than a
failure. There is no silent drop and nothing to work around.

For **pure** transcription with no surrounding task, the dedicated endpoint
`routes/describe-image.js` is the direct path and does not consume a
conversational turn.

---

## 5. Measurement

The guard logs every rejection with the tool, the reason, the field and the
model id (`CONN-GUARD-001` §3.4). The gateway logs per-response channel
classification counts with the model id (`FIX-SPEC-OCD-001` §12).

Together these give a per-model rejection rate and a per-model rehearsal-leak
rate. Both exist to make the routing decision in section 4 an evidence-based
one over time rather than a standing assumption — including the evidence that
would justify revisiting it.

---

## 6. Change control

Amendments are appended, numbered, and dated. The rules in section 2 are the
stable core; an amendment may extend them but may not silently narrow one.

Changes to section 4 are governed by the routing specification's own change
control (§9.1 of that document), which requires explicit authorisation and a new
revision.

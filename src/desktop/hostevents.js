/* ==========================================================================
   DeepSeek Harness — Host event client (Phase 6).
   Folds the loopback Host's session event stream into the desktop: creates
   a session (bound to the selected workspace's cwd), queues prompts, and
   streams assistant text deltas into the terminal. Approvals and user
   questions surface as read-only terminal lines (answered in the console).
   ========================================================================== */
(function () {
  "use strict";

  const DSH = (window.DSH = window.DSH || {});

  const AI_ANSWER_TIMEOUT_MS = 5 * 60 * 1000;

  let sessionId = null;
  let sessionCwd = null;
  let streaming = null; // { handle, blockIndex, ended }
  let waiters = new Map(); // sessionId -> [{resolve}]

  function ipc() {
    return window.desktopIpc;
  }

  function terminal() {
    return DSH.panels?.terminal;
  }

  /* ---- Incoming frame folding ---------------------------------------------- */
  function handleFrame(frame) {
    if (frame === null || typeof frame !== "object") return;
    if (frame.type === "stream/error") {
      terminal()?.add("err", "Harness event stream: " + (frame.error?.message || "error"));
      return;
    }
    if (frame.type === "session/event") {
      foldSessionEvent(frame.sessionId, frame.event);
      return;
    }
    if (frame.type === "approval/requested") {
      terminal()?.add("info", `approval requested \u2014 ${frame.toolName || "tool"} (answer in the console)`);
      return;
    }
    if (frame.type === "question/requested" && Array.isArray(frame.questions)) {
      for (const question of frame.questions) {
        terminal()?.add("info", `question \u2014 ${question.question || "?"}`);
      }
    }
  }

  function foldSessionEvent(eventSessionId, event) {
    if (event === null || typeof event !== "object" || typeof event.type !== "string") return;
    if (eventSessionId !== sessionId) return;

    if (event.type === "assistant/chunk") {
      const chunk = event.data?.chunk;
      if (chunk !== null && typeof chunk === "object") {
        if (chunk.type === "text-delta" && typeof chunk.text === "string") {
          onTextDelta(chunk);
        } else if (chunk.type === "tool-call-delta") {
          terminal()?.add("info", "tool call\u2026");
        }
      }
      return;
    }
    if (event.type === "assistant/message") {
      // Final message fallback: close any open stream.
      finishStream();
      return;
    }
    if (event.type === "turn/end") {
      const reason = event.data?.reason;
      finishStream();
      resolveWaiters(eventSessionId);
      if (reason !== undefined && reason.kind === "interrupted") {
        terminal()?.add("info", "turn interrupted");
      }
      return;
    }
    if (event.type === "tool/result") {
      const name = event.data?.message?.toolName;
      if (typeof name === "string") {
        terminal()?.add("info", `tool \u2014 ${name}`);
      }
    }
  }

  function onTextDelta(chunk) {
    if (streaming === null || chunk.index !== streaming.blockIndex) {
      // New text block → new terminal stream line.
      finishStream();
      const handle = terminal()?.beginStream("out");
      streaming = handle ? { handle, blockIndex: chunk.index } : null;
    }
    if (streaming !== null) {
      streaming.handle.append(chunk.text);
      DSH.core?.setDetail("Receiving response\u2026");
    }
  }

  function finishStream() {
    if (streaming !== null) {
      streaming.handle.end();
      streaming = null;
    }
  }

  function resolveWaiters(sid) {
    const pending = waiters.get(sid);
    if (pending === undefined) return;
    waiters.delete(sid);
    for (const entry of pending) entry.resolve();
  }

  function waitForTurnEnd(sid) {
    return new Promise((resolve) => {
      const list = waiters.get(sid) ?? [];
      list.push({ resolve });
      waiters.set(sid, list);
    });
  }

  /* ---- Session management --------------------------------------------------- */
  async function ensureSession(cwd) {
    if (sessionId !== null && sessionCwd === cwd) return { ok: true, sessionId };
    const created = await ipc().host.call("session.create", cwd ? { cwd } : {});
    if (!created.ok) {
      return { ok: false, message: "DeepSeek backend unavailable: " + (created.error?.message || "session.create failed") };
    }
    sessionId = created.value?.sessionId ?? null;
    sessionCwd = cwd;
    if (sessionId === null) return { ok: false, message: "session.create returned no session id" };
    return { ok: true, sessionId };
  }

  /* ---- Ask ------------------------------------------------------------------ */
  async function ask(text, { cwd } = {}) {
    const created = await ensureSession(cwd ?? null);
    if (!created.ok) return { ok: false, message: created.message };
    const linesBefore = terminal()?.lines.length ?? 0;
    const timeZone = safeTimeZone();
    const prompt = await ipc().host.call("session.prompt", {
      sessionId: created.sessionId,
      mode: "queue",
      content: [{ type: "text", text }],
      ...(timeZone === null ? {} : { clientTimeZone: timeZone })
    });
    if (!prompt.ok) {
      return { ok: false, message: "DeepSeek backend unavailable: " + (prompt.error?.message || "session.prompt failed") };
    }
    if (prompt.value?.command !== undefined && prompt.value.command.kind === "success") {
      // The prompt dispatched a slash command; the console owns that flow.
      DSH.app?.setView("console");
      return { ok: true, message: "Command handled by the Harness Console." };
    }
    const answered = await Promise.race([
      waitForTurnEnd(created.sessionId).then(() => ({ timedOut: false })),
      new Promise((resolve) => {
        setTimeout(() => resolve({ timedOut: true }), AI_ANSWER_TIMEOUT_MS);
      })
    ]);
    if (answered.timedOut) {
      return { ok: false, message: "DeepSeek did not answer within 5 minutes." };
    }
    const fresh = terminal()?.lines.slice(linesBefore) ?? [];
    const empty = !fresh.some((line) => line.kind === "out" && line.text.trim() !== "");
    return {
      ok: true,
      message: empty ? "DeepSeek finished (see the Harness Console for the answer)." : "DeepSeek answered.",
      sessionId: created.sessionId
    };
  }

  function safeTimeZone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
    } catch {
      return null;
    }
  }

  DSH.hostEvents = {
    handleFrame,
    ask,
    ensureSession,
    get sessionId() {
      return sessionId;
    }
  };
})();

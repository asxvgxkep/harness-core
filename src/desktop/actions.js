/* ==========================================================================
   DeepSeek Harness — Action execution pipeline.
   Runs a command through the unified AI state pipeline:
   THINKING → PLANNING (optional) → EXECUTING → VERIFYING → DONE | FAILED.
   The AI Core, agent panel and terminal all observe the same states.
   ========================================================================== */
(function () {
  "use strict";

  const DSH = (window.DSH = window.DSH || {});

  const ACTIONS = new Map();
  let busy = false;
  let aiFallback = null;

  function register(id, fn) {
    if (typeof id !== "string" || id === "") throw new Error("actions: id required");
    if (typeof fn !== "function") throw new Error("actions: " + id + " needs a function");
    ACTIONS.set(id, fn);
    return () => {
      ACTIONS.delete(id);
    };
  }

  function byId(id) {
    return ACTIONS.get(id) ?? null;
  }

  /** Registered when the Harness backend is available (Phase 6). */
  function setAiFallback(fn) {
    aiFallback = typeof fn === "function" ? fn : null;
  }

  function wait(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  function terminal() {
    return DSH.panels?.terminal;
  }

  function toast(kind, text) {
    const el = document.getElementById("toast");
    if (el === null) return;
    el.textContent = text;
    el.className = "show kind-" + (kind === "err" ? "err" : "ok");
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => {
      el.classList.remove("show");
    }, 2400);
  }

  async function runPipeline(command, input) {
    if (busy) return { ok: false, reason: "busy" };
    busy = true;
    const core = DSH.core;
    const ctx = {
      input,
      command,
      terminal: terminal(),
      core,
      ipc: window.desktopIpc,
      toast,
      app: DSH.app,
      getWorkspace: () => DSH.app?.getWorkspace() ?? null
    };

    terminal()?.add("cmd", input);
    core.setState("THINKING", command.thinking || "Analyzing request\u2026");
    await wait(430);

    if (Array.isArray(command.plan) && command.plan.length > 0) {
      // Structured plan: steps complete sequentially, the active marker
      // travels down the list, and finished steps keep their checkmarks.
      const steps = command.plan.slice(0, 6);
      const phaseMs = 520 + steps.length * 130;
      const stepMs = phaseMs / (steps.length + 0.6);
      core.setState("PLANNING", { steps, active: 0 });
      for (let i = 1; i <= steps.length; i++) {
        await wait(stepMs);
        core.updatePlan(i);
      }
      await wait(stepMs * 0.6);
    }

    core.setState("EXECUTING", command.executing || "Running\u2026");
    let result;
    try {
      result = await command.run(ctx);
    } catch (error) {
      result = {
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      };
    }

    if (result !== null && typeof result === "object" && result.ok === false) {
      core.setState("FAILED", result.message || "Command failed");
      terminal()?.add("err", result.message || "Command failed");
      toast("err", result.message || "Command failed");
      busy = false;
      return result;
    }

    core.setState("VERIFYING", "Verifying\u2026");
    await wait(340);
    core.setState("DONE", result?.message || "Done");

    if (Array.isArray(result?.lines)) {
      for (const line of result.lines) {
        terminal()?.add(line.kind || "out", line.text);
      }
    }
    if (result?.message) {
      terminal()?.add("ok", result.message);
      toast("ok", result.message);
    }
    busy = false;
    return result ?? { ok: true };
  }

  /** Run routed input: local command pipeline, or the AI fallback. */
  async function runInput(input) {
    const routed = DSH.commands.route(input);
    if (routed.command !== null) {
      DSH.commands.remember(routed.command.id);
      return runPipeline(routed.command, input);
    }
    if (routed.ai) {
      // Unmatched natural language rides the Ask DeepSeek pipeline so the
      // core, agents and terminal all reflect the AI execution states.
      const askCommand = DSH.commands.byId("ask-ai");
      if (askCommand !== null) {
        DSH.commands.remember("ask-ai");
        return runPipeline(askCommand, input);
      }
      if (aiFallback !== null) return aiFallback(input);
    }
    return { ok: false, message: "No matching command and no AI backend" };
  }

  DSH.actions = {
    register,
    byId,
    setAiFallback,
    runPipeline,
    runInput,
    get busy() {
      return busy;
    }
  };
})();

/* ==========================================================================
   DeepSeek Harness — Desktop shell wiring.
   Boot phases (boot → reveal → ready), the Boot→Desktop transition, the
   global Command Center (Ctrl+Space), views (Core / Harness Console), the
   quick input bar, and every keyboard shortcut.
   ========================================================================== */
(function () {
  "use strict";

  const DSH = (window.DSH = window.DSH || {});

  const stage = document.getElementById("stage");
  const coreStateEl = document.getElementById("core-state");
  const quickInput = document.getElementById("quick-input");
  const quickSuggestions = document.getElementById("quick-suggestions");
  const commandCenter = document.getElementById("command-center");
  const ccInput = document.getElementById("cc-input");
  const ccSuggestions = document.getElementById("cc-suggestions");

  let bootInfo = null;
  let revealed = false;
  let currentView = "core";
  let ccOpen = false;
  let ccPaletteOnly = false;
  let ccSelected = 0;
  let ccItems = [];
  let quickSelected = 0;
  let quickItems = [];
  let workspace = null;
  let hostEventsStarted = false;
  let hostEventsStarting = false;
  let servicesReady = false;
  let agentReadyMarked = false;
  let consoleConfigured = false;

  /* ---- Boot info ---------------------------------------------------------- */
  function readBootInfo() {
    const params = new URLSearchParams(window.location.search);
    const fallback = {
      hostOrigin: params.get("host") || null,
      hostReady: params.has("host"),
      workspaceName: params.get("workspace") || "Harness Core Workspace",
      platform: params.get("platform") || "win32"
    };
    const ipc = window.desktopIpc;
    if (ipc === undefined) return Promise.resolve(fallback);
    return ipc
      .getBootInfo()
      .then((result) => (result?.ok && result.value ? result.value : fallback))
      .catch(() => fallback);
  }

  function configureConsole(info) {
    if (consoleConfigured || !info?.hostOrigin) return;
    const frame = document.getElementById("console-frame");
    if (frame === null) return;
    consoleConfigured = true;
    frame.setAttribute(
      "src",
      info.hostOrigin + "?dsh-desktop-platform=" + encodeURIComponent(info.platform || "win32")
    );
    frame.addEventListener("load", () => {
      document.getElementById("console-view").classList.add("loaded");
    });
  }

  function markAgentReady() {
    if (!servicesReady || !revealed || agentReadyMarked) return;
    agentReadyMarked = true;
    DSH.core.setState("IDLE");
    DSH.panels.terminal.add("ok", "SYSTEM SERVICES READY");
    DSH.panels.terminal.add("ok", "AGENT READY");
    window.desktopIpc?.startup?.mark("AGENT READY");
  }

  function applyBootInfo(info) {
    if (info === null || typeof info !== "object") return;
    bootInfo = info;
    servicesReady = info.hostReady === true || typeof info.hostOrigin === "string";
    if (!servicesReady) return;
    if (revealed) {
      markAgentReady();
      setTimeout(() => configureConsole(info), 0);
    }
    else coreStateEl.textContent = "SYSTEM SERVICES READY";
  }

  /* ---- Boot → Desktop transition ----------------------------------------- */
  function boot() {
    window.desktopIpc?.startup?.mark("renderer boot start");
    DSH.core.init();
    DSH.panels.init();

    // The local shell is reveal-ready before any external service hydrates.
    coreStateEl.textContent = "INITIALIZING SERVICES";

    const ipc = window.desktopIpc;
    if (ipc !== undefined && typeof ipc.on === "function") {
      ipc.on("desktop:reveal", reveal);
      ipc.on("desktop:services-ready", (result) => {
        if (result?.ok && result.value) applyBootInfo(result.value);
      });
      ipc.on("desktop:host:event", (framePayload) => {
        DSH.hostEvents?.handleFrame(framePayload);
      });
    } else {
      // Standalone preview (no Electron bridge): self-reveal after a beat.
      setTimeout(reveal, 1600);
    }
    // BootInfo is a fast local snapshot, but it is intentionally not awaited:
    // Host, Console and other services must never sit on the reveal chain.
    void readBootInfo().then(applyBootInfo);

    wireShortcuts();
    wirePanels();
    wireQuickInput();
    wireCommandCenter();
    wireViews();
    DSH.actions.setAiFallback(aiFallback);

    // Safety net: never linger in boot phase.
    setTimeout(reveal, 6000);
  }

  function reveal() {
    if (revealed) return;
    revealed = true;
    window.desktopIpc?.startup?.mark("Desktop chrome reveal start");
    DSH.core.pulse();
    stage.classList.remove("phase-boot");
    stage.classList.add("phase-ready");
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          window.desktopIpc?.startup?.mark("Desktop first visible frame");
        });
      });
    } else {
      setTimeout(() => window.desktopIpc?.startup?.mark("Desktop first visible frame"), 0);
    }

    DSH.panels.terminal.add("info", "DeepSeek Harness Desktop \u2014 AI Command Center");
    if (servicesReady) markAgentReady();
    else {
      coreStateEl.textContent = "INITIALIZING SERVICES";
      DSH.panels.terminal.add("info", "INITIALIZING SERVICES");
    }

    // Let the first Desktop frame commit before Console and system hydration.
    setTimeout(() => {
      configureConsole(bootInfo);
      DSH.panels.system.start(3000);
      void DSH.panels.system.refreshWsl();
    }, 0);

    const tb = document.getElementById("tb-workspace");
    if (tb !== null) {
      tb.textContent = "NO WORKSPACE";
    }
  }

  /* ---- Views -------------------------------------------------------------- */
  function setView(view) {
    if (view !== "core" && view !== "console") return;
    currentView = view;
    document.getElementById("core-view").classList.toggle("active", view === "core");
    document.getElementById("console-view").classList.toggle("active", view === "console");
    document.getElementById("view-core").classList.toggle("active", view === "core");
    document.getElementById("view-console").classList.toggle("active", view === "console");
  }

  function wireViews() {
    document.getElementById("view-core").addEventListener("click", () => setView("core"));
    document.getElementById("view-console").addEventListener("click", () => setView("console"));
  }

  /* ---- Shortcuts ---------------------------------------------------------- */
  function wireShortcuts() {
    window.addEventListener("keydown", (event) => {
      if (event.ctrlKey && event.code === "Space") {
        event.preventDefault();
        toggleCommandCenter(false);
        return;
      }
      if (event.ctrlKey && event.shiftKey && event.code === "KeyP") {
        event.preventDefault();
        toggleCommandCenter(true);
        return;
      }
      if (event.ctrlKey && event.code === "Backquote") {
        event.preventDefault();
        stage.classList.toggle("terminal-collapsed");
        return;
      }
      if (event.ctrlKey && event.code === "Digit1") {
        event.preventDefault();
        setView("core");
        return;
      }
      if (event.ctrlKey && event.code === "Digit2") {
        event.preventDefault();
        setView("console");
        return;
      }
      if (event.code === "Escape") {
        if (ccOpen) {
          closeCommandCenter();
          return;
        }
        if (document.activeElement === quickInput) {
          quickInput.blur();
          hideQuickSuggestions();
          return;
        }
      }
    });
  }

  function wirePanels() {
    const agentsCollapse = document.getElementById("agents-collapse");
    const terminalCollapse = document.getElementById("terminal-collapse");
    agentsCollapse?.addEventListener("click", () => stage.classList.toggle("agents-collapsed"));
    terminalCollapse?.addEventListener("click", () => stage.classList.toggle("terminal-collapsed"));

    document.getElementById("agents-refresh")?.addEventListener("click", () => {
      void DSH.panels.system.refreshWsl();
      void DSH.panels.system.refreshGpu();
      const ws = getWorkspace();
      if (ws !== null) void runInput("inspect workspace");
    });
  }

  /** Residual AI fallback (only used when the Ask DeepSeek command is
   *  unavailable): streams through the real Harness backend, or opens the
   *  console view when the backend is unreachable. */
  function aiFallback(input) {
    DSH.panels.terminal.add("cmd", input);
    return DSH.hostEvents
      .ask(input, { cwd: getWorkspace()?.path ?? null })
      .then((result) => {
        if (!result.ok) {
          setView("console");
          return { ok: false, message: result.message + " \u2014 console view opened." };
        }
        return result;
      });
  }

  /* ---- Suggestion rendering ----------------------------------------------- */
  function buildSuggestItem(item, selected, container) {
    const row = document.createElement("div");
    row.className = "suggest-item" + (selected ? " selected" : "");
    const name = document.createElement("span");
    name.className = "suggest-name";
    name.textContent = item.command.name;
    const kind = document.createElement("span");
    kind.className = "suggest-kind";
    kind.textContent = DSH.commands.kindLabel(item.command.kind);
    row.append(name, kind);
    row.addEventListener("mousedown", (event) => {
      event.preventDefault();
      runCommand(item.command, item.command.name);
    });
    container.appendChild(row);
    return row;
  }

  function renderQuickSuggestions() {
    quickItems = DSH.commands.suggest(quickInput.value, 5);
    quickSelected = 0;
    if (quickItems.length === 0) {
      hideQuickSuggestions();
      return;
    }
    quickSuggestions.textContent = "";
    quickItems.forEach((item, index) => {
      buildSuggestItem(item, index === 0, quickSuggestions);
    });
    quickSuggestions.classList.remove("hidden");
  }

  function hideQuickSuggestions() {
    quickSuggestions.classList.add("hidden");
  }

  function wireQuickInput() {
    quickInput.addEventListener("input", renderQuickSuggestions);
    quickInput.addEventListener("focus", renderQuickSuggestions);
    quickInput.addEventListener("blur", () => {
      setTimeout(hideQuickSuggestions, 140);
    });
    quickInput.addEventListener("keydown", (event) => {
      if (event.code === "ArrowDown" || event.code === "ArrowUp") {
        event.preventDefault();
        if (quickItems.length === 0) return;
        quickSelected = (quickSelected + (event.code === "ArrowDown" ? 1 : quickItems.length - 1)) % quickItems.length;
        quickItems.forEach((item, index) => {
          quickSuggestions.children[index]?.classList.toggle("selected", index === quickSelected);
        });
        return;
      }
      if (event.code === "Enter") {
        event.preventDefault();
        const value = quickInput.value.trim();
        if (value === "") {
          toggleCommandCenter(false);
          return;
        }
        const selected = quickItems[quickSelected];
        if (selected !== undefined && DSH.commands.score(selected.command, DSH.commands.normalize(value)) >= 0.7) {
          runCommand(selected.command, value);
        } else {
          runInput(value);
        }
        quickInput.value = "";
        hideQuickSuggestions();
        return;
      }
      if (event.code === "Escape") {
        quickInput.blur();
        hideQuickSuggestions();
      }
    });
  }

  /* ---- Command Center ------------------------------------------------------ */
  function openCommandCenter(paletteOnly) {
    ccOpen = true;
    ccPaletteOnly = paletteOnly === true;
    ccInput.value = "";
    ccSelected = 0;
    commandCenter.classList.remove("hidden");
    commandCenter.classList.add("open");
    renderCcSuggestions("");
    setTimeout(() => ccInput.focus(), 30);
  }

  function closeCommandCenter() {
    ccOpen = false;
    commandCenter.classList.remove("open");
    setTimeout(() => commandCenter.classList.add("hidden"), 220);
  }

  function toggleCommandCenter(paletteOnly) {
    if (ccOpen) closeCommandCenter();
    else openCommandCenter(paletteOnly);
  }

  function renderCcSuggestions(query) {
    const raw = DSH.commands.suggest(query, 8);
    ccItems = raw;
    ccSelected = 0;
    ccSuggestions.textContent = "";
    if (ccItems.length === 0) {
      const empty = document.createElement("div");
      empty.className = "cc-empty";
      empty.textContent = query === "" ? "Type to search commands, or ask anything\u2026" : "No matching command \u2014 Enter to ask DeepSeek";
      ccSuggestions.appendChild(empty);
      return;
    }
    ccItems.forEach((item, index) => {
      const row = document.createElement("div");
      row.className = "cc-suggestion" + (index === 0 ? " selected" : "");
      const kind = document.createElement("span");
      kind.className = "cc-kind";
      kind.textContent = DSH.commands.kindLabel(item.command.kind);
      const name = document.createElement("span");
      name.className = "cc-name";
      name.textContent = item.command.name;
      const desc = document.createElement("span");
      desc.className = "cc-desc";
      desc.textContent = item.command.description || "";
      row.append(kind, name, desc);
      row.addEventListener("mousedown", (event) => {
        event.preventDefault();
        runCommand(item.command, ccInput.value);
      });
      ccSuggestions.appendChild(row);
    });
  }

  function ccMoveSelection(delta) {
    if (ccItems.length === 0) return;
    ccSelected = (ccSelected + delta + ccItems.length) % ccItems.length;
    [...ccSuggestions.children].forEach((child, index) => {
      child.classList.toggle("selected", index === ccSelected);
    });
  }

  function wireCommandCenter() {
    ccInput.addEventListener("input", () => renderCcSuggestions(ccInput.value));
    ccInput.addEventListener("keydown", (event) => {
      if (event.code === "ArrowDown") {
        event.preventDefault();
        ccMoveSelection(1);
      } else if (event.code === "ArrowUp") {
        event.preventDefault();
        ccMoveSelection(-1);
      } else if (event.code === "Enter") {
        event.preventDefault();
        const value = ccInput.value.trim();
        if (value === "" && ccItems.length > 0) {
          runCommand(ccItems[0].command, "");
          return;
        }
        if (value === "") return;
        const selected = ccItems[ccSelected];
        if (selected !== undefined && DSH.commands.score(selected.command, DSH.commands.normalize(value)) >= 0.7) {
          runCommand(selected.command, value);
        } else {
          runInput(value);
        }
      } else if (event.code === "Escape") {
        closeCommandCenter();
      }
    });
    commandCenter.querySelector(".cc-backdrop").addEventListener("mousedown", closeCommandCenter);
  }

  /* ---- Execution ----------------------------------------------------------- */
  async function runCommand(command, input) {
    closeCommandCenter();
    hideQuickSuggestions();
    if (currentView === "console" && command.kind === "system") {
      setView("core");
    }
    ensureHostEvents();
    return DSH.actions.runPipeline(command, input);
  }

  async function runInput(input) {
    closeCommandCenter();
    hideQuickSuggestions();
    ensureHostEvents();
    return DSH.actions.runInput(input);
  }

  function ensureHostEvents() {
    if (hostEventsStarted || hostEventsStarting) return;
    const ipc = window.desktopIpc;
    if (ipc !== undefined && typeof ipc.host?.eventsStart === "function") {
      hostEventsStarting = true;
      void Promise.resolve(ipc.host.eventsStart()).then((result) => {
        hostEventsStarted = result?.ok === true;
        hostEventsStarting = false;
      }).catch(() => {
        hostEventsStarting = false;
      });
    }
  }

  function setWorkspace(meta) {
    workspace = meta;
    DSH.panels.setWorkspace(meta);
  }

  function getWorkspace() {
    return workspace;
  }

  DSH.app = {
    boot,
    reveal,
    setView,
    runInput,
    runCommand,
    setWorkspace,
    getWorkspace,
    getBootInfo: () => bootInfo,
    openCommandCenter,
    closeCommandCenter,
    toast: (kind, text) => {
      const el = document.getElementById("toast");
      if (el === null) return;
      el.textContent = text;
      el.className = "show kind-" + (kind === "err" ? "err" : "ok");
      clearTimeout(el._timer);
      el._timer = setTimeout(() => el.classList.remove("show"), 2400);
    }
  };

  boot();
})();

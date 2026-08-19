/* ==========================================================================
   DeepSeek Harness — Side panels: Agents, Workspace, Terminal, System status.
   Lightweight DOM updates only (no per-frame React work). The terminal is a
   display feed in this phase — commands/stout/stderr stream in from actions,
   the host proxy and system probes.
   ========================================================================== */
(function () {
  "use strict";

  const DSH = (window.DSH = window.DSH || {});

  const AGENTS_BASE = [
    { id: "orchestrator", name: "ORCHESTRATOR", status: "READY" },
    { id: "planner", name: "PLANNER", status: "WAITING" },
    { id: "coder", name: "CODER", status: "WAITING" },
    { id: "reviewer", name: "REVIEWER", status: "WAITING" }
  ];

  /* ---- Agents ------------------------------------------------------------- */
  let agents = AGENTS_BASE.map((agent) => ({ ...agent }));
  let agentsEl;

  function mapCoreStateToAgents(state) {
    const statuses = {
      orchestrator: "READY",
      planner: "WAITING",
      coder: "WAITING",
      reviewer: "WAITING"
    };
    if (state === "THINKING" || state === "PLANNING") {
      statuses.orchestrator = "ACTIVE";
    } else if (state === "EXECUTING") {
      statuses.orchestrator = "EXECUTING";
      statuses.planner = "DONE";
      statuses.coder = "EXECUTING";
    } else if (state === "VERIFYING") {
      statuses.orchestrator = "ACTIVE";
      statuses.coder = "DONE";
      statuses.reviewer = "THINKING";
    } else if (state === "DONE") {
      statuses.orchestrator = "DONE";
      statuses.planner = "DONE";
      statuses.coder = "DONE";
      statuses.reviewer = "DONE";
    } else if (state === "FAILED") {
      statuses.orchestrator = "ERROR";
    }
    if (state === "PLANNING") {
      statuses.planner = "EXECUTING";
    }
    return statuses;
  }

  function renderAgents() {
    if (agentsEl === undefined) return;
    agentsEl.textContent = "";
    for (const agent of agents) {
      const row = document.createElement("div");
      row.className = "agent-item";
      row.setAttribute("data-status", agent.status);
      const dot = document.createElement("span");
      dot.className = "agent-status-dot";
      const name = document.createElement("span");
      name.className = "agent-name";
      name.textContent = agent.name;
      const state = document.createElement("span");
      state.className = "agent-state";
      state.textContent = agent.status;
      row.append(dot, name, state);
      agentsEl.appendChild(row);
    }
  }

  function setAgentStates(statuses) {
    for (const agent of agents) {
      const next = statuses[agent.id];
      if (typeof next === "string" && next !== agent.status) agent.status = next;
    }
    renderAgents();
  }

  function applyCoreState(state) {
    setAgentStates(mapCoreStateToAgents(state));
  }

  /* ---- Workspace ---------------------------------------------------------- */
  let workspaceEl;
  let workspaceMeta = null;

  function renderWorkspace() {
    if (workspaceEl === undefined) return;
    workspaceEl.textContent = "";
    // REFRESH only matters once a workspace exists — keep the empty state clean.
    const panelFoot = document.getElementById("agents-refresh")?.parentElement ?? null;
    if (panelFoot !== null) {
      panelFoot.style.display = workspaceMeta === null ? "none" : "";
    }
    if (workspaceMeta === null) {
      const empty = document.createElement("div");
      empty.className = "ws-empty";
      const icon = document.createElement("div");
      icon.className = "ws-empty-icon";
      const title = document.createElement("div");
      title.className = "ws-empty-title";
      title.textContent = "No workspace selected";
      const desc = document.createElement("div");
      desc.className = "ws-empty-desc";
      desc.textContent = "Open a project directory\nto enable workspace tools.";
      const button = document.createElement("button");
      button.textContent = "OPEN WORKSPACE \u2192";
      button.addEventListener("click", () => {
        void DSH.app?.runInput("打开 Workspace");
      });
      empty.append(icon, title, desc, button);
      workspaceEl.appendChild(empty);
      return;
    }
    const meta = workspaceMeta;
    const lines = [
      ["Name", meta.name],
      ["Type", meta.type || "\u2014"],
      ["Git", meta.git ? meta.git.branch : "\u2014"],
      ["Status", meta.git && meta.git.modified > 0 ? meta.git.modified + " modified" : meta.git ? "clean" : "\u2014"],
      ["Files", String(meta.scan.count)],
      ["Lang", meta.scan.languages.map((entry) => entry.name).join(", ") || "\u2014"]
    ];
    for (const [label, value] of lines) {
      const row = document.createElement("div");
      row.className = "ws-line";
      const key = document.createElement("span");
      key.className = "ws-label";
      key.textContent = label;
      const val = document.createElement("span");
      val.className = "ws-value";
      val.textContent = value;
      val.title = value;
      row.append(key, val);
      workspaceEl.appendChild(row);
    }
  }

  function setWorkspace(meta) {
    workspaceMeta = meta ?? null;
    renderWorkspace();
    const tb = document.getElementById("tb-workspace");
    if (tb !== null) {
      tb.textContent = meta ? meta.name.toUpperCase() : "NO WORKSPACE";
    }
    const stage = document.getElementById("stage");
    stage.classList.toggle("has-workspace", meta !== null);
  }

  function getWorkspace() {
    return workspaceMeta;
  }

  /* ---- Terminal ----------------------------------------------------------- */
  const termLines = [];
  let terminalEl;
  let autoScroll = true;
  let activeStream = null;
  let cursorEl = null;

  function two(value) {
    return String(value).padStart(2, "0");
  }

  function timeStamp() {
    const d = new Date();
    return two(d.getHours()) + ":" + two(d.getMinutes()) + ":" + two(d.getSeconds());
  }

  function scrollToBottom() {
    if (autoScroll) terminalEl.scrollTop = terminalEl.scrollHeight;
  }

  function buildRow(line) {
    const row = document.createElement("div");
    row.className = "term-line kind-" + line.kind;
    const time = document.createElement("span");
    time.className = "term-time";
    time.textContent = line.time;
    const text = document.createElement("span");
    text.className = "term-text";
    if (line.kind === "cmd") {
      const prompt = document.createElement("span");
      prompt.className = "term-prompt";
      prompt.textContent = "$";
      text.appendChild(prompt);
    }
    text.appendChild(document.createTextNode(line.text));
    row.append(time, text);
    return { row, text };
  }

  function renderTerminal() {
    if (terminalEl === undefined) return;
    terminalEl.textContent = "";
    if (termLines.length === 0) {
      const empty = document.createElement("div");
      empty.className = "term-empty";
      empty.textContent = "\u2014 no output yet \u2014";
      terminalEl.appendChild(empty);
    } else {
      for (const line of termLines) {
        terminalEl.appendChild(buildRow(line).row);
      }
    }
    // The idle ready indicator: a quiet blinking cursor under the last line.
    cursorEl = document.createElement("div");
    cursorEl.className = "term-cursor";
    cursorEl.textContent = "_";
    if (activeStream !== null) cursorEl.style.display = "none";
    terminalEl.appendChild(cursorEl);
    scrollToBottom();
  }

  function terminalAdd(kind, text) {
    const kinds = new Set(["cmd", "out", "err", "info", "ok"]);
    // A pending stream line must settle before the log is rebuilt.
    if (activeStream !== null) {
      activeStream.end();
      activeStream = null;
    }
    termLines.push({
      time: timeStamp(),
      kind: kinds.has(kind) ? kind : "out",
      text: String(text)
    });
    if (termLines.length > 400) termLines.splice(0, termLines.length - 400);
    renderTerminal();
    const stage = document.getElementById("stage");
    stage.classList.add("has-task");
  }

  function terminalClear() {
    if (activeStream !== null) {
      activeStream.end();
      activeStream = null;
    }
    termLines.length = 0;
    renderTerminal();
  }

  /**
   * Open an incrementally-updated terminal line (O(1) appends — used for
   * streamed assistant text). Returns {append, end}; a full re-render while
   * the stream is open settles it first.
   */
  function terminalBeginStream(kind) {
    if (activeStream !== null) activeStream.end();
    const line = {
      time: timeStamp(),
      kind: kind === "err" ? "err" : "out",
      text: ""
    };
    termLines.push(line);
    if (termLines.length > 400) termLines.splice(0, termLines.length - 400);
    const built = buildRow(line);
    terminalEl.appendChild(built.row);
    const textNode = built.text.children[built.text.children.length - 1];
    if (cursorEl !== null) cursorEl.style.display = "none";
    scrollToBottom();
    const stream = {
      append(text) {
        line.text += String(text);
        if (textNode !== null && "textContent" in textNode) {
          textNode.textContent = line.text;
        }
        scrollToBottom();
      },
      end() {
        if (activeStream === stream) {
          activeStream = null;
          if (cursorEl !== null) cursorEl.style.display = "";
        }
      }
    };
    activeStream = stream;
    return stream;
  }

  async function terminalCopy() {
    const text = termLines.map((line) => line.time + "  " + (line.kind === "cmd" ? "$ " : "") + line.text).join("\n");
    try {
      if (navigator.clipboard && window.isSecureContext !== false) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      /* fall through to execCommand */
    }
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }

  /* ---- System status ------------------------------------------------------ */
  let systemTimer = 0;
  let wslInfo = { installed: false, online: false, defaultDistro: null };
  let gpuInfo = null;

  function renderSystem() {
    const tb = document.getElementById("tb-sys");
    if (tb === null) return;
    const parts = [];
    if (systemSample !== null) {
      parts.push("CPU " + systemSample.cpu.usagePct + "%");
      parts.push("MEM " + systemSample.mem.usagePct + "%");
    }
    if (gpuInfo !== null) {
      if (gpuInfo.ok && Array.isArray(gpuInfo.gpus) && gpuInfo.gpus.length > 0) {
        parts.push("GPU " + gpuInfo.gpus[0].utilizationPct + "%");
      } else {
        parts.push("GPU --");
      }
    }
    parts.push("WSL " + (wslInfo.installed ? "ONLINE" : "OFFLINE"));
    tb.textContent = parts.join(" \u00b7 ");
  }

  let systemSample = null;

  async function pollSystem() {
    const ipc = window.desktopIpc;
    if (ipc === undefined) return;
    try {
      const result = await ipc.system.getStatus();
      if (result?.ok && result.value !== undefined) {
        systemSample = result.value;
        renderSystem();
      }
    } catch {
      /* IPC unavailable (standalone preview) — keep last sample */
    }
  }

  function startSystem(intervalMs) {
    stopSystem();
    void pollSystem();
    systemTimer = setInterval(pollSystem, intervalMs || 3000);
  }

  function stopSystem() {
    if (systemTimer !== 0) clearInterval(systemTimer);
    systemTimer = 0;
  }

  async function refreshWsl() {
    const ipc = window.desktopIpc;
    if (ipc === undefined) return;
    try {
      const result = await ipc.system.detectWsl();
      if (result !== null && typeof result === "object") {
        wslInfo = result;
        renderSystem();
      }
    } catch {
      /* keep last state */
    }
  }

  async function refreshGpu() {
    const ipc = window.desktopIpc;
    if (ipc === undefined) return;
    try {
      gpuInfo = await ipc.system.getGpu();
      renderSystem();
    } catch {
      gpuInfo = { ok: false, reason: "unavailable" };
      renderSystem();
    }
    return gpuInfo;
  }

  /* ---- Init --------------------------------------------------------------- */
  function init() {
    agentsEl = document.getElementById("agents-list");
    workspaceEl = document.getElementById("workspace-body");
    terminalEl = document.getElementById("terminal-body");

    renderAgents();
    renderWorkspace();

    const clearBtn = document.getElementById("term-clear");
    const copyBtn = document.getElementById("term-copy");
    if (clearBtn) clearBtn.addEventListener("click", terminalClear);
    if (copyBtn) {
      copyBtn.addEventListener("click", () => {
        void terminalCopy();
      });
    }
    if (terminalEl) {
      terminalEl.addEventListener("scroll", () => {
        autoScroll = terminalEl.scrollHeight - terminalEl.scrollTop - terminalEl.clientHeight < 24;
      });
    }

    DSH.core.on("change", ({ state }) => {
      applyCoreState(state);
      const label = { IDLE: "SYSTEM READY", THINKING: "THINKING", PLANNING: "PLANNING", EXECUTING: "EXECUTING", VERIFYING: "VERIFYING", DONE: "DONE", FAILED: "ERROR" }[state];
      const tb = document.getElementById("tb-state");
      if (tb !== null) {
        tb.textContent = label ?? "SYSTEM READY";
      }
      const ready = document.getElementById("tb-ready");
      if (ready !== null) {
        ready.textContent = state === "FAILED" ? "\u25cf ERROR" : "\u25cf " + (label ?? "SYSTEM READY");
      }
    });
  }

  DSH.panels = {
    init,
    setWorkspace,
    getWorkspace,
    terminal: {
      add: terminalAdd,
      clear: terminalClear,
      copy: terminalCopy,
      beginStream: terminalBeginStream,
      get lines() {
        return termLines.slice();
      }
    },
    system: {
      start: startSystem,
      stop: stopSystem,
      refreshWsl,
      refreshGpu,
      get wsl() {
        return wslInfo;
      },
      get gpu() {
        return gpuInfo;
      },
      get sample() {
        return systemSample;
      }
    },
    agents: {
      render: renderAgents,
      applyCoreState
    }
  };
})();

/* ==========================================================================
   DeepSeek Harness — Command Registry + Intent Router.
   The desktop's command system: a data-driven registry (no if/else chains),
   scoring-based suggestions, and a natural-language intent router.
   Phase 1 ships the engine; command definitions register themselves later.
   ========================================================================== */
(function () {
  "use strict";

  const DSH = (window.DSH = window.DSH || {});

  const REGISTRY = [];
  const RECENT_IDS = [];
  const MAX_RECENT = 6;

  const KIND_LABELS = {
    system: "SYSTEM",
    workspace: "WORKSPACE",
    ai: "AI",
    app: "APP",
    search: "SEARCH"
  };

  /* ---- Intent rules (data, not control flow) ------------------------------ */
  // "打开 X / 启动 X / open X / launch X" → app dictionary lookup.
  const LAUNCH_PATTERN = /^(?:打开|启动|open|launch|start|运行)\s+(.+)$/iu;
  const APP_DICTIONARY = [
    { keys: ["vs code", "vscode", "vs", "code", "visual studio code"], command: "open-vscode" },
    { keys: ["wsl", "ubuntu", "linux"], command: "launch-wsl" },
    { keys: ["github", "git hub"], command: "open-github" },
    { keys: ["workspace", "工作区", "项目目录"], command: "open-workspace" },
    { keys: ["terminal", "终端"], command: "toggle-terminal" },
    { keys: ["console", "harness", "控制台", "对话"], command: "show-console" }
  ];

  // Loose keyword → command hints for short inputs ("gpu", "清理"…).
  const KEYWORD_HINTS = [
    { keywords: ["gpu", "显卡", "nvidia"], command: "check-gpu" },
    { keywords: ["wsl"], command: "launch-wsl" },
    { keywords: ["clear", "清理", "清空"], command: "clear-terminal" },
    { keywords: ["workspace", "工作区", "目录", "项目"], command: "open-workspace" },
    { keywords: ["analyze", "分析", "总结"], command: "analyze-workspace" },
    { keywords: ["introduce", "介绍", "这是什么"], command: "introduce-workspace" },
    { keywords: ["run", "运行", "启动项目", "dev"], command: "run-project" },
    { keywords: ["terminal", "终端"], command: "toggle-terminal" },
    { keywords: ["console", "控制台", "对话", "chat", "ask"], command: "show-console" },
    { keywords: ["help", "帮助", "命令"], command: "list-commands" }
  ];

  /* ---- Normalization + scoring -------------------------------------------- */
  function normalize(text) {
    return String(text ?? "")
      .toLowerCase()
      .replace(/\s+/gu, " ")
      .trim();
  }

  function register(command) {
    if (command === null || typeof command !== "object" || typeof command.id !== "string" || command.id === "") {
      throw new Error("command registry: entry needs a non-empty id");
    }
    if (typeof command.name !== "string" || command.name === "") {
      throw new Error("command registry: " + command.id + " needs a name");
    }
    if (typeof command.run !== "function") {
      throw new Error("command registry: " + command.id + " needs a run() function");
    }
    const existing = REGISTRY.findIndex((entry) => entry.id === command.id);
    if (existing !== -1) REGISTRY.splice(existing, 1);
    REGISTRY.push(command);
    return () => {
      const at = REGISTRY.indexOf(command);
      if (at !== -1) REGISTRY.splice(at, 1);
    };
  }

  function byId(id) {
    return REGISTRY.find((entry) => entry.id === id) ?? null;
  }

  function all() {
    return REGISTRY.slice();
  }

  /** Score one command against a normalized query. Higher = better match. */
  function score(command, query) {
    if (query === "") return 0;
    const aliases = (command.aliases || []).map(normalize);
    if (aliases.includes(query)) return 1;
    for (const alias of aliases) {
      if (alias.length > 1 && query.includes(alias)) return 0.92;
    }
    const name = normalize(command.name);
    if (name === query) return 0.98;
    if (name.includes(query)) return 0.82;
    if (query.includes(name) && name.length > 2) return 0.7;
    for (const keyword of command.keywords || []) {
      const norm = normalize(keyword);
      if (norm.length === 0) continue;
      if (query === norm) return 0.9;
      if (query.includes(norm)) return 0.78;
    }
    const description = normalize(command.description || "");
    if (description.includes(query)) return 0.45;
    return 0;
  }

  /** Ranked suggestions for a query; empty query returns recent + suggested. */
  function suggest(query, limit) {
    const q = normalize(query);
    const cap = typeof limit === "number" && limit > 0 ? limit : 6;
    const ranked = [];
    for (const command of REGISTRY) {
      let value = score(command, q);
      let reason = "match";
      if (q === "") {
        if (RECENT_IDS.includes(command.id)) {
          value = 0.5 + (MAX_RECENT - RECENT_IDS.indexOf(command.id)) / 100;
          reason = "recent";
        } else if (command.suggested) {
          value = 0.2;
          reason = "suggested";
        } else {
          continue;
        }
      }
      if (value > 0) ranked.push({ command, score: value, reason });
    }
    ranked.sort((a, b) => b.score - a.score || REGISTRY.indexOf(a.command) - REGISTRY.indexOf(b.command));
    return ranked.slice(0, cap);
  }

  /** Route raw input to a command, a launch dictionary hit, or AI fallback. */
  function route(input) {
    const q = normalize(input);
    if (q === "") return { command: null, ai: false, input };

    const ranked = suggest(q, 1);
    if (ranked.length > 0 && ranked[0].score >= 0.78) {
      return { command: ranked[0].command, ai: false, input };
    }

    const launch = LAUNCH_PATTERN.exec(q);
    if (launch !== null) {
      const target = normalize(launch[1]);
      for (const entry of APP_DICTIONARY) {
        if (entry.keys.some((key) => target === key || target.includes(key))) {
          const command = byId(entry.command);
          if (command !== null) return { command, ai: false, input };
        }
      }
      // "打开 <unknown app>" — an AI question, not a local action.
      return { command: null, ai: true, input };
    }

    for (const hint of KEYWORD_HINTS) {
      if (hint.keywords.some((keyword) => q === keyword || q.includes(keyword))) {
        const command = byId(hint.command);
        if (command !== null) return { command, ai: false, input };
      }
    }

    return { command: null, ai: true, input };
  }

  function remember(id) {
    RECENT_IDS.splice(0, RECENT_IDS.length, ...[id, ...RECENT_IDS.filter((entry) => entry !== id)].slice(0, MAX_RECENT));
  }

  function kindLabel(kind) {
    return KIND_LABELS[kind] || "COMMAND";
  }

  DSH.commands = {
    register,
    byId,
    all,
    suggest,
    route,
    remember,
    normalize,
    kindLabel,
    get registry() {
      return REGISTRY.slice();
    }
  };
})();

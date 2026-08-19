/* ==========================================================================
   DeepSeek Harness — Built-in commands (Phase 2/3).
   Real system actions: VS Code, WSL, GPU, workspace, paths, GitHub, plus
   the in-app commands (terminal, console view, clear, help).
   AI-backed commands (ask/analyze/introduce/run-project) are declared here
   with honest behavior until the Harness backend is wired (Phase 6).
   ========================================================================== */
(function () {
  "use strict";

  const DSH = (window.DSH = window.DSH || {});
  const C = DSH.commands;

  function ipc() {
    return window.desktopIpc;
  }

  function workspace() {
    return DSH.app?.getWorkspace() ?? null;
  }

  function gpuLines(gpus) {
    const lines = [];
    for (const gpu of gpus) {
      lines.push({
        kind: "out",
        text: `${gpu.name}  util ${gpu.utilizationPct}%  vram ${gpu.memoryUsedMb}/${gpu.memoryTotalMb} MB  temp ${gpu.temperatureC}\u00b0C`
      });
    }
    return lines;
  }

  /* ---- AI commands (real DeepSeek backend via the Host proxy) -------------- */
  function ai() {
    return DSH.hostEvents;
  }

  function aiAsk(text, cwd) {
    return ai().ask(text, { cwd });
  }

  /* ---- Registry ------------------------------------------------------------ */
  const DEFS = [
    {
      id: "ask-ai",
      name: "Ask DeepSeek",
      description: "Ask the DeepSeek Harness agent anything",
      aliases: ["ask deepseek", "问 deepseek", "ask", "问一下", "问"],
      keywords: ["deepseek", "ai"],
      kind: "ai",
      suggested: true,
      thinking: "Routing to DeepSeek\u2026",
      executing: "DeepSeek is answering\u2026",
      run: async (ctx) => {
        const question = String(ctx.input || "")
          .replace(/^(ask deepseek|问 deepseek|ask|问|deepseek|ai)\s*/iu, "")
          .trim();
        if (question === "") {
          DSH.app?.setView("console");
          return { ok: true, message: "Harness Console ready \u2014 type your question there." };
        }
        const result = await aiAsk(question, workspace()?.path ?? null);
        if (!result.ok) {
          DSH.app?.setView("console");
          return { ok: false, message: result.message + " \u2014 console view opened." };
        }
        return result;
      }
    },
    {
      id: "open-vscode",
      name: "Open VS Code",
      description: "Open the current workspace in VS Code",
      aliases: ["open vs code", "打开 vs code", "打开 vscode", "open vscode", "启动 vs code", "打开 code", "open code"],
      keywords: ["vs code", "vscode", "编辑器", "editor"],
      kind: "system",
      suggested: true,
      plan: ["1. Detect workspace", "2. Launch VS Code"],
      executing: "Launching VS Code\u2026",
      run: async () => {
        const target = workspace()?.path;
        const result = await ipc().system.openVsCode(target);
        if (!result.ok) {
          return { ok: false, message: "VS Code could not be launched: " + result.reason };
        }
        return {
          ok: true,
          message: target ? "VS Code opened with " + workspace().name : "VS Code launched.",
          lines: [{ kind: "out", text: target ? "opening " + target : "opening default window" }]
        };
      }
    },
    {
      id: "launch-wsl",
      name: "Launch WSL",
      description: "Detect WSL and open its default distribution",
      aliases: ["launch wsl", "启动 wsl", "打开 wsl", "open wsl", "wsl"],
      keywords: ["wsl", "ubuntu", "linux"],
      kind: "system",
      suggested: true,
      plan: ["1. Detect WSL", "2. Start default distribution"],
      executing: "Launching WSL\u2026",
      run: async () => {
        const detect = await ipc().system.detectWsl();
        if (!detect.installed) {
          return { ok: false, message: "WSL is not available on this device." };
        }
        const result = await ipc().system.launchWsl();
        if (!result.ok) {
          return { ok: false, message: "WSL failed to start: " + result.reason };
        }
        return {
          ok: true,
          message: "WSL started successfully.",
          lines: [{ kind: "out", text: "default distribution: " + (detect.defaultDistro || "(none)") }]
        };
      }
    },
    {
      id: "check-gpu",
      name: "Check GPU Usage",
      description: "Run nvidia-smi and report GPU utilization",
      aliases: ["check gpu", "查看 gpu", "看看 gpu", "gpu", "查看显卡", "gpu 占用", "check gpu usage", "open gpu monitor"],
      keywords: ["gpu", "显卡", "nvidia"],
      kind: "system",
      suggested: true,
      executing: "Running nvidia-smi\u2026",
      run: async () => {
        const result = await ipc().system.getGpu();
        if (!result.ok) {
          return { ok: false, message: result.reason === "nvidia-smi unavailable" ? "No NVIDIA GPU detected on this device." : result.reason };
        }
        return { ok: true, message: "GPU status retrieved.", lines: gpuLines(result.gpus) };
      }
    },
    {
      id: "open-workspace",
      name: "Open Workspace",
      description: "Choose a project directory and inspect it",
      aliases: ["open workspace", "打开工作区", "打开 workspace", "选择项目", "打开项目目录"],
      keywords: ["workspace", "工作区", "目录", "项目"],
      kind: "workspace",
      suggested: true,
      plan: ["1. Select directory", "2. Read metadata", "3. Detect git state"],
      executing: "Inspecting workspace\u2026",
      run: async () => {
        const result = await ipc().workspace.choose();
        if (!result.ok) {
          if (result.canceled) return { ok: true, message: "Workspace selection canceled." };
          return { ok: false, message: result.reason };
        }
        DSH.app?.setWorkspace(result.meta);
        return {
          ok: true,
          message: "Workspace loaded: " + result.meta.name,
          lines: workspaceLines(result.meta)
        };
      }
    },
    {
      id: "inspect-workspace",
      name: "Inspect Workspace",
      description: "Re-read the current workspace metadata",
      aliases: ["inspect workspace", "检查工作区"],
      keywords: ["inspect"],
      kind: "workspace",
      executing: "Reading workspace\u2026",
      run: async () => {
        const ws = workspace();
        if (ws === null) {
          return { ok: false, message: "No workspace selected. Use \u201cOpen Workspace\u201d first." };
        }
        const result = await ipc().workspace.inspect(ws.path);
        if (!result.ok) return { ok: false, message: result.reason };
        DSH.app?.setWorkspace(result.meta);
        return { ok: true, message: "Workspace refreshed.", lines: workspaceLines(result.meta) };
      }
    },
    {
      id: "open-folder",
      name: "Open Workspace Folder",
      description: "Open the workspace directory in Explorer",
      aliases: ["open folder", "打开目录", "open workspace folder"],
      keywords: ["folder", "文件夹"],
      kind: "system",
      run: async () => {
        const ws = workspace();
        if (ws === null) return { ok: false, message: "No workspace selected." };
        const result = await ipc().system.openPath(ws.path);
        return result.ok ? { ok: true, message: "Opened " + ws.path } : { ok: false, message: result.reason };
      }
    },
    {
      id: "open-github",
      name: "Open GitHub",
      description: "Open github.com in the default browser",
      aliases: ["open github", "打开 github", "github"],
      keywords: ["github"],
      kind: "system",
      executing: "Opening browser\u2026",
      run: async () => {
        const result = await ipc().system.openExternal("https://github.com");
        return result.ok ? { ok: true, message: "Opened github.com" } : { ok: false, message: result.reason };
      }
    },
    {
      id: "toggle-terminal",
      name: "Toggle Terminal",
      description: "Show or hide the terminal panel",
      aliases: ["toggle terminal", "打开终端", "open terminal", "关闭终端"],
      keywords: ["terminal", "终端"],
      kind: "app",
      run: async () => {
        document.getElementById("stage").classList.toggle("terminal-collapsed");
        return { ok: true, message: "Terminal toggled." };
      }
    },
    {
      id: "show-console",
      name: "Open Harness Console",
      description: "Switch to the DeepSeek Harness chat console",
      aliases: ["show console", "打开控制台", "open console", "打开对话", "harness", "console"],
      keywords: ["console", "控制台", "对话", "chat"],
      kind: "app",
      suggested: true,
      run: async () => {
        DSH.app?.setView("console");
        return { ok: true, message: "Harness Console opened." };
      }
    },
    {
      id: "clear-terminal",
      name: "Clear Terminal",
      description: "Clear the terminal output",
      aliases: ["clear terminal", "清理终端", "清空终端", "clear"],
      keywords: ["clear", "清理", "清空"],
      kind: "app",
      run: async () => {
        DSH.panels?.terminal.clear();
        return { ok: true, message: "Terminal cleared." };
      }
    },
    {
      id: "list-commands",
      name: "List Commands",
      description: "Print every registered command",
      aliases: ["list commands", "列出命令", "help", "帮助"],
      keywords: ["help", "帮助", "命令"],
      kind: "app",
      run: async () => {
        const lines = C.all().map((entry) => ({ kind: "out", text: `${entry.name.padEnd(24)} ${entry.description || ""}` }));
        return { ok: true, message: C.all().length + " commands available.", lines };
      }
    },
    {
      id: "analyze-workspace",
      name: "Analyze Current Project",
      description: "Send the workspace to DeepSeek for analysis",
      aliases: ["analyze current project", "分析当前项目", "分析项目", "分析这个项目", "总结当前目录"],
      keywords: ["analyze", "分析", "总结"],
      kind: "ai",
      suggested: true,
      plan: ["1. Collect workspace context", "2. Send to DeepSeek", "3. Stream analysis"],
      executing: "Analyzing project\u2026",
      run: async () => {
        const ws = workspace();
        if (ws === null) return { ok: false, message: "No workspace selected. Use \u201cOpen Workspace\u201d first." };
        const context = [
          `Project: ${ws.name} (${ws.type || "unknown type"})`,
          ws.git ? `Git branch: ${ws.git.branch}` : "",
          ws.scan.languages.length > 0 ? `Languages: ${ws.scan.languages.map((entry) => entry.name).join(", ")}` : "",
          `Files: ${ws.scan.count}`
        ].filter((line) => line !== "").join("\n");
        const prompt = `Analyze the project at ${ws.path}. Context:\n${context}\n\nSummarize its purpose, architecture, and how to run it. Keep it concise.`;
        return aiAsk(prompt, ws.path);
      }
    },
    {
      id: "introduce-workspace",
      name: "Introduce This Project",
      description: "Ask DeepSeek to introduce the current project",
      aliases: ["introduce this project", "介绍这个项目", "介绍项目"],
      keywords: ["introduce", "介绍"],
      kind: "ai",
      plan: ["1. Read project metadata", "2. Ask DeepSeek for an introduction"],
      executing: "DeepSeek is writing an introduction\u2026",
      run: async () => {
        const ws = workspace();
        if (ws === null) return { ok: false, message: "No workspace selected. Use \u201cOpen Workspace\u201d first." };
        const prompt = `Introduce the project at ${ws.path} (${ws.name}${ws.type ? ", " + ws.type : ""}): what it is, its key components, and how to get started. Keep it concise.`;
        return aiAsk(prompt, ws.path);
      }
    },
    {
      id: "run-project",
      name: "Run Project",
      description: "List runnable scripts and start development",
      aliases: ["run project", "运行项目", "启动项目"],
      keywords: ["run", "运行", "dev"],
      kind: "ai",
      plan: ["1. Read package scripts", "2. Start development server"],
      executing: "Starting project\u2026",
      run: async () => {
        const ws = workspace();
        if (ws === null) return { ok: false, message: "No workspace selected. Use \u201cOpen Workspace\u201d first." };
        const scripts = ws.packageJson?.scripts ?? null;
        if (scripts !== null && Object.keys(scripts).length > 0) {
          return {
            ok: true,
            message: "Found " + Object.keys(scripts).length + " script(s).",
            lines: Object.entries(scripts).map(([name, command]) => ({ kind: "out", text: `${name.padEnd(14)} ${command}` }))
          };
        }
        return aiAsk(`The project at ${ws.path} has no package.json scripts. How should it be run? Inspect it and give the exact command.`, ws.path);
      }
    }
  ];

  function workspaceLines(meta) {
    const lines = [];
    lines.push({ kind: "out", text: meta.path });
    if (meta.type) lines.push({ kind: "out", text: "type: " + meta.type });
    if (meta.git) {
      lines.push({ kind: "out", text: "git: " + meta.git.branch });
      if (meta.git.modified > 0 || meta.git.untracked > 0) {
        lines.push({ kind: "out", text: `status: ${meta.git.modified} modified, ${meta.git.untracked} untracked` });
      } else {
        lines.push({ kind: "out", text: "status: clean" });
      }
    }
    lines.push({ kind: "out", text: `files: ${meta.scan.count}` });
    if (meta.scan.languages.length > 0) {
      lines.push({ kind: "out", text: "languages: " + meta.scan.languages.map((entry) => entry.name).join(", ") });
    }
    return lines;
  }

  const disposers = DEFS.map((def) => C.register(def));

  DSH.builtins = {
    dispose() {
      for (const dispose of disposers) dispose();
    }
  };
})();

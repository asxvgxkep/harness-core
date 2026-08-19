// Desktop shell preload — exposes a narrow, fixed IPC surface for the
// AI Command Center. Sandboxed + contextIsolation: only these operations
// cross the bridge; every channel is named explicitly, and event
// subscriptions validate against a fixed allow-list.
const { contextBridge, ipcRenderer } = require("electron");

const KNOWN_EVENTS = new Set(["desktop:reveal", "desktop:services-ready", "desktop:host:event"]);
const STARTUP_EVENTS = new Set(["renderer boot start", "Desktop chrome reveal start", "Desktop first visible frame", "AGENT READY"]);

function markStartup(event, details) {
  ipcRenderer.send("startup:mark", event, details ?? {});
}

window.addEventListener("DOMContentLoaded", () => {
  markStartup("DOMContentLoaded", { renderer: "desktop" });
}, { once: true });

contextBridge.exposeInMainWorld("desktopIpc", {
  getBootInfo() {
    const startedAt = performance.now();
    markStartup("getBootInfo start");
    return ipcRenderer.invoke("desktop:get-boot-info").then(
      (result) => {
        markStartup("getBootInfo end", { durationMs: Number((performance.now() - startedAt).toFixed(3)), ok: result?.ok === true });
        return result;
      },
      (error) => {
        markStartup("getBootInfo end", { durationMs: Number((performance.now() - startedAt).toFixed(3)), error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    );
  },
  system: {
    getStatus() {
      return ipcRenderer.invoke("desktop:system:status");
    },
    getGpu() {
      return ipcRenderer.invoke("desktop:system:gpu");
    },
    detectWsl() {
      return ipcRenderer.invoke("desktop:system:detect-wsl");
    },
    openVsCode(target) {
      return ipcRenderer.invoke("desktop:system:open-vscode", target);
    },
    launchWsl() {
      return ipcRenderer.invoke("desktop:system:launch-wsl");
    },
    openPath(path) {
      return ipcRenderer.invoke("desktop:system:open-path", path);
    },
    openExternal(url) {
      return ipcRenderer.invoke("desktop:system:open-external", url);
    }
  },
  workspace: {
    choose() {
      return ipcRenderer.invoke("desktop:workspace:choose");
    },
    inspect(path) {
      return ipcRenderer.invoke("desktop:workspace:inspect", path);
    }
  },
  host: {
    call(method, payload) {
      return ipcRenderer.invoke("desktop:host:call", method, payload);
    },
    eventsStart() {
      return ipcRenderer.invoke("desktop:host:events:start");
    },
    eventsStop() {
      return ipcRenderer.invoke("desktop:host:events:stop");
    }
  },
  startup: {
    mark(event, details) {
      if (!STARTUP_EVENTS.has(event)) return;
      markStartup(event, details);
    }
  },
  on(channel, callback) {
    if (typeof callback !== "function") return () => {};
    if (!KNOWN_EVENTS.has(channel)) return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  }
});

markStartup("preload ready", { renderer: "desktop" });

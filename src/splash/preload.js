// Splash preload — exposes a minimal, fixed IPC surface for the boot handshake.
// Sandboxed + contextIsolation: only these narrow operations cross the bridge.
const { contextBridge, ipcRenderer } = require("electron");

function markStartup(event, details) {
  ipcRenderer.send("startup:mark", event, details ?? {});
}

contextBridge.exposeInMainWorld("splashIpc", {
  // The main process calls this when the main window is ready and the minimum
  // splash duration has elapsed.
  onExit(callback) {
    if (typeof callback !== "function") return;
    ipcRenderer.on("splash:exit", () => callback());
  },
  // Energy Gate: the renderer calls this mid-wave, the moment the expanding
  // ring has covered the splash, so the main window can be shown underneath.
  reveal() {
    // Warm starts may enter the handoff before the base confirmation animation
    // reaches its natural end marker. Emit the same boundary here as a fallback;
    // the main-process trace keeps the first occurrence for interval math.
    markStartup("Splash animation end", { phase: "handoff-fallback" });
    ipcRenderer.send("splash:reveal");
  },
  animationEnd() {
    markStartup("Splash animation end");
  },
  mainAnimationLastMotion(details) {
    markStartup("Splash main animation last visual motion", details);
  },
  exitVisualStart(details) {
    markStartup("Splash exit visual start", details);
  },
  // The renderer calls this once the splash has fully faded after the gate.
  exitDone() {
    markStartup("Splash exit animation end");
    ipcRenderer.send("splash:exit-done");
  }
});

markStartup("Splash preload ready", { renderer: "splash" });

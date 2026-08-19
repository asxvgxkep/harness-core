/** Splash Screen configuration — edit here to change the boot animation.
 *  The packaged bundle inlines this module; keep the two in sync when editing.
 */
/** The workspace name shown as the hero line at the end of the splash. */
export const WORKSPACE_DISPLAY_NAME = "Harness Core Workspace";
export const SPLASH_CONFIG = {
    /** Set to false to skip the splash entirely and boot straight to the main window. */
    enabled: true,
    /** Display name for the workspace (the most prominent line). */
    workspaceName: WORKSPACE_DISPLAY_NAME,
    /** Minimum time the splash stays on screen, even if the Host is already ready. */
    minimumSplashDurationMs: 2200,
    /** Scales particle count and glow intensity (keep it subtle: 0.25–1.5). */
    animationIntensity: 1,
    /** Splash window dimensions (px). */
    width: 860,
    height: 500,
    /** Fallback if the renderer never acknowledges the energy-gate handshake. */
    exitFallbackMs: 1800,
};
//# sourceMappingURL=splash-config.js.map

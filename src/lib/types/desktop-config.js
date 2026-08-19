/** Desktop Shell constants: IPC channel names, host API whitelist and limits.
 *  The packaged bundle inlines this module; keep the two in sync when editing.
 */

/** Every IPC channel the desktop renderer may touch, named explicitly. */
export const DESKTOP_IPC = {
    getBootInfo: 'desktop:get-boot-info',
    systemStatus: 'desktop:system:status',
    systemGpu: 'desktop:system:gpu',
    systemDetectWsl: 'desktop:system:detect-wsl',
    systemOpenVsCode: 'desktop:system:open-vscode',
    systemLaunchWsl: 'desktop:system:launch-wsl',
    systemOpenPath: 'desktop:system:open-path',
    systemOpenExternal: 'desktop:system:open-external',
    workspaceChoose: 'desktop:workspace:choose',
    workspaceInspect: 'desktop:workspace:inspect',
    hostCall: 'desktop:host:call',
    hostEventsStart: 'desktop:host:events:start',
    hostEventsStop: 'desktop:host:events:stop',
    revealEvent: 'desktop:reveal',
    servicesReadyEvent: 'desktop:services-ready',
    hostEvent: 'desktop:host:event',
};

/** Whitelisted Host API methods the desktop may call. Anything else is rejected. */
export const HOST_API_METHODS = new Set([
    'host.describe',
    'session.list',
    'session.search',
    'session.create',
    'session.history',
    'session.prompt',
    'session.cancel',
    'workspace.list',
    'workspace.create',
    'llm.providers',
    'llm.models',
]);

/** Default timeout for proxied Host unary calls. */
export const HOST_API_TIMEOUT_MS = 30_000;

/** How often (ms) the desktop renderer is allowed to pull system status. */
export const SYSTEM_STATUS_MIN_INTERVAL_MS = 1_500;

/** GPU query cache lifetime (ms) — nvidia-smi is cheap but not free. */
export const GPU_CACHE_MS = 5_000;

/** WSL detection cache lifetime (ms). */
export const WSL_CACHE_MS = 5 * 60_000;

/** Hard cap for workspace directory walks (entries visited). */
export const WORKSPACE_SCAN_MAX_ENTRIES = 4_000;

/** Timeout (ms) for git subprocess probes during workspace inspection. */
export const GIT_PROBE_TIMEOUT_MS = 4_000;

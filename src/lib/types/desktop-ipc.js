/** Desktop shell IPC: a narrow, whitelisted bridge between the desktop
 *  renderer and main-process system actions. No arbitrary exec, no arbitrary
 *  paths — every handler validates its inputs before touching the system.
 *  The packaged bundle inlines this module; keep the two in sync when editing.
 */
import { ipcMain } from 'electron';
import { inspectWorkspace } from './desktop-workspace.js';
import { DESKTOP_IPC, GPU_CACHE_MS, SYSTEM_STATUS_MIN_INTERVAL_MS, WSL_CACHE_MS } from './desktop-config.js';
import { createSystemMonitor, detectWsl, launchWsl, openVsCode, queryGpu } from './desktop-system.js';
import { createDesktopHostProxy } from './desktop-host.js';

/** Validate the one external-URL shape the desktop may open. */
function isSafeExternalUrl(raw) {
    try {
        const url = new URL(raw);
        return url.protocol === 'http:' || url.protocol === 'https:';
    }
    catch {
        return false;
    }
}

/** Validate a workspace path shape: absolute, no traversal games that matter. */
function isPathLike(raw) {
    return typeof raw === 'string' && raw.length > 0 && raw.length <= 1024 && !raw.includes('\0');
}

/**
 * Register every desktop:* IPC handler and return a disposer.
 * @param options - electron services plus the running host proxy factory.
 */
export function registerDesktopIpc(options) {
    const { getMainWindow, workspaceName, getHostOrigin, forwardHostEvent } = options;
    const monitor = createSystemMonitor();

    let hostProxy = undefined;
    let lastStatusAt = 0;
    let gpuCache = { at: 0, value: { ok: false, reason: 'not queried' } };
    let wslCache = { at: 0, value: { installed: false, online: false, defaultDistro: null, reason: 'not queried' } };

    const ensureHostProxy = () => {
        const origin = getHostOrigin();
        if (origin === undefined) {
            return undefined;
        }
        hostProxy ??= createDesktopHostProxy({
            origin,
            forwardEvent: (frame) => {
                const window = getMainWindow();
                if (window !== undefined && !window.isDestroyed()) {
                    window.webContents.send(DESKTOP_IPC.hostEvent, frame);
                }
                forwardHostEvent?.(frame);
            },
        });
        return hostProxy;
    };

    const handlers = [];
    const handle = (channel, listener) => {
        ipcMain.handle(channel, listener);
        handlers.push(channel);
    };

    handle(DESKTOP_IPC.getBootInfo, () => ({
        ok: true,
        value: {
            hostOrigin: getHostOrigin() ?? null,
            hostReady: getHostOrigin() !== undefined,
            workspaceName,
            platform: process.platform,
        },
    }));

    handle(DESKTOP_IPC.systemStatus, () => {
        const now = Date.now();
        if (now - lastStatusAt < SYSTEM_STATUS_MIN_INTERVAL_MS) {
            return { ok: true, throttled: true };
        }
        lastStatusAt = now;
        return { ok: true, value: monitor.sample() };
    });

    handle(DESKTOP_IPC.systemGpu, async () => {
        const now = Date.now();
        if (now - gpuCache.at < GPU_CACHE_MS) {
            return gpuCache.value;
        }
        const value = await queryGpu();
        gpuCache = { at: now, value };
        return value;
    });

    handle(DESKTOP_IPC.systemDetectWsl, async () => {
        const now = Date.now();
        if (now - wslCache.at < WSL_CACHE_MS) {
            return wslCache.value;
        }
        const value = await detectWsl();
        wslCache = { at: now, value };
        return value;
    });

    handle(DESKTOP_IPC.systemOpenVsCode, async (_event, target) => {
        const path = isPathLike(target) ? target : undefined;
        return openVsCode({ shell: options.shell, target: path });
    });

    handle(DESKTOP_IPC.systemLaunchWsl, async () => launchWsl());

    handle(DESKTOP_IPC.systemOpenPath, async (_event, rawPath) => {
        if (!isPathLike(rawPath)) {
            return { ok: false, reason: 'invalid path' };
        }
        const error = await options.shell.openPath(rawPath);
        return error === '' ? { ok: true } : { ok: false, reason: error };
    });

    handle(DESKTOP_IPC.systemOpenExternal, async (_event, rawUrl) => {
        if (!isSafeExternalUrl(rawUrl)) {
            return { ok: false, reason: 'only http/https URLs may be opened' };
        }
        await options.shell.openExternal(rawUrl);
        return { ok: true };
    });

    handle(DESKTOP_IPC.workspaceChoose, async () => {
        const window = getMainWindow();
        if (window === undefined || window.isDestroyed()) {
            return { ok: false, reason: 'no window' };
        }
        const result = await options.dialog.showOpenDialog(window, {
            title: 'Select Workspace',
            properties: ['openDirectory'],
        });
        if (result.canceled || result.filePaths.length === 0) {
            return { ok: false, canceled: true };
        }
        return inspectWorkspace(result.filePaths[0], options.run);
    });

    handle(DESKTOP_IPC.workspaceInspect, async (_event, rawPath) => {
        if (!isPathLike(rawPath)) {
            return { ok: false, reason: 'invalid path' };
        }
        return inspectWorkspace(rawPath, options.run);
    });

    handle(DESKTOP_IPC.hostCall, async (_event, method, payload) => {
        if (typeof method !== 'string') {
            return { ok: false, error: { code: 'forbidden', message: 'invalid host method', details: {} }, rpcId: null };
        }
        const proxy = ensureHostProxy();
        if (proxy === undefined) {
            return { ok: false, error: { code: 'service_initializing', message: 'Harness services are still initializing', details: {} }, rpcId: null };
        }
        return proxy.call(method, payload ?? {});
    });

    handle(DESKTOP_IPC.hostEventsStart, () => {
        const proxy = ensureHostProxy();
        if (proxy === undefined) {
            return { ok: false, initializing: true };
        }
        proxy.events.start();
        return { ok: true };
    });

    handle(DESKTOP_IPC.hostEventsStop, () => {
        hostProxy?.events.stop();
        return { ok: true };
    });

    return () => {
        for (const channel of handlers) {
            ipcMain.removeHandler(channel);
        }
        hostProxy?.close();
        hostProxy = undefined;
    };
}

/** Ask the desktop renderer to enter its ready phase. Idempotent per window. */
export function sendDesktopReveal(getMainWindow) {
    const window = getMainWindow();
    if (window !== undefined && !window.isDestroyed()) {
        window.webContents.send(DESKTOP_IPC.revealEvent);
    }
}

/** Notify the renderer that the Host is ready without coupling it to reveal. */
export function sendDesktopServicesReady(getMainWindow, value) {
    const window = getMainWindow();
    if (window !== undefined && !window.isDestroyed()) {
        window.webContents.send(DESKTOP_IPC.servicesReadyEvent, { ok: true, value });
    }
}

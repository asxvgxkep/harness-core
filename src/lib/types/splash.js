/** Frameless, taskbar-less splash window and its handshake with the main window.
 *  The packaged bundle inlines this module; keep the two in sync when editing.
 */
import { BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import { SPLASH_CONFIG } from './splash-config.js';

const SPLASH_EXIT_CHANNEL = 'splash:exit';
const SPLASH_EXIT_DONE_CHANNEL = 'splash:exit-done';
const SPLASH_REVEAL_CHANNEL = 'splash:reveal';

let splashWindow;
let splashShownAt = 0;
let resolveSplashShown;
let splashShownPromise = Promise.resolve();
let splashFadeTimer;
let isQuitting = () => false;
let getMainWindow = () => undefined;
let revealHook = () => {};

/** Give the splash access to the desktop lifecycle's quitting state. */
export function setSplashLifecycle(quitting, windowGetter) {
    isQuitting = quitting;
    getMainWindow = windowGetter ?? (() => undefined);
}
/** Called by the shell the instant the splash reveals the main window. */
export function setSplashRevealHook(hook) {
    revealHook = typeof hook === 'function' ? hook : () => {};
}
/** Create the splash and show it as soon as its first frame is ready. */
export function createSplashWindow(desktopDir) {
    if (!SPLASH_CONFIG.enabled)
        return undefined;
    splashShownPromise = new Promise(resolve => {
        resolveSplashShown = resolve;
    });
    const splash = new BrowserWindow({
        width: SPLASH_CONFIG.width,
        height: SPLASH_CONFIG.height,
        show: false,
        frame: false,
        resizable: false,
        movable: true,
        center: true,
        skipTaskbar: true,
        hasShadow: false,
        backgroundColor: '#04070d',
        roundedCorners: true,
        webPreferences: {
            preload: join(desktopDir, 'splash', 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true,
            backgroundThrottling: false,
        },
    });
    splashWindow = splash;
    splash.on('closed', () => {
        if (splashFadeTimer !== undefined)
            clearInterval(splashFadeTimer);
        splashFadeTimer = undefined;
        if (splashWindow === splash)
            splashWindow = undefined;
        resolveSplashShown?.();
        resolveSplashShown = undefined;
    });
    const query = {
        workspace: SPLASH_CONFIG.workspaceName,
        min: String(SPLASH_CONFIG.minimumSplashDurationMs),
        intensity: String(SPLASH_CONFIG.animationIntensity),
    };
    void splash.loadFile(join(desktopDir, 'splash', 'splash.html'), { query });
    splash.once('ready-to-show', () => {
        if (splash.isDestroyed() || isQuitting()) {
            resolveSplashShown?.();
            resolveSplashShown = undefined;
            return;
        }
        splash.showInactive();
        splashShownAt = Date.now();
        resolveSplashShown?.();
        resolveSplashShown = undefined;
    });
    return splash;
}
/** Tear the splash down. Safe to call at any point in the lifecycle. */
export function closeSplash() {
    const splash = splashWindow;
    if (splashFadeTimer !== undefined)
        clearInterval(splashFadeTimer);
    splashFadeTimer = undefined;
    if (splash !== undefined && !splash.isDestroyed()) {
        splash.hide();
        splash.destroy();
    }
    splashWindow = undefined;
    resolveSplashShown?.();
    resolveSplashShown = undefined;
}
/** Cross-fade the still-moving splash over the already-visible Desktop. */
function fadeSplashWindow(splash, durationMs = 240) {
    if (process.platform === 'linux' || typeof splash.setOpacity !== 'function')
        return;
    if (splashFadeTimer !== undefined)
        clearInterval(splashFadeTimer);
    const startedAt = Date.now();
    splashFadeTimer = setInterval(() => {
        if (splash.isDestroyed()) {
            clearInterval(splashFadeTimer);
            splashFadeTimer = undefined;
            return;
        }
        const progress = Math.min(1, (Date.now() - startedAt) / durationMs);
        const eased = 1 - Math.pow(1 - progress, 2);
        splash.setOpacity(Math.max(0, 1 - eased));
        if (progress >= 1) {
            clearInterval(splashFadeTimer);
            splashFadeTimer = undefined;
        }
    }, 16);
}
/** Resolve once the minimum splash display time has elapsed. */
export async function waitForSplashMinimum() {
    if (!SPLASH_CONFIG.enabled)
        return;
    await splashShownPromise;
    if (splashShownAt === 0)
        return;
    const remaining = SPLASH_CONFIG.minimumSplashDurationMs - (Date.now() - splashShownAt);
    if (remaining <= 0)
        return;
    await new Promise(resolve => {
        setTimeout(resolve, remaining);
    });
}
/** Bring the main window to the front. Idempotent and quit-safe. */
export function revealMainWindow() {
    if (isQuitting())
        return;
    const mainWindow = getMainWindow();
    if (mainWindow === undefined || mainWindow.isDestroyed())
        return;
    mainWindow.show();
    mainWindow.focus();
    // Barely-perceptible 0.97 -> 1 settle (~135ms) to soften the window swap.
    // The translucent steps stay tiny so no desktop ever shows through, and the
    // timer self-disposes if the window goes away mid-transition.
    if (typeof mainWindow.setOpacity === 'function' && process.platform !== 'linux') {
        mainWindow.setOpacity(0.97);
        const steps = [0.985, 0.995, 1];
        let step = 0;
        const timer = setInterval(() => {
            if (mainWindow === undefined || mainWindow.isDestroyed()) {
                clearInterval(timer);
                return;
            }
            if (step >= steps.length) {
                clearInterval(timer);
                mainWindow.setOpacity(1);
                return;
            }
            mainWindow.setOpacity(steps[step]);
            step++;
        }, 45);
    }
}
/**
 * Run the AI Core Energy Gate handoff. The renderer plays the gate and:
 *   1. sends `splash:reveal` mid-wave  -> show the main window underneath;
 *   2. sends `splash:exit-done` after  -> close the splash.
 * Both events (or the fallback timer) must occur before this resolves.
 */
export function runSplashExit() {
    const splash = splashWindow;
    if (splash === undefined || splash.isDestroyed())
        return Promise.resolve(false);
    return new Promise(resolve => {
        let revealed = false;
        let finished = false;
        let settled = false;
        const settle = () => {
            if (settled)
                return;
            settled = true;
            ipcMain.removeListener(SPLASH_REVEAL_CHANNEL, onReveal);
            ipcMain.removeListener(SPLASH_EXIT_DONE_CHANNEL, onFinished);
            clearTimeout(fallbackTimer);
            resolve(revealed);
        };
        const onReveal = () => {
            if (revealed)
                return;
            revealed = true;
            revealMainWindow();
            revealHook();
            fadeSplashWindow(splash);
            if (finished)
                settle();
        };
        const onFinished = () => {
            if (finished)
                return;
            finished = true;
            closeSplash();
            if (revealed)
                settle();
        };
        const fallbackTimer = setTimeout(() => {
            onReveal();
            onFinished();
        }, SPLASH_CONFIG.exitFallbackMs);
        ipcMain.once(SPLASH_REVEAL_CHANNEL, onReveal);
        ipcMain.once(SPLASH_EXIT_DONE_CHANNEL, onFinished);
        splash.webContents.send(SPLASH_EXIT_CHANNEL);
    });
}
//# sourceMappingURL=splash.js.map

/** Desktop system actions: CPU/MEM sampling, WSL detect/launch, GPU (nvidia-smi),
 *  opening VS Code / paths / external URLs. Every spawn uses a fixed argument
 *  list — user input is never interpolated into a shell command line.
 *  The packaged bundle inlines this module; keep the two in sync when editing.
 */
import { spawn } from 'node:child_process';
import os from 'node:os';

/** Run a fixed command, capture output, resolve {code, stdout, stderr, error}.
 *  Never throws; timeout and spawn failures surface as results. */
export function runFixed(command, args, { timeoutMs = 8_000, cwd } = {}) {
    return new Promise((resolve) => {
        let child;
        let settled = false;
        const stdout = [];
        const stderr = [];
        const settle = (result) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve(result);
        };
        const timer = setTimeout(() => {
            child?.kill();
            settle({ code: null, timedOut: true, stdout: stdout.join(''), stderr: stderr.join(''), error: `timed out after ${timeoutMs}ms` });
        }, timeoutMs);
        try {
            child = spawn(command, args, {
                cwd,
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            });
        }
        catch (error) {
            settle({ code: null, timedOut: false, stdout: '', stderr: '', error: error instanceof Error ? error.message : String(error) });
            return;
        }
        child.stdout.on('data', (chunk) => stdout.push(chunk.toString()));
        child.stderr.on('data', (chunk) => stderr.push(chunk.toString()));
        child.on('error', (error) => {
            settle({ code: null, timedOut: false, stdout: stdout.join(''), stderr: stderr.join(''), error: error.message });
        });
        child.on('close', (code) => {
            settle({ code, timedOut: false, stdout: stdout.join(''), stderr: stderr.join(''), error: undefined });
        });
    });
}

/** Launch a detached process whose output we do not need (console apps). */
export function spawnDetached(command, args) {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(command, args, {
                detached: true,
                stdio: 'ignore',
                windowsHide: false,
            });
        }
        catch (error) {
            resolve({ ok: false, reason: error instanceof Error ? error.message : String(error) });
            return;
        }
        child.on('error', (error) => {
            resolve({ ok: false, reason: error.message });
        });
        child.on('spawn', () => {
            resolve({ ok: true, pid: child.pid ?? undefined });
        });
        child.unref();
    });
}

/** Parse `nvidia-smi --query-gpu=... --format=csv,noheader,nounits` output.
 *  Pure — unit-tested against captured output. */
export function parseNvidiaSmi(text) {
    const gpus = [];
    for (const raw of text.split(/\r?\n/u)) {
        const line = raw.trim();
        if (line === '')
            continue;
        const cells = line.split(',').map((cell) => cell.trim());
        if (cells.length < 5 || cells.some((cell) => cell === 'N/A' || cell === '[N/A]'))
            continue;
        const gpu = {
            name: cells[0],
            utilizationPct: Number(cells[1]),
            memoryUsedMb: Number(cells[2]),
            memoryTotalMb: Number(cells[3]),
            temperatureC: Number(cells[4]),
        };
        if ([gpu.utilizationPct, gpu.memoryUsedMb, gpu.memoryTotalMb, gpu.temperatureC].some((v) => !Number.isFinite(v)))
            continue;
        gpus.push(gpu);
    }
    return gpus;
}

/** Query GPU state through nvidia-smi; degrades gracefully without an NVIDIA GPU. */
export async function queryGpu() {
    const result = await runFixed('nvidia-smi', [
        '--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu',
        '--format=csv,noheader,nounits',
    ], { timeoutMs: 6_000 });
    if (result.error !== undefined || result.code !== 0) {
        return { ok: false, reason: 'nvidia-smi unavailable' };
    }
    const gpus = parseNvidiaSmi(result.stdout);
    if (gpus.length === 0) {
        return { ok: false, reason: 'no NVIDIA GPU reported' };
    }
    return { ok: true, gpus };
}

/** Parse `wsl --list --quiet` into distribution names. Pure. */
export function parseWslDistros(text) {
    const out = [];
    for (const raw of text.split(/\r?\n/u)) {
        const line = raw.replace(/\0/gu, '').trim();
        if (line === '')
            continue;
        out.push(line);
    }
    return out;
}

/** Detect WSL presence and the default distribution. */
export async function detectWsl() {
    const status = await runFixed('wsl.exe', ['--status'], { timeoutMs: 8_000 });
    if (status.error !== undefined || status.code !== 0) {
        return { installed: false, online: false, defaultDistro: null, reason: 'wsl.exe unavailable' };
    }
    const list = await runFixed('wsl.exe', ['--list', '--quiet'], { timeoutMs: 8_000 });
    const distros = parseWslDistros(list.stdout);
    const defaultDistro = distros[0] ?? null;
    return { installed: true, online: true, defaultDistro, distros };
}

/** Launch the default WSL distribution in its own console window. */
export function launchWsl() {
    return spawnDetached('wsl.exe', []);
}

/** Open a path in VS Code (protocol first, local `code` binary fallback). */
export async function openVsCode({ shell, target }) {
    let opened = false;
    if (target !== undefined) {
        try {
            opened = await shell.openExternal(`vscode://file/${encodeURI(target)}`);
        }
        catch {
            opened = false;
        }
    }
    if (opened)
        return { ok: true, method: 'protocol' };
    const result = await spawnDetached('code', target !== undefined ? [target] : []);
    if (result.ok)
        return { ok: true, method: 'binary' };
    return { ok: false, reason: result.reason };
}

/** CPU + memory sampling. Delta-based usage kept inside the returned closure. */
export function createSystemMonitor() {
    let lastCpus = os.cpus();
    let lastAt = Date.now();
    const cores = lastCpus.length;
    const model = lastCpus[0]?.model ?? 'unknown';
    return {
        get info() {
            return { cores, model };
        },
        sample() {
            const now = Date.now();
            const cpus = os.cpus();
            const elapsed = Math.max(1, now - lastAt);
            let busy = 0;
            let total = 0;
            for (let i = 0; i < cpus.length; i++) {
                const prev = lastCpus[i];
                const curr = cpus[i];
                if (prev === undefined)
                    continue;
                const prevTotal = prev.times.user + prev.times.nice + prev.times.sys + prev.times.idle + prev.times.irq;
                const currTotal = curr.times.user + curr.times.nice + curr.times.sys + curr.times.idle + curr.times.irq;
                const prevBusy = prevTotal - prev.times.idle;
                const currBusy = currTotal - curr.times.idle;
                busy += currBusy - prevBusy;
                total += currTotal - prevTotal;
            }
            lastCpus = cpus;
            lastAt = now;
            const totalMem = os.totalmem();
            const freeMem = os.freemem();
            return {
                cpu: {
                    usagePct: total === 0 ? 0 : Math.round((busy / total) * 100),
                    cores,
                    model,
                },
                mem: {
                    usagePct: Math.round(((totalMem - freeMem) / totalMem) * 100),
                    totalGb: Number((totalMem / 1024 ** 3).toFixed(1)),
                    freeGb: Number((freeMem / 1024 ** 3).toFixed(1)),
                },
                sampledAt: now,
            };
        },
    };
}

/** Proxy for the loopback DSH Web Host HTTP API.
 *  Unary calls: POST /api/<method> with the client-request envelope.
 *  Events: WebSocket /api/events.mux (the current Host transport; frames are
 *  server-request envelope JSON messages) relayed to the desktop renderer,
 *  filtered to sessions the desktop created plus stream-level errors.
 *  The packaged bundle inlines this module; keep the two in sync when editing.
 */
import { randomUUID } from 'node:crypto';
import { HOST_API_METHODS, HOST_API_TIMEOUT_MS } from './desktop-config.js';

const EVENT_RECONNECT_DELAY_MS = 2_000;

/** Build a client-request envelope. */
export function makeClientRequest(method, payload) {
    return {
        type: 'client-request',
        rpcId: randomUUID(),
        method,
        payload: payload ?? {},
    };
}

/** Normalize one unary response into {ok, value|error, rpcId}. Never throws. */
export function parseServerResponse(body) {
    if (body === null || typeof body !== 'object' || body.type !== 'server-response' || typeof body.rpcId !== 'string') {
        return { ok: false, error: { code: 'protocol', message: 'malformed server-response envelope', details: {} }, rpcId: null };
    }
    const result = body.result;
    if (result === null || typeof result !== 'object') {
        return { ok: false, error: { code: 'protocol', message: 'malformed result', details: {} }, rpcId: body.rpcId };
    }
    if (result.ok === true) {
        return { ok: true, value: result.value, rpcId: body.rpcId };
    }
    return { ok: false, error: result.error ?? { code: 'unknown', message: 'host call failed', details: {} }, rpcId: body.rpcId };
}

/** Parse one event-transport message (WebSocket text or SSE data) into a
 *  server-request frame {rpcId, method, payload}, or null. */
export function parseEventMessage(data) {
    let full;
    try {
        full = JSON.parse(data);
    }
    catch {
        return null;
    }
    if (full === null || typeof full !== 'object' || full.type !== 'server-request' || full.payload === null || typeof full.payload !== 'object') {
        return null;
    }
    return {
        rpcId: typeof full.rpcId === 'string' ? full.rpcId : null,
        method: typeof full.method === 'string' ? full.method : null,
        payload: full.payload,
    };
}

/** Abortable sleep used by the reconnect loop. */
function sleep(ms, signal) {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
        }, { once: true });
    });
}

/**
 * Create the host proxy bound to one origin.
 * @param options - origin, WebSocket transport, and an event forwarder.
 * @returns call(), events.start()/stop(), trackSession(), close().
 */
export function createDesktopHostProxy({ origin, forwardEvent, timeoutMs = HOST_API_TIMEOUT_MS, WebSocketTransport = globalThis.WebSocket }) {
    let eventsAbort;
    let eventsRunning = false;
    const trackedSessions = new Set();

    async function call(method, payload) {
        if (!HOST_API_METHODS.has(method)) {
            return { ok: false, error: { code: 'forbidden', message: `host method not allowed: ${method}`, details: {} }, rpcId: null };
        }
        const message = makeClientRequest(method, payload);
        try {
            const response = await fetch(new URL(`/api/${method}`, origin), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(message),
                signal: AbortSignal.timeout(timeoutMs),
            });
            if (!response.ok) {
                return { ok: false, error: { code: 'http', message: `host responded HTTP ${response.status}`, details: {} }, rpcId: message.rpcId };
            }
            const body = await response.json().catch(() => null);
            const parsed = parseServerResponse(body);
            if (parsed.ok && method === 'session.create' && typeof parsed.value?.sessionId === 'string') {
                trackedSessions.add(parsed.value.sessionId);
            }
            return parsed;
        }
        catch (error) {
            return { ok: false, error: { code: 'transport', message: error instanceof Error ? error.message : String(error), details: {} }, rpcId: message.rpcId };
        }
    }

    function eventUrl() {
        const url = new URL('/api/events.mux', origin);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        return url;
    }

    async function readEventLoop(abortSignal) {
        while (!abortSignal.aborted) {
            const socket = new WebSocketTransport(eventUrl());
            let opened = false;
            try {
                await new Promise((resolve, reject) => {
                    socket.addEventListener('open', () => {
                        opened = true;
                        resolve();
                    }, { once: true });
                    socket.addEventListener('error', () => {
                        reject(new Error('event WebSocket failed to open'));
                    }, { once: true });
                });
            }
            catch (error) {
                if (abortSignal.aborted)
                    return;
                forwardEvent?.({ type: 'stream/error', error: { code: 'transport', message: error instanceof Error ? error.message : String(error), details: {} } });
                await sleep(EVENT_RECONNECT_DELAY_MS, abortSignal);
                continue;
            }
            await new Promise((resolve) => {
                const onMessage = (event) => {
                    const data = event?.data;
                    if (typeof data !== 'string')
                        return;
                    const frame = parseEventMessage(data);
                    if (frame === null)
                        return;
                    const sessionId = typeof frame.payload.sessionId === 'string' ? frame.payload.sessionId : null;
                    if (sessionId !== null && !trackedSessions.has(sessionId))
                        return;
                    forwardEvent?.(frame.payload);
                };
                const onClose = () => {
                    socket.removeEventListener('message', onMessage);
                    resolve();
                };
                socket.addEventListener('message', onMessage);
                socket.addEventListener('close', onClose, { once: true });
            });
            if (abortSignal.aborted)
                return;
            forwardEvent?.({ type: 'stream/error', error: { code: 'transport', message: 'event stream closed; reconnecting', details: {} } });
            await sleep(EVENT_RECONNECT_DELAY_MS, abortSignal);
        }
    }

    function stopEvents() {
        eventsRunning = false;
        eventsAbort?.abort();
        eventsAbort = undefined;
    }

    return {
        call,
        trackSession(sessionId) {
            if (typeof sessionId === 'string' && sessionId !== '')
                trackedSessions.add(sessionId);
        },
        events: {
            start() {
                if (eventsRunning)
                    return;
                eventsRunning = true;
                eventsAbort = new AbortController();
                void readEventLoop(eventsAbort.signal);
            },
            stop: stopEvents,
        },
        close() {
            stopEvents();
            trackedSessions.clear();
        },
    };
}

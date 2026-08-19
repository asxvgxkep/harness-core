/* ==========================================================================
   DeepSeek Harness — Desktop AI Core (visual engine + state machine).
   Same visual DNA as the boot sequence: dual segmented HUD rings, breathing
   glow, ambient particle field. The core is the persistent expression of AI
   state: IDLE → THINKING → PLANNING → EXECUTING → VERIFYING → DONE | FAILED.
   One rAF loop drives particles and ring rotation; React-free, GPU-friendly.
   ========================================================================== */
(function () {
  "use strict";

  const DSH = (window.DSH = window.DSH || {});

  const STATE_LABELS = {
    IDLE: "AGENT READY",
    THINKING: "THINKING",
    PLANNING: "PLANNING",
    EXECUTING: "EXECUTING",
    VERIFYING: "VERIFYING",
    DONE: "DONE",
    FAILED: "ERROR"
  };

  // Ring rotation speed per state (deg/s). Same baseline as the boot sequence.
  const HUD_SPEED = {
    IDLE: { inner: 5.5, outer: -4, sweep: 38 },
    THINKING: { inner: 8, outer: -6, sweep: 52 },
    PLANNING: { inner: 13, outer: -10, sweep: 70 },
    EXECUTING: { inner: 11.5, outer: -8.5, sweep: 68 },
    VERIFYING: { inner: 6, outer: -4.5, sweep: 42 },
    DONE: { inner: 5.5, outer: -4, sweep: 38 },
    FAILED: { inner: 1.4, outer: -1, sweep: 0 }
  };

  const stage = document.getElementById("stage");
  const canvas = document.getElementById("particles");
  const ctx = canvas.getContext("2d");
  const coreStateEl = document.getElementById("core-state");
  const coreDetailEl = document.getElementById("core-detail");
  const hudInner = document.getElementById("hud-inner");
  const hudOuter = document.getElementById("hud-outer");
  const hudSweep = document.getElementById("hud-sweep");

  let state = "IDLE";
  let rafId = 0;
  let lastFrame = performance.now();
  let elapsed = 0;
  let particles = [];
  let listeners = { change: [], pulse: [] };
  let hudAngles = { inner: 0, outer: 0, sweep: 0 };
  let hudVel = { inner: 0, outer: 0, sweep: 0, innerBoost: 0, outerBoost: 0 };
  let timers = [];
  let disposeTimer = 0;
  let reducedMotion =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function later(ms, fn) {
    const id = setTimeout(fn, ms);
    timers.push(id);
    return id;
  }

  function emit(event, payload) {
    for (const fn of (listeners[event] || []).slice()) {
      try {
        fn(payload);
      } catch (error) {
        console.error("core listener failed:", error);
      }
    }
  }

  function on(event, fn) {
    if (typeof fn !== "function") return () => {};
    (listeners[event] = listeners[event] || []).push(fn);
    return () => {
      listeners[event] = (listeners[event] || []).filter((entry) => entry !== fn);
    };
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  /* ---- Particle field ---------------------------------------------------- */
  function initParticles() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || stage.clientWidth || 1440;
    const h = canvas.clientHeight || stage.clientHeight || 920;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const count = reducedMotion ? 8 : 42;
    const cx = w / 2;
    const cy = h / 2;
    for (let i = 0; i < count; i++) {
      const roll = Math.random();
      const depth = roll < 0.5 ? 0 : roll < 0.86 ? 1 : 2;
      const angle = Math.random() * Math.PI * 2;
      const dist = 150 + Math.random() * Math.min(w, h) * 0.34;
      particles.push({
        depth,
        x: cx + Math.cos(angle) * dist,
        y: cy + Math.sin(angle) * dist,
        vx: 0,
        vy: 0,
        r: depth === 0 ? 0.4 + Math.random() * 0.5 : depth === 1 ? 0.7 + Math.random() * 0.7 : 1.2 + Math.random() * 0.9,
        alpha: depth === 0 ? 0.025 + Math.random() * 0.05 : depth === 1 ? 0.07 + Math.random() * 0.12 : 0.12 + Math.random() * 0.16,
        hue: 205 + Math.random() * 25,
        driftPhase: Math.random() * Math.PI * 2,
        drawAlpha: 0
      });
    }
  }

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || stage.clientWidth;
    const h = canvas.clientHeight || stage.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function frame(now) {
    const dt = Math.min(0.05, Math.max(0.001, (now - lastFrame) / 1000));
    lastFrame = now;
    elapsed += dt;
    const w = canvas.clientWidth || stage.clientWidth;
    const h = canvas.clientHeight || stage.clientHeight;
    const cx = w / 2;
    const cy = h / 2;
    ctx.clearRect(0, 0, w, h);

    updateHud(dt);
    for (const p of particles) {
      updateParticle(p, dt, cx, cy, w, h);
      drawParticle(p);
    }
    rafId = requestAnimationFrame(frame);
  }

  function updateParticle(p, dt, cx, cy, w, h) {
    let pull = 0;
    let orbit = 0;
    let drift = 0.5 + 0.5 * p.depth;

    if (state === "THINKING") {
      pull = 6;
      drift = 1.6;
    } else if (state === "PLANNING") {
      orbit = 12;
      drift = 0.7;
    } else if (state === "EXECUTING") {
      orbit = 26;
      drift = 0.5;
    } else if (state === "VERIFYING") {
      drift = 0.4;
    } else if (state === "FAILED") {
      drift = 0.18;
    }

    const dx = cx - p.x;
    const dy = cy - p.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const nx = dx / d;
    const ny = dy / d;
    const tx = -ny;
    const ty = nx;

    if (orbit > 0) {
      // Tangential flow around the core (directional, not a spinner).
      const strength = orbit * (0.6 + p.depth * 0.6);
      p.vx += (tx * strength - p.vx * 0.6) * dt;
      p.vy += (ty * strength - p.vy * 0.6) * dt;
      const target = 130 + p.depth * 46;
      const radial = (d - target) * 1.1;
      p.vx += (nx * radial - p.vx * 0.5) * dt;
      p.vy += (ny * radial - p.vy * 0.5) * dt;
    } else {
      const s = drift;
      const ax = Math.sin(elapsed * 0.4 + p.driftPhase) * 5 * s + Math.sin(elapsed * 0.9 + p.driftPhase * 1.7) * 2.2 * s;
      const ay = Math.cos(elapsed * 0.36 + p.driftPhase * 0.8) * 4.4 * s;
      p.vx += (ax - p.vx) * Math.min(1, 0.9 * dt) + nx * pull * dt;
      p.vy += (ay - p.vy) * Math.min(1, 0.9 * dt) + ny * pull * dt;
    }

    p.x += p.vx * dt;
    p.y += p.vy * dt;

    if (p.x < -12) p.x = w + 12;
    if (p.x > w + 12) p.x = -12;
    if (p.y < -12) p.y = h + 12;
    if (p.y > h + 12) p.y = -12;

    let modeAlpha = 1;
    if (state === "EXECUTING" || state === "PLANNING") {
      modeAlpha = 1.15;
    } else if (state === "FAILED") {
      modeAlpha = 0.55;
    }
    p.drawAlpha = p.alpha * modeAlpha;
  }

  function drawParticle(p) {
    const a = p.drawAlpha;
    if (a <= 0.004) return;
    if (state === "EXECUTING") {
      // Directional streak: short motion trail along the flow.
      ctx.beginPath();
      ctx.moveTo(p.x - p.vx * 0.09, p.y - p.vy * 0.09);
      ctx.lineTo(p.x, p.y);
      ctx.strokeStyle = "hsla(" + p.hue + ", 90%, 72%, " + (a * 0.5).toFixed(3) + ")";
      ctx.lineWidth = p.r;
      ctx.stroke();
    }
    if (p.depth === 2) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * 2.6, 0, Math.PI * 2);
      ctx.fillStyle = "hsla(" + p.hue + ", 85%, 70%, " + (a * 0.22).toFixed(3) + ")";
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fillStyle = "hsla(" + p.hue + ", 90%, 72%, " + a.toFixed(3) + ")";
    ctx.fill();
  }

  function updateHud(dt) {
    if (reducedMotion) return;
    const speed = HUD_SPEED[state] || HUD_SPEED.IDLE;
    hudVel.innerBoost *= Math.max(0, 1 - 2.2 * dt);
    hudVel.outerBoost *= Math.max(0, 1 - 2.2 * dt);
    hudAngles.inner += (speed.inner + hudVel.innerBoost) * dt;
    hudAngles.outer += (speed.outer + hudVel.outerBoost) * dt;
    hudAngles.sweep += speed.sweep * dt;
    if (hudInner) hudInner.style.transform = "rotate(" + hudAngles.inner.toFixed(2) + "deg)";
    if (hudOuter) hudOuter.style.transform = "rotate(" + hudAngles.outer.toFixed(2) + "deg)";
    if (hudSweep) hudSweep.style.transform = "rotate(" + hudAngles.sweep.toFixed(2) + "deg)";
  }

  /* ---- State machine ------------------------------------------------------ */
  let currentDetail = "";

  /**
   * Render the detail area. Accepts a plain string, or a structured plan
   * ({steps: [], active: n}) rendered as completed / active / pending rows.
   */
  function renderDetail(detail) {
    if (coreDetailEl === undefined || coreDetailEl === null) return;
    coreDetailEl.textContent = "";
    if (typeof detail === "string") {
      if (detail !== "") coreDetailEl.textContent = detail;
    } else if (detail !== null && typeof detail === "object" && Array.isArray(detail.steps) && detail.steps.length > 0) {
      const active = typeof detail.active === "number" ? detail.active : 0;
      const list = document.createElement("div");
      list.className = "plan-list";
      detail.steps.forEach((step, index) => {
        const row = document.createElement("div");
        row.className = "plan-step";
        if (index < active) row.classList.add("done");
        else if (index === active) row.classList.add("active");
        const mark = document.createElement("span");
        mark.className = "plan-mark";
        mark.textContent = index < active ? "\u2713" : index === active ? "\u25cf" : "\u00b7";
        const text = document.createElement("span");
        text.className = "plan-text";
        text.textContent = String(step);
        row.append(mark, text);
        list.appendChild(row);
      });
      coreDetailEl.appendChild(list);
    } else if (detail !== null && typeof detail === "object" && typeof detail.text === "string") {
      coreDetailEl.textContent = detail.text;
    }
    const hasContent = coreDetailEl.textContent !== "" || coreDetailEl.children.length > 0;
    coreDetailEl.style.opacity = hasContent ? "1" : "0";
  }

  function setState(nextState, detail) {
    const prev = state;
    state = nextState in STATE_LABELS ? nextState : "IDLE";
    currentDetail = detail ?? "";
    const text = STATE_LABELS[state];
    if (coreStateEl) coreStateEl.textContent = text;
    renderDetail(currentDetail);
    stage.classList.remove(
      "state-idle",
      "state-thinking",
      "state-planning",
      "state-executing",
      "state-verifying",
      "state-done",
      "state-failed"
    );
    stage.classList.add("state-" + state.toLowerCase());

    if (state === "DONE") {
      boost();
      later(950, () => {
        if (state === "DONE") setState("IDLE");
      });
    }
    if (prev !== state) emit("change", { state, prev });
  }

  /** Advance the active marker of a PLANNING step list in place. */
  function updatePlan(active) {
    if (state !== "PLANNING" || currentDetail === null || typeof currentDetail !== "object" || !Array.isArray(currentDetail.steps)) {
      return;
    }
    currentDetail.active = active;
    renderDetail(currentDetail);
  }

  function setDetail(text) {
    currentDetail = typeof text === "string" ? text : "";
    renderDetail(currentDetail);
  }

  function pulse() {
    stage.classList.remove("core-pulse");
    // Force a reflow so the class retriggers the CSS animation.
    void stage.offsetWidth;
    stage.classList.add("core-pulse");
    later(560, () => stage.classList.remove("core-pulse"));
    emit("pulse", {});
  }

  function boost() {
    hudVel.innerBoost = 90;
    hudVel.outerBoost = -70;
  }

  /* ---- Lifecycle ---------------------------------------------------------- */
  function init() {
    if (reducedMotion) {
      document.documentElement.classList.add("reduced");
    }
    initParticles();
    window.addEventListener("resize", resizeCanvas);
    rafId = requestAnimationFrame(frame);
  }

  function dispose() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    clearTimeout(disposeTimer);
    for (const id of timers) clearTimeout(id);
    timers = [];
    window.removeEventListener("resize", resizeCanvas);
    window.removeEventListener("beforeunload", dispose);
  }

  window.addEventListener("beforeunload", dispose);

  DSH.core = {
    init,
    dispose,
    setState,
    setDetail,
    updatePlan,
    pulse,
    boost,
    on,
    get state() {
      return state;
    }
  };
})();

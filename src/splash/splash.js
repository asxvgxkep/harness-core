/* ==========================================================================
   DeepSeek Harness — Splash renderer orchestrator (Gen 2).
   Runs the boot timeline: particle reconstruction, dual HUD rings, core scan,
   typewriters, Workspace Online Confirmation, and the AI Core Energy Gate
   handoff. Non-blocking; fully torn down when the splash exits.
   ========================================================================== */
(function () {
  "use strict";

  // ---- Config from the main process (query string) --------------------------
  var params = new URLSearchParams(window.location.search);
  var workspaceName = params.get("workspace") || "Harness Core Workspace";
  var minDuration = Number(params.get("min")) || 2200;
  var intensity = clamp(Number(params.get("intensity")) || 1, 0.25, 1.5);
  var reducedMotion =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---- Timeline (ms, relative to script start) ------------------------------
  var T = {
    convergeStart: 300,     // particles begin accelerating toward the core
    convergeEnd: 800,       // logo fully reconstructed
    hudAt: 800,             // HUD rings activate (rotation starts)
    pulseAt: 750,           // core pulse right as the logo snaps into focus
    pulseMs: 130,
    scanAt: 900,            // core scan beam
    scanMs: 330,
    dataCharsAt: 1150,
    initTypingAt: 1250,
    workspaceTypingAt: 1550,
    confirmAt: 2180,        // Workspace Online Confirmation
    // AI Core Energy Gate (relative to exit start):
    compressMs: 100,        // phase 1: core compression
    revealAt: 120,          // absolute ms after exit starts: Desktop enters
    exitDoneAt: 360         // absolute ms after exit starts: splash is hidden
  };

  // ---- Elements -------------------------------------------------------------
  var documentEl = document.documentElement;
  var stage = document.getElementById("stage");
  var canvas = document.getElementById("particles");
  var ctx = canvas.getContext("2d");
  var initTextEl = document.getElementById("init-text");
  var workspaceTextEl = document.getElementById("workspace-text");
  var workspaceCursor = document.getElementById("workspace-cursor");
  var dataCharsEl = document.getElementById("data-chars");
  var hudInner = document.getElementById("hud-inner");
  var hudOuter = document.getElementById("hud-outer");
  var hudSweep = document.getElementById("hud-sweep");
  var waveSvg = document.getElementById("wave-svg");
  var waveRing = document.getElementById("wave-ring");
  var waveRing2 = document.getElementById("wave-ring-2");

  var hasIpc = typeof window.splashIpc === "object" && window.splashIpc !== null;
  var exiting = false;
  var exitStartedAt = 0;
  var startedAt = performance.now();
  var lastFrame = startedAt;
  var rafId = 0;
  var timers = [];
  var particles = [];
  var shockUntil = 0;
  var workspaceTypedAt = 0;
  var hudAngles = { inner: 0, outer: 0, sweep: 0 };
  var hudVel = { inner: 5.5, outer: -4, sweep: 38, innerBoost: 0, outerBoost: 0 };

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }
  function smoothstep(a, b, x) {
    var t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  }
  function later(ms, fn) {
    var id = setTimeout(fn, ms);
    timers.push(id);
    return id;
  }

  // ---- Energy gate ring geometry (circular ring covering the window) --------
  function setupWave() {
    var w = stage.clientWidth || 860;
    var h = stage.clientHeight || 500;
    var size = Math.ceil(Math.hypot(w, h)) + 60;
    var c = size / 2;
    waveSvg.setAttribute("width", String(size));
    waveSvg.setAttribute("height", String(size));
    waveRing.setAttribute("cx", String(c));
    waveRing.setAttribute("cy", String(c));
    waveRing.setAttribute("r", "40");
    waveRing2.setAttribute("cx", String(c));
    waveRing2.setAttribute("cy", String(c));
    waveRing2.setAttribute("r", "30");
  }

  // ---- Particle field: three depths, convergence -> drift -> shock ----------
  function initParticles() {
    var dpr = window.devicePixelRatio || 1;
    var w = canvas.clientWidth || stage.clientWidth;
    var h = canvas.clientHeight || stage.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    var count = reducedMotion ? 10 : clamp(Math.round(34 * intensity), 20, 50);
    var cx = w / 2;
    var cy = h / 2;
    for (var i = 0; i < count; i++) {
      var roll = Math.random();
      var depth = roll < 0.5 ? 0 : roll < 0.86 ? 1 : 2; // far | mid | near
      var angle = Math.random() * Math.PI * 2;
      var dist = 130 + Math.random() * 240;
      particles.push({
        depth: depth,
        x: cx + Math.cos(angle) * dist,
        y: cy + Math.sin(angle) * dist,
        vx: 0,
        vy: 0,
        r: depth === 0 ? 0.4 + Math.random() * 0.5
          : depth === 1 ? 0.7 + Math.random() * 0.7
          : 1.4 + Math.random() * 0.9,
        alpha: depth === 0 ? 0.03 + Math.random() * 0.06
          : depth === 1 ? 0.07 + Math.random() * 0.12
          : 0.12 + Math.random() * 0.14,
        hue: 205 + Math.random() * 25,
        appear: 0.25 + Math.random() * 0.55, // staggered fade-in (s)
        driftPhase: Math.random() * Math.PI * 2
      });
    }
    rafId = requestAnimationFrame(frame);
  }

  function frame(now) {
    var t = (now - startedAt) / 1000;
    var dt = Math.min(0.05, Math.max(0.001, (now - lastFrame) / 1000));
    lastFrame = now;
    var w = canvas.clientWidth || stage.clientWidth;
    var h = canvas.clientHeight || stage.clientHeight;
    var cx = w / 2;
    var cy = h / 2;
    ctx.clearRect(0, 0, w, h);

    var mode;
    if (exiting) mode = "out";
    else if (reducedMotion || t < T.convergeStart) mode = "pre";
    else if (t < T.convergeEnd) mode = "converge";
    else if (now < shockUntil) mode = "shock";
    else mode = "drift";

    updateHud(t, dt);

    for (var i = 0; i < particles.length; i++) {
      updateParticle(particles[i], mode, t, dt, cx, cy, now);
      drawParticle(particles[i], cx, cy);
    }

    // Keep the loop alive while the splash exists; stop shortly after the gate.
    var keepAlive = !exiting || now - exitStartedAt < 900;
    if (keepAlive) rafId = requestAnimationFrame(frame);
    else rafId = 0;
  }

  function updateParticle(p, mode, t, dt, cx, cy, now) {
    var dx = cx - p.x;
    var dy = cy - p.y;
    var d = Math.sqrt(dx * dx + dy * dy) || 1;
    var nx = dx / d;
    var ny = dy / d;

    if (mode === "pre") {
      // slow ambient drift before the reconstruction begins
      var drift = (0.2 + 0.35 * p.depth) * intensity;
      p.vx += (Math.sin(t * 0.5 + p.driftPhase) * drift - p.vx * 0.8) * dt;
      p.vy += (Math.cos(t * 0.42 + p.driftPhase) * drift - p.vy * 0.8) * dt;
    } else if (mode === "converge") {
      // accelerating attraction toward the core; particles settle in a shell
      // just around the logo as it resolves into focus.
      var progress = smoothstep(T.convergeStart, T.convergeEnd, t);
      var pull = (110 + 380 * progress) * intensity;
      var floor = d > 56 ? 0 : (56 - d) * 6; // gentle hold-off near the logo
      p.vx += (nx * pull - floor * nx) * dt;
      p.vy += (ny * pull - floor * ny) * dt;
      var damp = d < 60 ? 2.4 : 1.4;
      p.vx *= Math.max(0, 1 - damp * dt);
      p.vy *= Math.max(0, 1 - damp * dt);
    } else if (mode === "shock") {
      // brief outward response, decaying back to ambient drift
      p.vx *= Math.max(0, 1 - 2.6 * dt);
      p.vy *= Math.max(0, 1 - 2.6 * dt);
    } else if (mode === "drift") {
      var spd = 0.5 + 0.5 * p.depth;
      var tx = Math.sin(t * 0.4 + p.driftPhase) * 5 * spd * intensity
        + Math.sin(t * 0.9 + p.driftPhase * 1.7) * 2.2 * spd * intensity;
      var ty = Math.cos(t * 0.36 + p.driftPhase * 0.8) * 4.4 * spd * intensity;
      p.vx += (tx - p.vx) * Math.min(1, 0.9 * dt);
      p.vy += (ty - p.vy) * Math.min(1, 0.9 * dt);
    } else if (mode === "out") {
      // final energy gate: everything is pushed outward and fades
      var push = (14 + 26 * p.depth) * intensity;
      p.vx += nx * push * dt * 22;
      p.vy += ny * push * dt * 22;
      p.vx *= Math.max(0, 1 - 1.2 * dt);
      p.vy *= Math.max(0, 1 - 1.2 * dt);
    }

    p.x += p.vx * dt;
    p.y += p.vy * dt;

    // keep particles inside the window (soft wrap)
    var bw = w0();
    var bh = h0();
    if (p.x < -12) p.x = bw + 12;
    if (p.x > bw + 12) p.x = -12;
    if (p.y < -12) p.y = bh + 12;
    if (p.y > bh + 12) p.y = -12;

    var appear = smoothstep(p.appear - 0.18, p.appear + 0.18, t);
    var modeAlpha = 1;
    if (mode === "converge") {
      // brighten slightly as particles are absorbed into the core,
      // strengthening the "being consumed by the AI core" read
      modeAlpha = clamp(1.35 - d / 200, 0.62, 1.28);
    }
    if (mode === "out") {
      var fade = 1 - clamp((now - exitStartedAt - T.compressMs) / 420, 0, 1);
      modeAlpha = fade;
    }
    p.drawAlpha = p.alpha * appear * modeAlpha;
  }

  function w0() {
    return canvas.clientWidth || stage.clientWidth || 860;
  }
  function h0() {
    return canvas.clientHeight || stage.clientHeight || 500;
  }

  function drawParticle(p, cx, cy) {
    var a = p.drawAlpha;
    if (a <= 0.004) return;
    if (p.depth === 2) {
      // near particles get a soft halo for depth
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

  function shockParticles(strength) {
    var cx = w0() / 2;
    var cy = h0() / 2;
    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      var dx = p.x - cx;
      var dy = p.y - cy;
      var d = Math.sqrt(dx * dx + dy * dy) || 1;
      p.vx += (dx / d) * (strength + 9 * p.depth);
      p.vy += (dy / d) * (strength + 9 * p.depth);
    }
    shockUntil = performance.now() + 300;
  }

  // ---- HUD rings: slow counter-rotating arcs + fast highlight sweep ---------
  function updateHud(t, dt) {
    if (t < T.hudAt) return;
    if (!reducedMotion) {
      hudVel.innerBoost *= Math.max(0, 1 - 2.2 * dt);
      hudVel.outerBoost *= Math.max(0, 1 - 2.2 * dt);
      hudAngles.inner += (hudVel.inner + hudVel.innerBoost) * dt;
      hudAngles.outer += (hudVel.outer + hudVel.outerBoost) * dt;
      hudAngles.sweep += hudVel.sweep * dt + hudVel.outerBoost * 0.6 * dt;
      if (hudInner) hudInner.style.transform = "rotate(" + hudAngles.inner.toFixed(2) + "deg)";
      if (hudOuter) hudOuter.style.transform = "rotate(" + hudAngles.outer.toFixed(2) + "deg)";
      if (hudSweep) hudSweep.style.transform = "rotate(" + hudAngles.sweep.toFixed(2) + "deg)";
    }
  }

  // ---- Sparse ambient data characters ---------------------------------------
  var DATA_GLYPHS = ["01", "{}", "//", "0x", "<>", "->", "AI"];
  function spawnDataChars() {
    var count = reducedMotion ? 4 : 9;
    var w = stage.clientWidth || 860;
    var h = stage.clientHeight || 500;
    var cx = w / 2;
    var cy = h / 2;
    for (var i = 0; i < count; i++) {
      var el = document.createElement("span");
      el.className = "data-char";
      el.textContent = DATA_GLYPHS[(Math.random() * DATA_GLYPHS.length) | 0];
      var angle = Math.random() * Math.PI * 2;
      var dist = 175 + Math.random() * (Math.min(w, h) / 2 - 80);
      var x = clamp(cx + Math.cos(angle) * dist, 24, w - 64);
      var y = clamp(cy + Math.sin(angle) * dist, 24, h - 64);
      el.style.left = x.toFixed(1) + "px";
      el.style.top = y.toFixed(1) + "px";
      el.style.setProperty("--o", (0.05 + Math.random() * 0.11).toFixed(3));
      el.style.setProperty("--s", (0.75 + Math.random() * 0.45).toFixed(2));
      el.style.setProperty("--b", (Math.random() * 1.2).toFixed(2) + "px");
      el.style.setProperty("--drift", (3.5 + Math.random() * 3).toFixed(1) + "s");
      el.style.setProperty("--delay", (1.1 + Math.random() * 1.4).toFixed(2) + "s");
      dataCharsEl.appendChild(el);
    }
  }

  // ---- Typewriter ------------------------------------------------------------
  function typeText(el, text, startMs, delayFor, onDone) {
    if (reducedMotion) {
      later(0, function () {
        el.textContent = text;
        if (onDone) onDone();
      });
      return;
    }
    later(startMs, function () {
      var i = 0;

      function step() {
        if (exiting) return;
        if (i > text.length) {
          if (onDone) onDone();
          return;
        }
        el.textContent = text.slice(0, i);
        var delay = typeof delayFor === "function" ? delayFor(text, i) : delayFor;
        i++;
        later(delay, step);
      }
      step();
    });
  }

  function initCharDelay() {
    return 16;
  }

  // Restrained 20–45ms variation: quick run, a beat before the apostrophe /
  // space, a beat before the final word, tiny organic jitter elsewhere.
  function workspaceCharDelay(text, i) {
    var ch = text.charAt(i);
    if (ch === "'" || ch === " ") return 42;
    if (ch === "W") return 34;
    return 22 + ((i * 7) % 9);
  }

  function startTypewriters() {
    typeText(initTextEl, "Initializing workspace...", T.initTypingAt, initCharDelay, function () {});

    typeText(workspaceTextEl, workspaceName, T.workspaceTypingAt, workspaceCharDelay, function () {
      workspaceTypedAt = (performance.now() - startedAt);
      workspaceCursor.classList.add("settle");
      maybeConfirm();
    });
  }

  // ---- Workspace Online Confirmation ----------------------------------------
  function runConfirmation() {
    if (exiting) return;
    stage.classList.add("confirming");
    later(620, function () {
      stage.classList.remove("confirming");
      if (hasIpc && typeof window.splashIpc.animationEnd === "function") {
        window.splashIpc.animationEnd();
      }
    });
    if (!reducedMotion) {
      hudVel.outerBoost = 70;   // HUD rings take a small, quick step
      shockParticles(10);       // nearby particles give a tiny outward response
    }
  }

  function maybeConfirm() {
    var at = Math.max(T.confirmAt, workspaceTypedAt + 90);
    var wait = at - ((performance.now() - startedAt));
    if (wait > 0) later(wait, runConfirmation);
    else runConfirmation();
  }

  // ---- AI Core Energy Gate ---------------------------------------------------
  function requestExit() {
    if (exiting) return;
    if (hasIpc && typeof window.splashIpc.mainAnimationLastMotion === "function") {
      window.splashIpc.mainAnimationLastMotion({
        relativeMs: Number((performance.now() - startedAt).toFixed(3)),
        phase: "handoff-boundary"
      });
    }
    exiting = true;
    exitStartedAt = performance.now();
    if (!reducedMotion) {
      hudVel.innerBoost = 150;
      hudVel.outerBoost = -110;
    }
    stage.classList.add("exit-compress");
    if (hasIpc && typeof window.splashIpc.exitVisualStart === "function") {
      window.splashIpc.exitVisualStart({ phase: "core-compress" });
    }
    later(T.compressMs, function () {
      stage.classList.add("exiting");
      if (!reducedMotion) shockParticles(16);
    });
    later(T.revealAt, function () {
      if (hasIpc) window.splashIpc.reveal();
    });
    later(T.exitDoneAt, function () {
      if (hasIpc) window.splashIpc.exitDone();
    });
  }

  // ---- Teardown --------------------------------------------------------------
  function dispose() {
    exiting = true;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    for (var i = 0; i < timers.length; i++) clearTimeout(timers[i]);
    timers = [];
    particles = [];
    window.removeEventListener("beforeunload", dispose);
  }

  // ---- Boot ------------------------------------------------------------------
  function boot() {
    if (reducedMotion) documentEl.classList.add("reduced");
    setupWave();
    initParticles();
    startTypewriters();
    later(T.dataCharsAt, spawnDataChars);

    if (!reducedMotion) {
      later(T.pulseAt, function () {
        stage.classList.add("core-pulse");
      });
      later(T.pulseAt + T.pulseMs, function () {
        stage.classList.remove("core-pulse");
      });
      later(T.scanAt, function () {
        stage.classList.add("scanning");
      });
      later(T.scanAt + T.scanMs, function () {
        stage.classList.remove("scanning");
      });
    }

    if (hasIpc) {
      window.splashIpc.onExit(requestExit);
      // Safety net: if the main process never asks us to leave, bail out on our own.
      later(minDuration + 12000, requestExit);
    } else {
      // Standalone preview (no Electron bridge): play through and exit.
      later(minDuration + 2600, requestExit);
    }
  }

  window.addEventListener("beforeunload", dispose);

  boot();
})();

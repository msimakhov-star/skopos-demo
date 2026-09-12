/* Skopos — Reactor browser client.
 *
 * Opens ONE LingBot World 2 session per page, anchored on a kitchen photo,
 * and keeps it in step with the Skopos loop. The server's render.prompt
 * (lighting, occlusion, clutter — the promptable axes) changes almost every
 * 0.55s step, and a hot-swapped prompt takes effect at the next chunk
 * boundary, so forwarding every change re-steers the world several times a
 * second and it drifts into mush. Hence the WORLD LOCK:
 *   - locked (default): prompt changes are held in state.pendingPrompt and
 *     sent only when the user clicks "apply scene" (applyScene()).
 *   - live: sent automatically, at most one setPrompt per PROMPT_MIN_GAP_MS
 *     and only when the text differs from the last one sent.
 *
 * Verified against @reactor-models/lingbot-world-2@1.0.1 on 12 Sep 2026:
 *   new LingbotWorld2Model({})           modelName is preset by the class
 *   .on("statusChanged" | "trackReceived" | "error" | "message", fn)
 *   .connect(jwt)                         disconnected→connecting→waiting→ready
 *   .uploadFile(file) -> FileRef          then .setImage({ image: ref })
 *   .setPrompt({ prompt })  .setSeed({ seed })  .start()  .reset()
 *   .setMoveLongitudinal({ move_longitudinal: "idle"|"forward"|"back" })
 *   .setMoveLateral({ move_lateral: "idle"|"strafe_left"|"strafe_right" })
 *   .setLookHorizontal({ look_horizontal: "idle"|"left"|"right" })
 *   .setLookVertical({ look_vertical: "idle"|"up"|"down" })
 *
 * Two rules from the docs that shape this file:
 *   - setImage during generation is a silent no-op; the anchor is locked once
 *     started. Changing the anchor means reset() → setImage → start().
 *   - Movement/look values PERSIST until you send "idle". Every keydown needs
 *     its keyup, or the world drifts forever.
 *
 * Money: the session bills from ready until disconnect, $0.0070/sec, even when
 * idle. The kill timer below is not optional.
 */

const SDK_URL = "https://cdn.jsdelivr.net/npm/@reactor-models/lingbot-world-2@1.0.1/+esm";
const DEFAULT_ANCHOR = "/static/fixtures/IMG_6978.jpg";   // the first photo
const PROMPT_MIN_GAP_MS = 4000;   // live mode: floor between two setPrompt calls

const state = {
  model: null,
  status: "disconnected",
  jwt: null,
  anchorName: null,
  lastPrompt: null,      // last prompt actually sent to the world
  lastSentAt: 0,
  locked: true,          // world lock — see header comment
  pendingPrompt: null,   // latest prompt held back while locked / throttled
  pendingCount: 0,       // prompt changes absorbed since the last send
  started: false,
  idleKillSeconds: 90,
  holdTimer: null,
  paused: false,
  resumeOnInput: false,
  closedByUser: false,
  anchorFile: null,
  idleTimer: null,
  idleDeadline: 0,
  countdownTimer: null,
  held: { lon: "idle", lat: "idle", yaw: "idle", pitch: "idle" },
};

const $ = (s) => document.querySelector(s);
const note = (t) => { const n = $("#note"); if (n) n.textContent = t; };
const badge = (t) => { const b = $("#rx-status"); if (b) b.textContent = t; };

// ---------------------------------------------------------------- idle kill
const HOLD_AFTER_MS = 5000;   // no input for 5s -> pause generation; the picture holds

/* The last decoded frame, painted over the video so the room STAYS on screen
 * when the session is paused or closed. Created once, from JS. */
function freezeCanvas() {
  let c = $("#freeze");
  if (c) return c;
  const v = $("#video");
  c = document.createElement("canvas"); c.id = "freeze";
  c.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:none;object-fit:cover";
  v.parentNode.insertBefore(c, v.nextSibling);
  return c;
}
function captureFrame() {
  const v = $("#video"); if (!v || !v.videoWidth) return false;
  const c = freezeCanvas();
  c.width = v.videoWidth; c.height = v.videoHeight;
  c.getContext("2d").drawImage(v, 0, 0);
  c.style.display = "block";
  return true;
}
function showLive() { const c = $("#freeze"); if (c) c.style.display = "none"; }

async function holdStill() {
  // Short idle: stop the model advancing so the room does not drift while nobody
  // is driving. Billing continues (the GPU is still reserved) — that is what the
  // 90s close below is for.
  if (!state.model || !state.started || state.paused) return;
  try { await idleAll(); await state.model.pause(); state.paused = true; captureFrame(); note("world holding — press any key to move"); }
  catch (e) { console.warn("pause failed", e); }
}
async function resumeMoving() {
  if (!state.model || !state.paused) return;
  try { await state.model.resume(); state.paused = false; showLive(); note("streaming — " + state.anchorName); }
  catch (e) { console.warn("resume failed", e); }
}

function armIdleKill(seconds) {
  clearTimeout(state.idleTimer);
  clearTimeout(state.holdTimer);
  clearInterval(state.countdownTimer);
  state.idleDeadline = Date.now() + seconds * 1000;
  state.holdTimer = setTimeout(holdStill, HOLD_AFTER_MS);
  state.idleTimer = setTimeout(() => {
    // Long idle: keep the last frame on screen, close the session (stops the
    // meter). The next input reconnects on the same anchor, prompt and seed.
    captureFrame();
    note("idle " + seconds + "s — session closed, picture kept; press any key to reconnect");
    state.resumeOnInput = true;
    disconnect({ keepPicture: true });
  }, seconds * 1000);
  state.countdownTimer = setInterval(() => {
    const left = Math.max(0, Math.ceil((state.idleDeadline - Date.now()) / 1000));
    const el = $("#rx-idle"); if (el) el.textContent = left + "s";
  }, 500);
}
const touch = () => {
  if (state.model && state.status === "ready") { armIdleKill(state.idleKillSeconds); if (state.paused) resumeMoving(); return; }
  if ((state.resumeOnInput || state.closedByUser) && !state.model && state.lastDetail) {
    state.resumeOnInput = false; state.closedByUser = false;
    note("reconnecting on the same anchor …");
    startWith(state.lastDetail, state.anchorUrl).catch((e) => note("reconnect failed: " + (e.message || e)));
  }
};

// ---------------------------------------------------------------- lifecycle
async function loadSdk() {
  if (state.sdk) return state.sdk;
  state.sdk = await import(SDK_URL);
  return state.sdk;
}

async function connect(detail) {
  if (state.model) return state.model;
  const { LingbotWorld2Model } = await loadSdk();
  const video = $("#video");
  const m = new LingbotWorld2Model({});
  state.model = m;
  state.jwt = detail.jwt;
  state.idleKillSeconds = detail.idleKillSeconds || 90;

  m.on("statusChanged", (s) => {
    state.status = typeof s === "string" ? s : (s && s.status) || String(s);
    badge(state.status);
    if (state.status === "ready") { note("Reactor session ready"); armIdleKill(state.idleKillSeconds); }
    if (state.status === "disconnected") { state.started = false; clearTimeout(state.idleTimer); clearInterval(state.countdownTimer); }
  });
  m.on("trackReceived", (name, track, stream) => {
    if (name !== "main_video") return;
    const v = $("#video");
    v.addEventListener("playing", showLive, { once: true });
    video.srcObject = stream || new MediaStream([track]);
    video.play().catch(() => {});
  });
  m.on("error", (e) => { note("reactor error: " + (e && (e.message || e.code) || e)); console.error("reactor", e); });
  m.on("message", (msg) => {
    // command_error is how a broken precondition (start before setImage) surfaces
    if (msg && msg.type === "command_error") note("reactor: " + (msg.message || msg.error || "command error"));
  });

  badge("connecting");
  await m.connect(detail.jwt, { maxAttempts: 4 });   // GPU provisioning can take >30 s at busy times
  return m;
}

async function stageAnchor(m, detail, anchorUrl) {
  // The anchor is either a photo the user uploaded (state.anchorFile) or a
  // fixture URL. Either way this is the ONE place image bytes leave the device
  // for the renderer, and it is counted on screen.
  let file = state.anchorFile;
  if (!file) {
    const r = await fetch(anchorUrl);
    const blob = await r.blob();
    file = new File([blob], anchorUrl.split("/").pop(), { type: blob.type || "image/jpeg" });
  }
  const ref = await m.uploadFile(file);
  if (typeof window.rendererBytes === "number") window.rendererBytes += file.size;
  await m.setImage({ image: ref });
  state.anchorName = file.name;
  return ref;
}

async function startWith(detail, anchorUrl) {
  const m = await connect(detail);
  // wait for ready (connect resolves on ready in the SDK, but be defensive)
  if (state.status !== "ready") {
    await new Promise((res) => {
      const t = setInterval(() => { if (state.status === "ready" || state.status === "error") { clearInterval(t); res(); } }, 100);
    });
    if (state.status !== "ready") return;
  }
  if (state.started) { await m.reset(); state.started = false; }
  await stageAnchor(m, detail, anchorUrl || DEFAULT_ANCHOR);
  if (detail.seed != null) await m.setSeed({ seed: detail.seed });
  await m.setPrompt({ prompt: detail.prompt });
  state.lastPrompt = detail.prompt; state.lastSentAt = Date.now();
  state.pendingPrompt = null; state.pendingCount = 0;
  await m.start();
  state.started = true;
  note("streaming — " + state.anchorName);
  showWorld();
}

async function disconnect(opts) {
  const keep = !!(opts && opts.keepPicture);
  state.closedByUser = true;
  clearTimeout(state.holdTimer);
  if (!keep) showLive();
  state.paused = false;
  const m = state.model; if (!m) return;
  if (state.started) { try { await idleAll(); } catch (_) {} }   // no commands on a session that never got ready
  try { await m.disconnect(); } catch (_) {}
  state.model = null; state.started = false; state.status = "disconnected";
  badge("disconnected");
  const v = $("#video"); if (v) v.srcObject = null;
}

// ---------------------------------------------------------------- controls
async function idleAll() {
  const m = state.model; if (!m) return;
  state.held = { lon: "idle", lat: "idle", yaw: "idle", pitch: "idle" };
  await Promise.allSettled([
    m.setMoveLongitudinal({ move_longitudinal: "idle" }),
    m.setMoveLateral({ move_lateral: "idle" }),
    m.setLookHorizontal({ look_horizontal: "idle" }),
    m.setLookVertical({ look_vertical: "idle" }),
  ]);
}

const KEYS = {
  KeyW: ["lon", "forward"], KeyS: ["lon", "back"],
  KeyA: ["lat", "strafe_left"], KeyD: ["lat", "strafe_right"],
  ArrowLeft: ["yaw", "left"], ArrowRight: ["yaw", "right"],
  ArrowUp: ["pitch", "up"], ArrowDown: ["pitch", "down"],
};
const SEND = {
  lon: (m, v) => m.setMoveLongitudinal({ move_longitudinal: v }),
  lat: (m, v) => m.setMoveLateral({ move_lateral: v }),
  yaw: (m, v) => m.setLookHorizontal({ look_horizontal: v }),
  pitch: (m, v) => m.setLookVertical({ look_vertical: v }),
};

function bindKeys() {
  const isTyping = (e) => ["INPUT", "TEXTAREA"].includes((e.target && e.target.tagName) || "");
  addEventListener("keydown", (e) => {
    if (isTyping(e)) return;
    if (!state.model && (state.resumeOnInput || state.closedByUser) && KEYS[e.code]) { touch(); return; }
    if (!KEYS[e.code] || !state.model || !state.started) return;
    if (state.paused) resumeMoving();
    const [axis, val] = KEYS[e.code];
    if (state.held[axis] === val) return;          // key repeat
    state.held[axis] = val; touch();
    SEND[axis](state.model, val).catch(console.error);
    e.preventDefault();
  });
  addEventListener("keyup", (e) => {
    if (!KEYS[e.code] || !state.model) return;
    const [axis] = KEYS[e.code];
    if (state.held[axis] === "idle") return;
    state.held[axis] = "idle";
    SEND[axis](state.model, "idle").catch(console.error);
  });
  // Pointer drag on the video = look. Release = idle, always.
  const v = $("#video"); if (!v) return;
  let dragging = false, lastX = 0;
  v.addEventListener("pointerdown", (e) => { dragging = true; lastX = e.clientX; v.setPointerCapture(e.pointerId); touch(); });
  v.addEventListener("pointermove", (e) => {
    if (!dragging || !state.model || !state.started) return;
    const dx = e.clientX - lastX;
    const want = dx > 6 ? "right" : dx < -6 ? "left" : state.held.yaw;
    if (want !== state.held.yaw) { state.held.yaw = want; SEND.yaw(state.model, want).catch(console.error); lastX = e.clientX; touch(); }
  });
  const stop = () => { dragging = false; if (state.held.yaw !== "idle" && state.model) { state.held.yaw = "idle"; SEND.yaw(state.model, "idle").catch(console.error); } };
  v.addEventListener("pointerup", stop); v.addEventListener("pointercancel", stop); v.addEventListener("pointerleave", stop);
  addEventListener("blur", () => idleAll().catch(() => {}));
}

// ---------------------------------------------------------------- world lock
/* Indicator span lives next to #note, created here because index.html
 * overwrites #note.textContent on every frame. Click it to toggle the lock. */
function worldEl() {
  let el = $("#rx-world");
  if (el) return el;
  const n = $("#note"); if (!n) return null;
  el = document.createElement("span");
  el.id = "rx-world";
  el.style.cssText = "color:var(--faint);cursor:pointer;white-space:nowrap";
  el.title = "click to toggle. locked: scene changes are held until 'apply scene'. live: sent at most every 4s";
  el.onclick = () => setLocked(!state.locked);
  n.insertAdjacentElement("afterend", el);
  return el;
}
function showWorld() {
  const el = worldEl(); if (!el) return;
  const n = state.pendingCount;
  el.textContent = state.locked
    ? "world: locked" + (n ? ` · ${n} pending change${n === 1 ? "" : "s"}` : "")
    : "world: live";
}

/* Send state.pendingPrompt once. force=true skips the live-mode gap (a click). */
function sendPrompt(force) {
  const p = state.pendingPrompt;
  if (!p || !state.model || !state.started) return false;
  if (p === state.lastPrompt) { state.pendingPrompt = null; state.pendingCount = 0; showWorld(); return false; }
  if (!force && Date.now() - state.lastSentAt < PROMPT_MIN_GAP_MS) return false;
  state.lastPrompt = p; state.lastSentAt = Date.now();
  state.pendingPrompt = null; state.pendingCount = 0;
  state.model.setPrompt({ prompt: p }).catch(console.error);   // next chunk boundary
  touch(); showWorld();
  return true;
}
function applyScene() { return sendPrompt(true); }
function setLocked(v) {
  state.locked = !!v;
  if (!state.locked) sendPrompt(false);   // drain what was held, subject to the gap
  showWorld();
}

// ---------------------------------------------------------------- Skopos hook
/* Called from index.html apply(f) on every webrtc frame. Idempotent. */
async function ensure(render) {
  const d = render.detail || {};
  if (!d.jwt) { note("reactor: no jwt in render.detail"); return; }
  // After a close (End session, or the idle close) do NOT reopen on the next
  // frame. Before this guard every disconnect was undone 0.55s later, so
  // "End session" never ended anything and the idle close became an endless
  // loop of fresh, billed sessions. Only a keypress/pointer or a new anchor
  // reconnects.
  if (!state.model && state.closedByUser) return;
  if (!state.model) {
    if (state.retryAt && Date.now() < state.retryAt) return;       // back off after a failure
    try { await startWith({ ...d, prompt: render.prompt }, state.anchorUrl); }
    catch (e) {
      const ra = (e && e.retry_after_ms) || 8000;
      note(`reactor ${e && e.code ? e.code : "connect failed"} — retrying in ${Math.round(ra/1000)}s`);
      console.error(e);
      try { if (state.model) await state.model.disconnect(); } catch (_) {}
      state.model = null; state.started = false; state.status = "disconnected";
      state.retryAt = Date.now() + ra;
    }
    return;
  }
  if (state.started && render.prompt) {
    const changed = render.prompt !== state.lastPrompt;
    if (!changed) { state.pendingPrompt = null; state.pendingCount = 0; }   // scene is back to what the world shows
    else if (render.prompt !== state.pendingPrompt) { state.pendingPrompt = render.prompt; state.pendingCount++; }
    if (changed && !state.locked) sendPrompt(false);   // live: throttled, latest text wins
  }
  showWorld();
}

async function setAnchor(url) {
  state.anchorUrl = url; state.anchorFile = null; state.closedByUser = false;
  if (state.model && state.started) {
    const d = state.lastDetail; if (d) await startWith(d, url);
  }
}

bindKeys();

// The <video> keeps decoding 48fps even when the cloud/map canvas covers it.
// Pause the element (not the session) whenever it is not visible; play on return.
(function watchVisibility() {
  const v = $("#video"); if (!v) return;
  const sync = () => {
    const shown = getComputedStyle(v).display !== "none" && !(v.nextElementSibling && v.nextElementSibling.id === "spatial" && getComputedStyle(v.nextElementSibling).display !== "none");
    if (shown) { if (v.paused && v.srcObject && !state.paused) v.play().catch(() => {}); }
    else if (!v.paused) v.pause();
  };
  new MutationObserver(sync).observe(v.parentNode, { attributes: true, subtree: true, attributeFilter: ["style", "class"] });
  document.addEventListener("visibilitychange", () => { if (document.hidden) { if (!v.paused) v.pause(); } else sync(); });
})();
addEventListener("beforeunload", () => { if (state.model) state.model.disconnect(); });
{ const b = $("#rx-apply"); if (b) b.onclick = () => applyScene(); }

window.SkoposReactor = {
  ensure: (render) => { state.lastDetail = { ...(render.detail || {}), prompt: render.prompt }; return ensure(render); },
  disconnect, setAnchor, idleAll, applyScene, setLocked, holdStill, resumeMoving,
  /* Use one of the user's own photos as the Reactor anchor. Restarts the world if streaming. */
  setAnchorFile: async (file) => { state.anchorFile = file || null; state.anchorUrl = null; state.closedByUser = false;
    if (state.model && state.started && state.lastDetail) await startWith(state.lastDetail, null); },
  get status() { return state.status; },
  get started() { return state.started; },
  get anchor() { return state.anchorName; },
  get locked() { return state.locked; },
  get pendingPrompt() { return state.pendingPrompt; },
};

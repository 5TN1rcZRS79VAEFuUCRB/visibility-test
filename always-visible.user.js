// ==UserScript==
// @name         Always visible
// @version      10
// @match        *://*/*
// @run-at       document-start
// @grant        none
// @inject-into  page
// ==/UserScript==

// Fakes go on the prototypes with native names, belong to the right realm, and toString
// reports the original native source, so the page can't easily spot them. Every same-origin
// frame gets the same patches: the moment a frame element is inserted, its new realm is
// patched synchronously (before the page can read window[i]/frames[i]).
// ponytail: frames made by innerHTML/outerHTML/insertAdjacentHTML or window.open() stay
// unpatched; wrap those sinks too if a site uses them.
const natives = new Map();
const patched = new WeakSet();

// Patch a window and every same-origin frame reachable from it.
const patchFrames = (win) => {
  try {
    patch(win);
    for (let i = 0; i < win.length; i++) patchFrames(win[i]);
  } catch {} // cross-origin frame
};

// One background clock for all realms. A backgrounded tab's own rAF/timers are throttled by
// the browser (rAF paused, timers clamped to >=1s) and a page script can't stop that — but a
// Web Worker's timer keeps near-real cadence, so we drive the page's rAF/timers off it.
const nativeSetTimeout = window.setTimeout.bind(window);
const ticks = new Set();
let heartbeatStarted = false;
const startHeartbeat = () => {
  if (heartbeatStarted) return;
  heartbeatStarted = true;
  const run = () => { for (const t of ticks) { try { t(); } catch {} } };
  try {
    const url = URL.createObjectURL(new Blob(['setInterval(()=>postMessage(0),16)'], { type: 'text/javascript' }));
    const w = new Worker(url);
    URL.revokeObjectURL(url);
    w.onmessage = run;
  } catch {
    // ponytail: Worker blocked (e.g. CSP worker-src). Native timer is throttled when hidden,
    // so the pause reappears in the background; a reachable Worker is the only real fix.
    const loop = () => { run(); nativeSetTimeout(loop, 16); };
    loop();
  }
};

const disguise = (win, fake, real) => {
  Object.setPrototypeOf(fake, win.Function.prototype);
  // Match the native's arity and name so Function.prototype.toString isn't the only tell.
  try {
    Object.defineProperty(fake, 'length', { value: real.length, configurable: true });
    Object.defineProperty(fake, 'name', { value: real.name, configurable: true });
  } catch {}
  natives.set(fake, real);
  return fake;
};

const replaceGetter = (win, proto, prop, impl) => {
  const desc = Object.getOwnPropertyDescriptor(proto, prop);
  const get = Object.getOwnPropertyDescriptor({ get [prop]() { return impl(this, desc.get); } }, prop).get;
  Object.defineProperty(proto, prop, { ...desc, get: disguise(win, get, desc.get) });
};

const patch = (win) => {
  try {
    if (patched.has(win.Document)) return;
  } catch {
    return; // cross-origin or no window
  }
  patched.add(win.Document);

  const fnProto = win.Function.prototype;
  const nativeToString = fnProto.toString;
  const toString = new Proxy(nativeToString, {
    apply: (fn, self, args) => Reflect.apply(fn, natives.get(self) ?? self, args),
  });
  fnProto.toString = disguise(win, toString, nativeToString);

  const docProto = win.Document.prototype;
  // Call the native getter for its receiver check (then ignore the real value) so these throw on a
  // non-Document `this` exactly as the natives do.
  replaceGetter(win, docProto, 'hidden', (self, get) => { get.call(self); return false; });
  replaceGetter(win, docProto, 'visibilityState', (self, get) => { get.call(self); return 'visible'; });
  // Chrome still exposes the legacy webkit-prefixed aliases and fires webkitvisibilitychange; a page
  // reading document.webkitHidden would otherwise see the real state. Patch them where they exist.
  for (const [prop, val] of [['webkitHidden', false], ['webkitVisibilityState', 'visible']]) {
    if (Object.getOwnPropertyDescriptor(docProto, prop)) {
      replaceGetter(win, docProto, prop, (self, get) => { get.call(self); return val; });
    }
  }
  const nativeHasFocus = docProto.hasFocus;
  const { hasFocus } = { hasFocus() { nativeHasFocus.call(this); return true; } };
  docProto.hasFocus = disguise(win, hasFocus, nativeHasFocus);

  for (const El of [win.HTMLIFrameElement, win.HTMLFrameElement, win.HTMLObjectElement]) {
    replaceGetter(win, El.prototype, 'contentWindow', (el, get) => {
      const w = get.call(el);
      if (w) patch(w);
      return w;
    });
    replaceGetter(win, El.prototype, 'contentDocument', (el, get) => {
      const d = get.call(el);
      if (d) patch(d.defaultView);
      return d;
    });
  }

  // Patch frames reached via window[i]/frames[i], which skip the getters above. A same-origin
  // child frame's realm exists the instant its element is connected, so patch right after any
  // DOM insertion, before the page's next statement can read it.
  const wrapInsert = (proto, name) => {
    const orig = proto[name];
    if (typeof orig !== 'function') return;
    const fake = { [name](...args) {
      const r = orig.apply(this, args);
      patchFrames(win);
      return r;
    } }[name];
    proto[name] = disguise(win, fake, orig);
  };
  for (const name of ['appendChild', 'insertBefore', 'replaceChild']) wrapInsert(win.Node.prototype, name);
  for (const name of ['append', 'prepend', 'before', 'after', 'replaceWith', 'insertAdjacentElement']) wrapInsert(win.Element.prototype, name);

  // Frames parsed from an HTML string (innerHTML/outerHTML/insertAdjacentHTML) skip the node-
  // insertion wrappers above, so patch after those too. Only walk when the string could contain a
  // frame, to keep these hot sinks cheap.
  const mayHaveFrame = (html) => typeof html === 'string' && /<(iframe|frame)[\s/>]/i.test(html);
  const wrapHtmlSetter = (proto, name) => {
    const desc = proto && Object.getOwnPropertyDescriptor(proto, name);
    if (!desc || !desc.set) return;
    const set = { [name](v) { desc.set.call(this, v); if (mayHaveFrame(v)) patchFrames(win); } }[name];
    Object.defineProperty(proto, name, { ...desc, set: disguise(win, set, desc.set) });
  };
  wrapHtmlSetter(win.Element.prototype, 'innerHTML');
  wrapHtmlSetter(win.Element.prototype, 'outerHTML');
  const nativeIAH = win.Element.prototype.insertAdjacentHTML;
  if (typeof nativeIAH === 'function') {
    const fake = { insertAdjacentHTML(pos, html) {
      const r = nativeIAH.call(this, pos, html);
      if (mayHaveFrame(html)) patchFrames(win);
      return r;
    } }.insertAdjacentHTML;
    win.Element.prototype.insertAdjacentHTML = disguise(win, fake, nativeIAH);
  }

  // A window.open() popup is its own top-level realm. Patch what it returns now (covers an
  // about:blank popup used synchronously) and again on load (covers one opened to a same-origin URL,
  // whose document realm is replaced once that URL loads).
  // ponytail: a cross-origin popup can't be patched, and an SPA navigation inside the popup after
  // its first load isn't re-caught; only the initial document is.
  const nativeOpen = win.open;
  if (typeof nativeOpen === 'function') {
    const fake = { open(...args) {
      const w = nativeOpen.apply(this, args);
      try {
        if (w) { patch(w); w.addEventListener('load', () => { try { patch(w); } catch {} }); }
      } catch {} // cross-origin popup
      return w;
    } }.open;
    win.open = disguise(win, fake, nativeOpen);
  }

  // Run rAF and timers off the background clock so a hidden tab shows no frame/timer pause.
  startHeartbeat();
  const now = () => win.performance.now();
  // Native Window methods throw on a wrong `this`; mirror that. `this` null/undefined is allowed
  // (bare `const s = setTimeout; s(fn)` keeps working), any other non-Window object throws.
  const illegal = (self) => { if (self != null && self.window !== self) throw new win.TypeError('Illegal invocation'); };
  // A swallowed callback error would never reach window 'error'; rethrow it on a fresh task so it
  // surfaces there as a native callback's would, without killing the dispatch loop.
  const rethrow = (e) => nativeSetTimeout(() => { throw e; });

  const rafCbs = new Map();
  let rafSeq = 0;
  const raf = { requestAnimationFrame(cb) { illegal(this); const id = ++rafSeq; rafCbs.set(id, cb); return id; } }.requestAnimationFrame;
  const caf = { cancelAnimationFrame(id) { illegal(this); rafCbs.delete(id); } }.cancelAnimationFrame;
  win.requestAnimationFrame = disguise(win, raf, win.requestAnimationFrame);
  win.cancelAnimationFrame = disguise(win, caf, win.cancelAnimationFrame);
  ticks.add(() => {
    if (!rafCbs.size) return;
    const t = now(), due = [...rafCbs.values()];
    rafCbs.clear();
    for (const cb of due) { try { cb(t); } catch (e) { rethrow(e); } }
  });

  // requestIdleCallback is throttled/stopped in a hidden tab too, so drive it off the clock as well.
  // ponytail: deadline reports a flat 50ms remaining and callbacks fire every tick rather than only
  // when the browser is genuinely idle — fine for keep-alive, looser than native idle scheduling.
  if (typeof win.requestIdleCallback === 'function') {
    const idleCbs = new Map();
    let idleSeq = 0;
    const ric = { requestIdleCallback(cb, opts) { illegal(this); const id = ++idleSeq; idleCbs.set(id, { cb, timeoutAt: opts?.timeout ? now() + +opts.timeout : Infinity }); return id; } }.requestIdleCallback;
    const cic = { cancelIdleCallback(id) { illegal(this); idleCbs.delete(id); } }.cancelIdleCallback;
    win.requestIdleCallback = disguise(win, ric, win.requestIdleCallback);
    win.cancelIdleCallback = disguise(win, cic, win.cancelIdleCallback);
    ticks.add(() => {
      if (!idleCbs.size) return;
      const t = now(), due = [...idleCbs.values()];
      idleCbs.clear();
      for (const x of due) {
        const deadline = { didTimeout: t >= x.timeoutAt, timeRemaining() { return this.didTimeout ? 0 : 50; } };
        try { x.cb(deadline); } catch (e) { rethrow(e); }
      }
    });
  }

  // <video>.requestVideoFrameCallback stops firing in a hidden tab (the frame never presents), so a
  // page doing per-frame video work stalls. Drive it off the clock for a video that is actually
  // playing, synthesizing the frame metadata from the element.
  // ponytail: metadata is approximate (expectedDisplayTime = now + 16, processingDuration = 0) and
  // frames advance at the ~16ms tick, not the video's true presentation rate.
  const VideoEl = win.HTMLVideoElement;
  if (VideoEl && typeof VideoEl.prototype.requestVideoFrameCallback === 'function') {
    const nativeRVFC = VideoEl.prototype.requestVideoFrameCallback;
    const nativeCVFC = VideoEl.prototype.cancelVideoFrameCallback;
    const rvfcCbs = new Map();
    let rvfcSeq = 0;
    const presented = new WeakMap();
    // nativeCVFC.call(this, 0) is a no-op that still runs the native receiver check, so these throw
    // on a non-video `this` like the originals.
    const rvfc = { requestVideoFrameCallback(cb) { nativeCVFC.call(this, 0); const id = ++rvfcSeq; rvfcCbs.set(id, { video: this, cb }); return id; } }.requestVideoFrameCallback;
    const cvfc = { cancelVideoFrameCallback(id) { nativeCVFC.call(this, 0); rvfcCbs.delete(id); } }.cancelVideoFrameCallback;
    VideoEl.prototype.requestVideoFrameCallback = disguise(win, rvfc, nativeRVFC);
    VideoEl.prototype.cancelVideoFrameCallback = disguise(win, cvfc, nativeCVFC);
    ticks.add(() => {
      if (!rvfcCbs.size) return;
      const t = now(), due = [...rvfcCbs.entries()];
      rvfcCbs.clear();
      for (const [id, x] of due) {
        const v = x.video;
        // No frame presents for a video that isn't playing; hold the callback, as native does.
        if (v.paused || v.ended || v.readyState < 2) { rvfcCbs.set(id, x); continue; }
        const n = (presented.get(v) || 0) + 1; presented.set(v, n);
        const meta = { presentationTime: t, expectedDisplayTime: t + 16, width: v.videoWidth, height: v.videoHeight, mediaTime: v.currentTime, presentedFrames: n, processingDuration: 0 };
        try { x.cb(t, meta); } catch (e) { rethrow(e); }
      }
    });
  }

  // ponytail: worker-driven dispatch has two tells with no cheap fix. (1) Resolution is the ~16ms
  // worker tick, so setTimeout(fn,0)/short delays fire later and batch per tick. (2) Callbacks run
  // from the worker's onmessage, so their stack carries our dispatcher frames, unlike a native
  // callback's bare frame. Both are inherent to driving timers off a Worker; only a native timer
  // (which the browser throttles when hidden, defeating the point) avoids them.
  const timers = new Map();
  let timerSeq = 0;
  const addTimer = (cb, delay, args, repeat) => {
    // A string handler runs in global scope, like a native string timer (CSP can block both).
    if (typeof cb === 'string') { const code = cb; cb = () => win.eval(code); }
    if (typeof cb !== 'function') return 0;
    const d = Math.max(+delay || 0, 0), id = ++timerSeq;
    timers.set(id, { cb, args, repeat, d, next: now() + d });
    return id;
  };
  const setT = { setTimeout(cb, delay, ...a) { illegal(this); return addTimer(cb, delay, a, false); } }.setTimeout;
  const setI = { setInterval(cb, delay, ...a) { illegal(this); return addTimer(cb, delay, a, true); } }.setInterval;
  const clrT = { clearTimeout(id) { illegal(this); timers.delete(id); } }.clearTimeout;
  const clrI = { clearInterval(id) { illegal(this); timers.delete(id); } }.clearInterval;
  win.setTimeout = disguise(win, setT, win.setTimeout);
  win.setInterval = disguise(win, setI, win.setInterval);
  win.clearTimeout = disguise(win, clrT, win.clearTimeout);
  win.clearInterval = disguise(win, clrI, win.clearInterval);
  ticks.add(() => {
    const t = now();
    // Fire everything due this tick in scheduled order (earliest, then oldest), so a shorter delay
    // beats a longer one queued earlier. Interval repeats advance from the target time, not the
    // actual fire time, so they don't drift later by up to a tick each round.
    const due = [];
    for (const [id, x] of timers) if (t >= x.next) due.push([id, x]);
    due.sort((a, b) => a[1].next - b[1].next || a[0] - b[0]);
    for (const [id, x] of due) {
      if (!timers.has(id)) continue; // a callback earlier this tick cleared it
      if (x.repeat) { x.next += x.d; if (x.next <= t) x.next = t + x.d; } else timers.delete(id);
      try { x.cb(...x.args); } catch (e) { rethrow(e); }
    }
  });

  const block = e => e.stopImmediatePropagation();

  // webkitvisibilitychange is the legacy alias Chrome still fires; harmless to block where absent.
  for (const ev of ['visibilitychange', 'webkitvisibilitychange']) win.addEventListener(ev, block, true);

  // Block window-level blur/focus only, so form fields still work.
  for (const ev of ['blur', 'focus']) {
    win.addEventListener(ev, e => { if (e.target === win || e.target === win.document) block(e); }, true);
  }

  // Hide the mouse leaving or re-entering the window. Moves between elements still fire,
  // so menus and hovers work. Touch is left alone because it always has no relatedTarget.
  const outside = e => e.relatedTarget === null && e.pointerType !== 'touch';
  for (const ev of ['mouseout', 'mouseleave', 'pointerout', 'pointerleave', 'mouseover', 'mouseenter', 'pointerover', 'pointerenter']) {
    win.addEventListener(ev, e => { if (outside(e)) block(e); }, true);
  }
};

patch(window);

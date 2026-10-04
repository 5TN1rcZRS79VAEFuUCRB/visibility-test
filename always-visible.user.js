// ==UserScript==
// @name         Always visible
// @version      13
// @downloadURL  https://visibility.gjjb.de/always-visible.user.js
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
  // The real visibility, through the native getter (the patched one always says visible).
  const nativeHiddenGet = Object.getOwnPropertyDescriptor(docProto, 'hidden').get;
  const realHidden = () => nativeHiddenGet.call(win.document);
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

  for (const El of [win.HTMLIFrameElement, win.HTMLFrameElement]) {
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

  // Keep rAF and timers running in a hidden tab. While the tab is really visible they go to the
  // browser's own natives with the page's callback passed straight through, so their timing and
  // call stack are native. While it is hidden (when the browser would pause or throttle them) the
  // background clock drives them instead. Pending ones move across on every real visibilitychange.
  startHeartbeat();
  const now = () => win.performance.now();
  // Native Window methods throw on a wrong `this`; mirror that. `this` null/undefined is allowed
  // (bare `const s = setTimeout; s(fn)` keeps working), any other non-Window object throws.
  const illegal = (self) => { if (self != null && self.window !== self) throw new win.TypeError('Illegal invocation'); };
  // A swallowed callback error would never reach window 'error'; rethrow it on a fresh task so it
  // surfaces there as a native callback's would, without killing the dispatch loop.
  const rethrow = (e) => nativeSetTimeout(() => { throw e; });

  const nRAF = win.requestAnimationFrame, nCAF = win.cancelAnimationFrame;
  const rafCbs = new Map(); // id -> { cb, nat: native handles while on the native clock, else null }
  let rafSeq = 0;
  // The entry is dropped by a second native callback right after cb. Both run in the same frame,
  // and no visibilitychange can land between them.
  const rafNative = (id, x) => { x.nat = [nRAF.call(win, x.cb), nRAF.call(win, () => rafCbs.delete(id))]; };
  const rafToClock = (x) => { for (const h of x.nat) nCAF.call(win, h); x.nat = null; };
  const raf = { requestAnimationFrame(cb) {
    illegal(this);
    if (typeof cb !== 'function') nRAF.call(win, cb); // throws the native TypeError
    const id = ++rafSeq, x = { cb, nat: null };
    rafCbs.set(id, x);
    if (!realHidden()) rafNative(id, x);
    return id;
  } }.requestAnimationFrame;
  const caf = { cancelAnimationFrame(id) { illegal(this); const x = rafCbs.get(id); if (x?.nat) rafToClock(x); rafCbs.delete(id); } }.cancelAnimationFrame;
  win.requestAnimationFrame = disguise(win, raf, nRAF);
  win.cancelAnimationFrame = disguise(win, caf, nCAF);
  ticks.add(() => {
    if (!rafCbs.size) return;
    const t = now(), due = [...rafCbs].filter(([, x]) => !x.nat);
    for (const [id] of due) rafCbs.delete(id);
    for (const [, x] of due) { try { x.cb(t); } catch (e) { rethrow(e); } }
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

  // ponytail: while the tab is hidden, clock-driven dispatch keeps two tells. (1) Resolution is the
  // ~16ms worker tick, so short delays fire later and batch per tick. (2) Callbacks run from the
  // worker's onmessage, so their stack carries our dispatcher frames. Only a native timer avoids
  // them, and the browser throttles those when hidden, defeating the point.
  const nST = win.setTimeout, nSI = win.setInterval, nCT = win.clearTimeout;
  const timers = new Map(); // id -> { cb, args, repeat, d, next, nat, start }
  let timerSeq = 0;
  // A native setInterval runs the rest of an interval's repeats; `start` lets us find its next run.
  const startInterval = (x, delay) => { x.start = now(); x.nat = [nSI.call(win, x.cb, delay, ...x.args)]; };
  // One run on a native timer. The bookkeeping timer is queued first so it runs just before cb, in
  // its own task: a one-shot is done, an interval moves on to a native setInterval. If the tab hides
  // between the two, cb still fires once (throttled); it is never lost or doubled.
  const timerNative = (id, x, wait) => {
    x.start = null;
    x.nat = [nST.call(win, () => (x.repeat ? startInterval(x, x.d) : timers.delete(id)), wait), nST.call(win, x.cb, wait, ...x.args)];
  };
  const timerToClock = (x) => {
    for (const h of x.nat) nCT.call(win, h);
    if (x.start != null) { const p = Math.max(x.d, 1); x.next = x.start + p * Math.ceil((now() - x.start) / p); }
    x.nat = x.start = null;
  };
  const addTimer = (cb, delay, args, repeat) => {
    if (typeof cb !== 'function' && typeof cb !== 'string') return 0;
    const d = Math.max(+delay || 0, 0), id = ++timerSeq, x = { cb, args, repeat, d, next: now() + d, nat: null, start: null };
    timers.set(id, x);
    // The page's own delay value goes to the native, so it is coerced and clamped natively.
    if (!realHidden()) { if (repeat) startInterval(x, delay); else timerNative(id, x, delay); }
    return id;
  };
  const clear = (id) => { const x = timers.get(id); if (x?.nat) timerToClock(x); timers.delete(id); };
  const setT = { setTimeout(cb, delay, ...a) { illegal(this); return addTimer(cb, delay, a, false); } }.setTimeout;
  const setI = { setInterval(cb, delay, ...a) { illegal(this); return addTimer(cb, delay, a, true); } }.setInterval;
  const clrT = { clearTimeout(id) { illegal(this); clear(id); } }.clearTimeout;
  const clrI = { clearInterval(id) { illegal(this); clear(id); } }.clearInterval;
  win.setTimeout = disguise(win, setT, nST);
  win.setInterval = disguise(win, setI, nSI);
  win.clearTimeout = disguise(win, clrT, nCT);
  win.clearInterval = disguise(win, clrI, win.clearInterval);
  ticks.add(() => {
    const t = now();
    // Fire everything due this tick in scheduled order (earliest, then oldest), so a shorter delay
    // beats a longer one queued earlier. Interval repeats advance from the target time, not the
    // actual fire time, so they don't drift later by up to a tick each round.
    const due = [];
    for (const [id, x] of timers) if (!x.nat && t >= x.next) due.push([id, x]);
    due.sort((a, b) => a[1].next - b[1].next || a[0] - b[0]);
    for (const [id, x] of due) {
      if (!timers.has(id)) continue; // a callback earlier this tick cleared it
      if (x.repeat) { x.next += x.d; if (x.next <= t) x.next = t + x.d; } else timers.delete(id);
      // A string handler runs in global scope, like a native string timer (CSP can block both).
      try { typeof x.cb === 'string' ? win.eval(x.cb) : x.cb(...x.args); } catch (e) { rethrow(e); }
    }
  });

  // Move pending rAF callbacks and timers to the clock when the tab really hides, and back to the
  // natives when it shows. Registered before the visibilitychange blocker below, so it still runs.
  win.addEventListener('visibilitychange', () => {
    const hidden = realHidden();
    for (const [id, x] of rafCbs) if (hidden && x.nat) rafToClock(x); else if (!hidden && !x.nat) rafNative(id, x);
    for (const [id, x] of timers) if (hidden && x.nat) timerToClock(x); else if (!hidden && !x.nat) timerNative(id, x, x.next - now());
  }, true);

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

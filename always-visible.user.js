// ==UserScript==
// @name         Always visible
// @version      5
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
  replaceGetter(win, docProto, 'hidden', () => false);
  replaceGetter(win, docProto, 'visibilityState', () => 'visible');
  const nativeHasFocus = docProto.hasFocus;
  const { hasFocus } = { hasFocus() { return true; } };
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

  // Run rAF and timers off the background clock so a hidden tab shows no frame/timer pause.
  startHeartbeat();
  const now = () => win.performance.now();

  const rafCbs = new Map();
  let rafSeq = 0;
  const raf = { requestAnimationFrame(cb) { const id = ++rafSeq; rafCbs.set(id, cb); return id; } }.requestAnimationFrame;
  const caf = { cancelAnimationFrame(id) { rafCbs.delete(id); } }.cancelAnimationFrame;
  win.requestAnimationFrame = disguise(win, raf, win.requestAnimationFrame);
  win.cancelAnimationFrame = disguise(win, caf, win.cancelAnimationFrame);
  ticks.add(() => {
    if (!rafCbs.size) return;
    const t = now(), due = [...rafCbs.values()];
    rafCbs.clear();
    for (const cb of due) { try { cb(t); } catch {} }
  });

  // ponytail: resolution is now the ~16ms worker tick, so setTimeout(fn,0)/short delays fire a
  // little later and batch per tick. Fine for throttle probes and animation; a page needing
  // sub-frame timer precision would notice.
  const timers = new Map();
  let timerSeq = 0;
  const addTimer = (cb, delay, args, repeat) => {
    if (typeof cb !== 'function') return 0;
    const d = Math.max(+delay || 0, 0), id = ++timerSeq;
    timers.set(id, { cb, args, repeat, d, next: now() + d });
    return id;
  };
  const setT = { setTimeout(cb, delay, ...a) { return addTimer(cb, delay, a, false); } }.setTimeout;
  const setI = { setInterval(cb, delay, ...a) { return addTimer(cb, delay, a, true); } }.setInterval;
  const clrT = { clearTimeout(id) { timers.delete(id); } }.clearTimeout;
  const clrI = { clearInterval(id) { timers.delete(id); } }.clearInterval;
  win.setTimeout = disguise(win, setT, win.setTimeout);
  win.setInterval = disguise(win, setI, win.setInterval);
  win.clearTimeout = disguise(win, clrT, win.clearTimeout);
  win.clearInterval = disguise(win, clrI, win.clearInterval);
  ticks.add(() => {
    const t = now();
    for (const [id, x] of timers) {
      if (t >= x.next) {
        if (x.repeat) x.next = t + x.d; else timers.delete(id);
        try { x.cb(...x.args); } catch {}
      }
    }
  });

  const block = e => e.stopImmediatePropagation();

  win.addEventListener('visibilitychange', block, true);

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

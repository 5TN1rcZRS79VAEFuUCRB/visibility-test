# Always visible

A userscript that makes a web page believe it is always the focused, visible, foreground tab — even when it is backgrounded, minimized, or the window has lost focus. Useful for stopping sites that pause video, throttle work, or log you out when they think you have looked away.

## What it does

`always-visible.user.js` patches, in every same-origin frame:

- `document.hidden` → always `false`, `document.visibilityState` → always `'visible'`, `document.hasFocus()` → always `true`.
- Swallows `visibilitychange`, and window-level `blur`/`focus`, so page handlers never fire for them.
- Swallows mouse/pointer events that only signal the cursor leaving or re-entering the window; moves between elements still fire, so menus and hovers keep working.
- Drives `requestAnimationFrame` and `setTimeout`/`setInterval` off a Web Worker heartbeat, so frames and timers keep near-real cadence in a backgrounded tab instead of being paused or clamped.

The fakes are installed on the prototypes with native names and a patched `Function.prototype.toString`, so a page reading `document.hidden`'s getter — directly, via an iframe realm, or via `window[i]` — sees native-looking code.

### Limits

- Frames created by `innerHTML` / `outerHTML` / `insertAdjacentHTML` or `window.open()` are not patched.
- If a `Worker` is blocked (e.g. CSP `worker-src`), it falls back to a native timer, which the browser still throttles when the tab is hidden — so the background pause can reappear.
- Timer resolution becomes the ~16 ms worker tick, so very short delays fire a little later and batch per tick.

## Install

Needs a userscript manager (Tampermonkey, Violentmonkey, or similar). Open `always-visible.user.js` in the manager, or add it as a new script. It matches all URLs and runs at `document-start`.

## Testing

`index.html` is a test page. Open it, keep it focused, and click **Run again** to confirm normal page behavior still works (hover, focus/blur, keyboard, input events). Then switch to another tab or window: with the script active, the **Detections** list should stay empty — no visibility change, no focus loss, no paused frames, no visible tampering.

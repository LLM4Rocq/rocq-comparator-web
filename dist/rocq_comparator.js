// rocq_comparator.js — main-thread loader that installs window.RocqComparator.
//
// It spawns rocq_worker.js (which hosts the OCaml Rocq engine) and forwards
// check() calls to it, implementing the frozen contract (BACKEND.md section 6):
//
//   window.RocqComparator = { ready: Promise, check(reqJson, onProgress?)->Promise, version }
//
//   * ready       resolves once the worker has loaded the engine + run init.
//   * check       serializes calls (one at a time), resolves with the verdict
//                 JSON for every in-band outcome, and REJECTS out-of-band only
//                 (malformed request, engine trap, or the HARD timeout below).
//                 The optional onProgress(ev) callback receives
//                 {stage:'download', pack, packsDone, packsTotal, bytes, bytesTotal}
//                 while library packs the request imports are fetched, then
//                 {stage:'check'} when the engine starts checking.
//   * hard cap    the main thread arms a timer when the worker reports the
//                 check stage (library downloads never count); on expiry it
//                 terminate()s the worker, rejects that call with
//                 Error("timeout"), and respawns the worker (re-ready).
//
// Additions beyond the three frozen members (BACKEND.md section 6.2):
//
//   * support     {gc, tailCalls, exceptions}: the WebAssembly extensions the
//                 engines need, feature-detected below before any worker is
//                 spawned. When one is missing no worker is spawned and ready
//                 rejects with a message naming it.
//   * stage       while ready is pending: 'engine' (the worker is fetching and
//                 compiling the wasm module) or 'prelude' (mounting the Corelib).
//   * engine      'engine-jspi' or 'engine-cps', once ready.
//   * fallback    null, or the JSPI engine's error when it failed to start and
//                 the worker was respawned once on the cps engine.
//
// Load with  <script src="rocq_comparator.js"></script>  BEFORE app.js.
(function () {
  "use strict";

  var worker = null;
  var workerReady = null;           // the current worker's own 'ready' (a respawn gets a new one)
  var readyRes, readyRej;
  var seq = 0;
  var pending = new Map();          // id -> {resolve, reject, timer}
  var version, engine, stage = null, fallback = null;
  var readyResolve, readyReject;
  var ready = new Promise(function (res, rej) { readyResolve = res; readyReject = rej; });
  var readySettled = false;

  function settleReadyOk()  { if (!readySettled) { readySettled = true; readyResolve(); } }
  function settleReadyErr(e){ if (!readySettled) { readySettled = true; readyReject(e); } }

  // ?engine=cps|jspi on the page URL is forwarded to the worker, which then
  // loads that engine variant instead of auto-detecting JSPI.
  var forced = '';
  try { forced = (new URLSearchParams(window.location.search).get('engine') || '').toLowerCase(); } catch (_) {}
  var engineQuery = forced ? '?engine=' + encodeURIComponent(forced) : '';

  // The engines are wasm_of_ocaml output and need three WebAssembly extensions:
  // GC (typed references, i31), tail calls and exception handling (the legacy
  // try/catch form the compiler emits for browsers). Chrome and Edge 119+,
  // Firefox 122+, Safari 18.2+. Each is detected by validating a minimal module
  // that uses it: the 8-byte header, then a type section and, where needed, a
  // function, tag and code section.
  var PROBES = {
    // (type (struct))
    gc: [0, 97, 115, 109, 1, 0, 0, 0, 1, 3, 1, 0x5f, 0],
    // (type (func)) (func (type 0) (return_call 0))
    tailCalls: [0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 0x60, 0, 0, 3, 2, 1, 0, 10, 6, 1, 4, 0, 0x12, 0, 0x0b],
    // (type (func)) (tag (type 0)) (func (type 0) (try (throw 0) (catch 0)))
    exceptions: [0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 0x60, 0, 0, 3, 2, 1, 0, 13, 3, 1, 0, 0, 10, 11, 1, 9, 0, 0x06, 0x40, 0x08, 0, 0x07, 0, 0x0b, 0x0b]
  };
  function validates(bytes) {
    try { return WebAssembly.validate(new Uint8Array(bytes)); } catch (_) { return false; }
  }
  var support = { gc: validates(PROBES.gc), tailCalls: validates(PROBES.tailCalls), exceptions: validates(PROBES.exceptions) };
  var missing = [];
  if (!support.gc) missing.push('GC');
  if (!support.tailCalls) missing.push('tail calls');
  if (!support.exceptions) missing.push('exception handling');

  // keepReady: reuse the current workerReady (the JSPI fallback below replaces
  // the worker before anyone could have seen it fail)
  function spawn(keepReady) {
    worker = new Worker('rocq_worker.js' + engineQuery);
    if (!keepReady) {
      workerReady = new Promise(function (res, rej) { readyRes = res; readyRej = rej; });
      workerReady.catch(function () {}); // reported per check, below
    }
    worker.onmessage = function (ev) {
      var d = ev.data || {};
      if (d.type === 'loading') { stage = d.stage; return; }
      if (d.type === 'ready')  { stage = null; engine = d.engine; version = d.version; readyRes(); settleReadyOk(); return; }
      if (d.type === 'fatal') {
        // The JSPI engine failed to start on a browser that exposes
        // WebAssembly.Suspending: once, respawn the worker on the cps engine.
        if (d.engine === 'engine-jspi' && !forced && fallback === null) {
          fallback = d.error || 'engine failed to load';
          engineQuery = '?engine=cps';
          try { worker.terminate(); } catch (_) {}
          spawn(true);
          return;
        }
        var f = new Error(d.error || 'engine failed to load'); readyRej(f); settleReadyErr(f); return;
      }
      if (d.type === 'progress') {
        var q = pending.get(d.id);
        if (q && d.stage === 'check') q.arm();
        if (q && q.onProgress) { try { q.onProgress(d); } catch (_) {} }
        return;
      }
      if (d.type === 'result') {
        var p = pending.get(d.id);
        if (!p) return;
        pending.delete(d.id);
        clearTimeout(p.timer);
        if (d.ok) p.resolve(d.result);
        else p.reject(new Error(d.error || 'internal error'));
      }
    };
    worker.onerror = function (ev) {
      var e = new Error((ev && ev.message) || 'worker error');
      readyRej(e); settleReadyErr(e);
      pending.forEach(function (p) { clearTimeout(p.timer); p.reject(e); });
      pending.clear();
    };
  }

  function respawnAfterKill() {
    // reject everything in flight; the worker was terminated
    pending.forEach(function (p) { clearTimeout(p.timer); p.reject(new Error('worker terminated')); });
    pending.clear();
    // a fresh worker; ready is already settled (stays resolved for the app)
    spawn();
  }

  // serialize check() calls through a promise chain (glue queues; resolves in order)
  var queue = Promise.resolve();

  function doCheck(request, onProgress) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      var timeoutS = 600; // the core's own default (Config.default_timeout_s)
      try {
        var cfg = JSON.parse(request).config;
        if (cfg && typeof cfg.timeout_s === 'number' && cfg.timeout_s > 0) timeoutS = cfg.timeout_s;
      } catch (_) { /* malformed request: let the engine return config_error */ }
      var p = { resolve: resolve, reject: reject, timer: null, onProgress: onProgress };
      // The hard cap covers the check, not the library downloads before it: the
      // timer is armed by the worker's {stage:'check'} event. It gives the engine
      // its own timeout_s budget plus slack, so the in-band timeout verdict (more
      // informative) wins whenever the engine notices first.
      p.arm = function () {
        if (p.timer) return;
        p.timer = setTimeout(function () {
          pending.delete(id);
          try { worker.terminate(); } catch (_) {}
          respawnAfterKill();
          reject(new Error('timeout'));
        }, Math.ceil((timeoutS + 5) * 1000));
      };
      pending.set(id, p);
      // never post before the worker listens: its onmessage exists once the
      // engine has loaded (seconds after a respawn), and an earlier message is lost
      workerReady.then(function () { worker.postMessage({ type: 'check', id: id, request: request }); },
                       function (e) { pending.delete(id); reject(e); });
    });
  }

  function check(request, onProgress) {
    var p = queue.then(function () { return doCheck(request, onProgress); },
                       function () { return doCheck(request, onProgress); });
    queue = p.then(function () {}, function () {}); // keep the chain alive
    return p;
  }

  if (typeof Worker === 'undefined') {
    settleReadyErr(new Error('Web Workers are not available in this environment'));
  } else if (missing.length) {
    var list = missing.length > 1 ? missing.slice(0, -1).join(', ') + ' and ' + missing[missing.length - 1] : missing[0];
    settleReadyErr(new Error('This browser cannot run the engine: it lacks WebAssembly ' + list +
      '. Supported: Chrome and Edge 119+, Firefox 122+, Safari 18.2+ (iOS 18.2+).'));
  } else {
    spawn();
  }

  window.RocqComparator = {
    ready: ready,
    check: check,
    support: support,
    get version() { return version; },
    get stage() { return stage; },
    get engine() { return engine; },
    get fallback() { return fallback; }
  };
})();

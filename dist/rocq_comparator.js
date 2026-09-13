// rocq_comparator.js — main-thread loader that installs window.RocqComparator.
//
// It spawns rocq_worker.js (which hosts the OCaml Rocq engine) and forwards
// check() calls to it, implementing the frozen contract (BACKEND.md section 6):
//
//   window.RocqComparator = { ready: Promise, check(reqJson)->Promise, version }
//
//   * ready       resolves once the worker has loaded the engine + run init.
//   * check       serializes calls (one at a time), resolves with the verdict
//                 JSON for every in-band outcome, and REJECTS out-of-band only
//                 (malformed request, engine trap, or the HARD timeout below).
//   * hard cap    the main thread starts a timer per check; on expiry it
//                 terminate()s the worker, rejects that call with
//                 Error("timeout"), and respawns the worker (re-ready).
//
// Load with  <script src="rocq_comparator.js"></script>  BEFORE app.js.
(function () {
  "use strict";

  var worker = null;
  var seq = 0;
  var pending = new Map();          // id -> {resolve, reject, timer}
  var version;
  var readyResolve, readyReject;
  var ready = new Promise(function (res, rej) { readyResolve = res; readyReject = rej; });
  var readySettled = false;

  function settleReadyOk()  { if (!readySettled) { readySettled = true; readyResolve(); } }
  function settleReadyErr(e){ if (!readySettled) { readySettled = true; readyReject(e); } }

  function spawn() {
    // ?engine=cps|jspi on the page URL is forwarded to the worker, which then
    // loads that engine variant instead of auto-detecting JSPI.
    var q = '';
    try { var e = new URLSearchParams(window.location.search).get('engine'); if (e) q = '?engine=' + encodeURIComponent(e); } catch (_) {}
    worker = new Worker('rocq_worker.js' + q);
    worker.onmessage = function (ev) {
      var d = ev.data || {};
      if (d.type === 'ready')  { version = d.version; settleReadyOk(); return; }
      if (d.type === 'fatal')  { settleReadyErr(new Error(d.error || 'engine failed to load')); return; }
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
      settleReadyErr(new Error((ev && ev.message) || 'worker error'));
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

  function doCheck(request) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      var timeoutMs = 60000;
      try {
        var cfg = JSON.parse(request).config;
        if (cfg && typeof cfg.timeout_s === 'number' && cfg.timeout_s > 0) {
          timeoutMs = Math.ceil((cfg.timeout_s + 5) * 1000); // soft budget + slack
        }
      } catch (_) { /* malformed request: let the engine return config_error */ }
      var timer = setTimeout(function () {
        pending.delete(id);
        try { worker.terminate(); } catch (_) {}
        respawnAfterKill();
        reject(new Error('timeout'));
      }, timeoutMs);
      pending.set(id, { resolve: resolve, reject: reject, timer: timer });
      worker.postMessage({ type: 'check', id: id, request: request });
    });
  }

  function check(request) {
    var p = queue.then(function () { return doCheck(request); },
                       function () { return doCheck(request); });
    queue = p.then(function () {}, function () {}); // keep the chain alive
    return p;
  }

  if (typeof Worker === 'undefined') {
    settleReadyErr(new Error('Web Workers are not available in this environment'));
  } else {
    spawn();
  }

  window.RocqComparator = {
    ready: ready,
    check: check,
    get version() { return version; }
  };
})();

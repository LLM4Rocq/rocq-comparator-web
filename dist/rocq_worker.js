// rocq_worker.js — the Web Worker that hosts the OCaml Rocq engine.
//
// It loads rocq_engine.js (the js_of_ocaml build of web_check.ml), which
// installs `RocqComparator` on the worker global. It then serves check()
// requests from the main thread over postMessage. Running the engine in a
// worker keeps the UI responsive and, crucially, lets the main thread enforce
// a HARD wall-clock cap by terminate()-ing this worker (BACKEND.md section 6).

self.window = self; // web_check installs on the global; make `window` an alias

try {
  importScripts('rocq_engine.js');
} catch (e) {
  self.postMessage({ type: 'fatal', error: 'failed to load rocq_engine.js: ' + (e && e.message || e) });
  throw e;
}

var engine = self.RocqComparator;

(async function () {
  try {
    if (!engine || typeof engine.check !== 'function') throw new Error('engine did not install RocqComparator');
    await engine.ready;
    self.postMessage({ type: 'ready', version: engine.version });
  } catch (e) {
    self.postMessage({ type: 'fatal', error: (e && e.message) || String(e) });
    return;
  }
  self.onmessage = async function (ev) {
    var msg = ev.data || {};
    if (msg.type !== 'check') return;
    try {
      var result = await engine.check(msg.request);   // resolved verdict JSON
      self.postMessage({ type: 'result', id: msg.id, ok: true, result: result });
    } catch (err) {
      // out-of-band failure (malformed request, wasm trap, ...) — see contract
      self.postMessage({ type: 'result', id: msg.id, ok: false, error: (err && err.message) || String(err) });
    }
  };
})();

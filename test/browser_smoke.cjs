// browser_smoke.cjs — run the SHIPPED site in a REAL browser and check a proof.
//
// The node harness (judge_test.cjs) drives the engine directly and cannot see the
// seams a browser exercises: the Worker, importScripts, fetch of binary assets,
// MIME types, 404s, JSPI detection. Every bug reported from `make serve` so far
// lived in exactly those seams. This test serves dist/ over HTTP, opens the page
// in a headless Chromium-family browser via the DevTools protocol (no npm
// dependencies: Node's built-in WebSocket + http), and asserts:
//
//   1. the page reaches "Rocq runtime ready" (no worker fatal, no 404 on any
//      asset the worker imports or fetches);
//   2. clicking Run on the page's default example produces an accepted verdict,
//      and a check that outruns the page's timeout is stopped with the timeout
//      message (the worker is respawned);
//   3. through window.RocqComparator: a Stdlib (ZArith + ring) proof is
//      accepted, an Admitted one is rejected as not_proved, a wrong statement is
//      a statement_mismatch; when the mathcomp packs are staged, an ssreflect
//      proof against the trusted .vos library is accepted;
//   4. lazy import: no Stdlib or mathcomp file is downloaded until a source
//      imports it.
//
// It runs the page as shipped (the worker upgrades to the JSPI engine when the
// browser has it), on /?engine=cps, which the page forwards to the worker to
// force the cps engine, and, locally, with the JSPI engine's module blocked
// (a 404) so the worker must fall back to the cps engine. Both engines must
// pass. A last page, with WebAssembly.validate stubbed out, checks the
// unsupported-browser path: a specific message, no worker, demo verdicts.
//
//   node test/browser_smoke.cjs [dist]            # BROWSER=/path/to/chrome to override
//
// Exit 0 = every assertion passed in both passes; non-zero otherwise. If no
// Chromium-family browser is found the test exits 3 with a clear message.
'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const cp = require('child_process'), os = require('os');

// node test/browser_smoke.cjs [dist]                serve a local dist/ (default)
// node test/browser_smoke.cjs --url https://host/p   test an already-deployed site
// SMOKE_HEAVY=0 skips the mathcomp-analysis case (206 MB fetch, multi-GB check).
// SMOKE_SHOT=/path/file.png saves a screenshot of the page once the runtime is ready.
const ui = process.argv.indexOf('--url');
const REMOTE = ui !== -1 ? process.argv[ui + 1].replace(/\/$/, '') : null;
const DIST = path.resolve((ui === -1 && process.argv[2]) || path.join(__dirname, '..', 'dist'));
const HEAVY = process.env.SMOKE_HEAVY !== '0';
const PAGE_READY_MS = 300000, CHECK_MS = 300000;

// ---------------------------------------------------------------- browser
const CANDIDATES = [
  process.env.BROWSER,
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'brave-browser', 'microsoft-edge',
].filter(Boolean);
function findBrowser() {
  for (const c of CANDIDATES) {
    if (path.isAbsolute(c)) { if (fs.existsSync(c)) return c; continue; }
    const r = cp.spawnSync('which', [c], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return null;
}
function launchBrowser(exe) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rocq-smoke-'));
  const child = cp.spawn(exe, [
    '--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = new Promise((resolve, reject) => {
    let buf = '';
    child.stderr.on('data', (d) => {
      buf += d.toString();
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) resolve(m[1]);
    });
    child.on('exit', (code) => reject(new Error('browser exited early (code ' + code + ')\n' + buf.slice(-2000))));
    setTimeout(() => reject(new Error('browser gave no DevTools endpoint in 30s\n' + buf.slice(-2000))), 30000);
  });
  const kill = () => { try { child.kill('SIGKILL'); } catch (_) {} try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {} };
  return { wsUrl, kill };
}

// ---------------------------------------------------------------- CDP
class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = [];
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
      } else if (m.method) for (const l of this.listeners) l(m);
    };
  }
  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => resolve(new CDP(ws));
      ws.onerror = (e) => reject(new Error('CDP connect failed: ' + (e && e.message)));
    });
  }
  send(method, params, sessionId) {
    const id = ++this.id, msg = { id, method, params: params || {} };
    if (sessionId) msg.sessionId = sessionId;
    this.ws.send(JSON.stringify(msg));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(fn) { this.listeners.push(fn); }
}
// Evaluate a JS expression in a session; awaits promises; throws on exception.
async function evaluate(cdp, sessionId, expression, timeoutMs) {
  const r = await Promise.race([
    cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId),
    new Promise((_, rej) => setTimeout(() => rej(new Error('evaluate timed out after ' + timeoutMs + 'ms')), timeoutMs)),
  ]);
  if (r.exceptionDetails) {
    const ex = r.exceptionDetails.exception;
    throw new Error((ex && (ex.description || ex.value)) || r.exceptionDetails.text || 'page exception');
  }
  return r.result.value;
}

// ---------------------------------------------------------------- static server
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.wasm': 'application/wasm', '.vo': 'application/octet-stream', '.vos': 'application/octet-stream',
  '.md': 'text/markdown', '.META': 'text/plain', '.svg': 'image/svg+xml', '.png': 'image/png',
};
function serve(dir, log) {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p.endsWith('/')) p += 'index.html';
    if (log.block && log.block.test(p)) { log.blocked.push(p); res.writeHead(404); return res.end('blocked by the test'); }
    const file = path.normalize(path.join(dir, p));
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      log.notFound.push(p); res.writeHead(404); return res.end('not found');
    }
    log.served.push(p);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

// ---------------------------------------------------------------- the checks
let SAMPLE_CONFIG, PACKS, HAS_MATHCOMP, HAS_ANALYSIS, HAS_COQUELICOT, HAS_EQUATIONS;
async function loadSiteData() {
  const read = async (rel) => REMOTE
    ? (await fetch(REMOTE + '/' + rel)).json()
    : JSON.parse(fs.readFileSync(path.join(DIST, rel), 'utf8'));
  SAMPLE_CONFIG = await read('examples/config.sample.json');
  PACKS = await read('coqlib/packs.json');
  HAS_MATHCOMP = PACKS.packs.some((p) => p.name === 'mathcomp-ssreflect');
  HAS_ANALYSIS = HEAVY && PACKS.packs.some((p) => p.name === 'mathcomp-analysis');
  HAS_COQUELICOT = PACKS.packs.some((p) => p.name === 'coquelicot');
  HAS_EQUATIONS = PACKS.packs.some((p) => p.name === 'equations');
}
const PAGE_TIMEOUT_S = 300; // the page's default (index.html); the analysis case must pass within it
function request(theorem, challenge, solution) {
  return JSON.stringify({ config: Object.assign({}, SAMPLE_CONFIG, { theorem_names: [theorem], timeout_s: PAGE_TIMEOUT_S }),
                          files: { 'challenge.v': challenge, 'solution.v': solution } });
}
const Z_CH  = 'From Stdlib Require Import ZArith. Open Scope Z_scope.\nTheorem sq : forall a b : Z, (a+b)*(a+b) = a*a + 2*a*b + b*b.\nProof. Admitted.\n';
const Z_SOL = 'From Stdlib Require Import ZArith. Open Scope Z_scope.\nTheorem sq : forall a b : Z, (a+b)*(a+b) = a*a + 2*a*b + b*b.\nProof. intros; ring. Qed.\n';
const N_CH  = 'Theorem add_0_r : forall n : nat, n + 0 = n.\nProof. Admitted.\n';
const N_BAD = 'Theorem add_0_r : forall n : nat, 0 + n = n.\nProof. reflexivity. Qed.\n';
const M_CH  = 'From mathcomp Require Import all_ssreflect.\nLemma foo (s : seq nat) : size (rev s) = size s.\nProof. Admitted.\n';
const M_SOL = 'From mathcomp Require Import all_ssreflect.\nLemma foo (s : seq nat) : size (rev s) = size s.\nProof. by rewrite size_rev. Qed.\n';
const A_CH  = 'From mathcomp Require Import all_ssreflect all_algebra reals sequences exp.\nLocal Open Scope ring_scope.\nLemma foo (R : realType) : expR 0 = 1 :> R.\nProof. Admitted.\n';
const A_SOL = 'From mathcomp Require Import all_ssreflect all_algebra reals sequences exp.\nLocal Open Scope ring_scope.\nLemma foo (R : realType) : expR 0 = 1 :> R.\nProof. exact: expR0. Qed.\n';
const C_CH  = 'From Stdlib Require Import Reals.\nFrom Coquelicot Require Import Coquelicot.\nTheorem foo : forall x : R, is_derive (fun y => y * y) x (2 * x).\nProof. Admitted.\n';
const C_SOL = 'From Stdlib Require Import Reals.\nFrom Coquelicot Require Import Coquelicot.\nTheorem foo : forall x : R, is_derive (fun y => y * y) x (2 * x).\nProof. intros x; auto_derive; [exact I | ring]. Qed.\n';
const E_CH  = 'From Equations Require Import Equations.\nEquations len {A : Set} (l : list A) : nat := len nil := 0; len (cons _ l) := S (len l).\nTheorem foo : forall (A : Set) (l1 l2 : list A), len (l1 ++ l2) = len l1 + len l2.\nProof. Admitted.\n';
const E_SOL = 'From Equations Require Import Equations.\nEquations len {A : Set} (l : list A) : nat := len nil := 0; len (cons _ l) := S (len l).\nTheorem foo : forall (A : Set) (l1 l2 : list A), len (l1 ++ l2) = len l1 + len l2.\nProof. intros A l1 l2; funelim (len l1); simpl; simp len; f_equal; auto. Qed.\n';
const servedUnder = (log, dir) => log.served.filter((p) => p.indexOf('/coqlib/user-contrib/' + dir + '/') === 0).length;

// One pass: fresh page, all assertions. variant: 'auto' (as shipped), 'cps'
// (/?engine=cps) or 'fallback' (the JSPI module is blocked; startup only).
async function runPass(cdp, origin, variant, log) {
  const forceCps = variant === 'cps';
  const results = []; const consoleErrors = []; const workerErrors = [];
  const ok = (name, cond, note) => { results.push({ name, cond: !!cond, note }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (note ? '  ' + note : '')); };
  // assertions that read the local server log have no evidence against a remote site
  const okLocal = (name, cond, note) => REMOTE ? console.log('SKIP ' + name + '  (remote site: no server log)') : ok(name, cond, note);

  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  // Auto-attach to the page's Workers to capture worker-side exceptions.
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
  cdp.on(async (m) => {
    if (m.method === 'Target.attachedToTarget' && m.params.targetInfo.type === 'worker') {
      const ws = m.params.sessionId;
      try {
        await cdp.send('Runtime.enable', {}, ws);
        await cdp.send('Runtime.runIfWaitingForDebugger', {}, ws);
      } catch (e) { workerErrors.push('attach: ' + e.message); }
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const ex = m.params.exceptionDetails, txt = (ex.exception && ex.exception.description) || ex.text;
      (m.sessionId === sessionId ? consoleErrors : workerErrors).push(txt);
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      const txt = m.params.args.map((a) => a.value || a.description || '').join(' ');
      (m.sessionId === sessionId ? consoleErrors : workerErrors).push(txt);
    }
  });

  log.served.length = 0; log.notFound.length = 0; log.blocked.length = 0;
  log.block = variant === 'fallback' ? /^\/engine-jspi\/rocq_engine\.assets\//
            : variant === 'packfail' ? /^\/coqlib\/user-contrib\/Coquelicot\// : null;
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Page.navigate', { url: origin + (forceCps ? '/?engine=cps' : '/') }, sessionId);

  // 1. the runtime loads (this is where "Backend not available" would show up)
  let version = null, readyErr = null;
  try {
    version = await evaluate(cdp, sessionId, `(async () => {
      const t0 = Date.now();
      while (!window.RocqComparator) { if (Date.now() - t0 > 30000) throw new Error('window.RocqComparator never installed (rocq_comparator.js not loaded?)'); await new Promise(r => setTimeout(r, 100)); }
      await window.RocqComparator.ready;
      const t1 = Date.now();
      while (document.getElementById('runBtn').disabled) { if (Date.now() - t1 > 10000) throw new Error('Run button stayed disabled after ready'); await new Promise(r => setTimeout(r, 50)); }
      return window.RocqComparator.version;
    })()`, PAGE_READY_MS);
  } catch (e) { readyErr = e.message; }
  const notice = await evaluate(cdp, sessionId, `(() => { const n = document.getElementById('unavailableNotice'); return n && !n.hidden ? document.getElementById('unavailableDetail').textContent : null; })()`, 5000).catch(() => null);
  ok('runtime ready in the browser', !readyErr && !notice, readyErr ? readyErr : notice ? 'page shows: ' + notice : 'rocq ' + version);
  const state = await evaluate(cdp, sessionId, `(() => { const rc = window.RocqComparator || {}; return { support: rc.support, engine: rc.engine, fallback: rc.fallback, note: document.getElementById('runNote').textContent }; })()`, 5000).catch(() => ({}));
  const s = state.support || {};
  ok('feature detection: WebAssembly GC, tail calls and exception handling supported', s.gc === true && s.tailCalls === true && s.exceptions === true, JSON.stringify(state.support));
  if (process.env.SMOKE_SHOT && variant === 'auto') {
    try {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
      await new Promise((r) => setTimeout(r, 1500));
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
      fs.writeFileSync(process.env.SMOKE_SHOT, Buffer.from(shot.data, 'base64'));
      console.log('screenshot: ' + process.env.SMOKE_SHOT);
    } catch (e) { console.log('screenshot failed: ' + e.message); }
  }
  const engine = state.engine || '(none)';
  ok('engine loaded', /^engine-(cps|jspi)$/.test(engine), engine + (forceCps ? ' (forced by ?engine=cps)' : variant === 'fallback' ? ' (after the JSPI engine failed)' : ' (auto)'));
  okLocal('the engine the loader reports is the one served', log.served.indexOf('/' + engine + '/rocq_engine.js') !== -1);
  if (forceCps) ok('?engine=cps selects the cps engine', engine === 'engine-cps', engine);
  const bad404 = log.notFound.filter((p) => !/favicon\.ico$/.test(p));
  okLocal('no missing assets (404)', bad404.length === 0, bad404.length ? bad404.slice(0, 5).join(' ') : log.served.length + ' files served');
  ok('no page-side JS errors', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));
  if (variant !== 'fallback') ok('no worker-side JS errors', workerErrors.length === 0, workerErrors.slice(0, 2).join(' | '));
  okLocal('lazy: no Stdlib or mathcomp file downloaded at startup', servedUnder(log, 'Stdlib') === 0 && servedUnder(log, 'mathcomp') === 0,
     'Stdlib=' + servedUnder(log, 'Stdlib') + ' mathcomp=' + servedUnder(log, 'mathcomp'));
  if (variant === 'fallback') {
    // the blocked JSPI module fails inside the engine glue (an unhandled
    // rejection the worker forwards as the fatal, with the browser's text); the
    // loader must then come up on the cps engine and the page must say so
    ok('JSPI engine failure falls back to the cps engine', engine === 'engine-cps' && typeof state.fallback === 'string' && state.fallback.length > 0,
       'fallback: ' + String(state.fallback).replace(/\n/g, ' ').slice(0, 160));
    ok('the page notes the fallback', /JSPI engine failed/.test(state.note), state.note);
    okLocal('the JSPI module was blocked and the cps module served', log.blocked.length > 0 && log.served.some((p) => /^\/engine-cps\/rocq_engine\.assets\//.test(p)),
       'blocked=' + log.blocked.join(' '));
  }
  // a library that cannot be downloaded must be reported as such, never left to
  // the engine to report as a missing library (which reads as a bad proof)
  if (variant === 'packfail') {
    const r = await evaluate(cdp, sessionId, `(async () => {
      document.getElementById('challengeSrc').value = ${JSON.stringify(C_CH)};
      document.getElementById('solutionSrc').value = ${JSON.stringify(C_SOL)};
      for (const id of ['challengeSrc', 'solutionSrc']) document.getElementById(id).dispatchEvent(new Event('input'));
      document.getElementById('runBtn').click();
      const t0 = Date.now();
      while (document.getElementById('verdictBody').hidden) {
        if (Date.now() - t0 > 180000) return { title: '(no verdict)' };
        await new Promise(r => setTimeout(r, 200));
      }
      const b = document.querySelector('#verdictBody .banner');
      return { title: b && b.querySelector('.title') && b.querySelector('.title').textContent,
               detail: (document.querySelector('#verdictBody .detail-box') || {}).textContent };
    })()`, 200000).catch((e) => ({ title: 'evaluate failed: ' + e.message }));
    ok('a library that fails to download is reported as such, not as a bad proof',
       r.title === 'Library download failed' && /Coquelicot/.test(r.detail || ''),
       r.title + ' | ' + String(r.detail || '').slice(0, 120));
    await cdp.send('Target.closeTarget', { targetId });
    return results;
  }
  if (readyErr || notice || variant === 'fallback') { await cdp.send('Target.closeTarget', { targetId }); return results; }

  // 1b. the Libraries strip is built from packs.json and its chips insert imports
  try {
    const libs = await evaluate(cdp, sessionId, `(async () => {
      const t0 = Date.now();
      while (document.getElementById('libs').hidden) { if (Date.now() - t0 > 15000) return { chips: 0 }; await new Promise(r => setTimeout(r, 100)); }
      const chips = [...document.querySelectorAll('#libsChips .lib-chip')];
      const ssr = chips.find((c) => c.title.indexOf('all_ssreflect') >= 0);
      let inserted = false;
      if (ssr) { const before = document.getElementById('challengeSrc').value; ssr.click(); inserted = document.getElementById('challengeSrc').value.startsWith(ssr.title) && document.getElementById('solutionSrc').value.startsWith(ssr.title); document.getElementById('challengeSrc').value = before; document.getElementById('solutionSrc').value = document.getElementById('solutionSrc').value.replace(ssr.title + String.fromCharCode(10), ''); }
      return { chips: chips.length, labels: chips.map((c) => c.textContent).join(', '), inserted };
    })()`, 20000);
    ok('libraries strip lists the shipped packs with sizes', libs.chips > 0 && (!HAS_MATHCOMP || /mathcomp/.test(libs.labels))
       && (!HAS_COQUELICOT || /Coquelicot/.test(libs.labels)) && (!HAS_EQUATIONS || /Equations/.test(libs.labels)), libs.labels);
    if (HAS_MATHCOMP) ok('clicking a library chip inserts its import into both editors', libs.inserted === true);
  } catch (e) { ok('libraries strip lists the shipped packs with sizes', false, e.message); }

  // 2. the page's own default example, via the real Run button
  let uiVerdict = null, uiErr = null;
  try {
    uiVerdict = await evaluate(cdp, sessionId, `(async () => {
      const rc = window.RocqComparator, orig = rc.check;
      rc.check = (r) => orig(r).then((v) => { window.__lastVerdict = v; return v; });
      document.getElementById('runBtn').click();
      const t0 = Date.now();
      while (!window.__lastVerdict) { if (Date.now() - t0 > ${CHECK_MS}) throw new Error('no verdict after Run'); await new Promise(r => setTimeout(r, 100)); }
      const shown = !document.getElementById('verdictBody').hidden;
      rc.check = orig;
      return { verdict: JSON.parse(window.__lastVerdict), shown };
    })()`, CHECK_MS + 5000);
  } catch (e) { uiErr = e.message; }
  ok('default example accepted via the Run button',
     !uiErr && uiVerdict.verdict.ok === true && uiVerdict.shown,
     uiErr || ('ok=' + uiVerdict.verdict.ok + ' reason=' + uiVerdict.verdict.reason + ' shown=' + uiVerdict.shown));

  // 2b. a check that outruns the page's timeout: a deliberately slow proof with
  // a 3 s timeout is stopped by the hard cap (timeout + 5 s) with the specific
  // message; the worker is respawned, which the checks below then use.
  const SLOW_CH = 'Lemma slow : True.\nProof. Admitted.\n';
  const SLOW_SOL = 'Lemma slow : True.\nProof. do 500000000 idtac. exact I. Qed.\n';
  try {
    const r = await evaluate(cdp, sessionId, `(async () => {
      const ch = document.getElementById('challengeSrc'), sol = document.getElementById('solutionSrc'), to = document.getElementById('timeoutS');
      const saved = [ch.value, sol.value, to.value];
      ch.value = ${JSON.stringify(SLOW_CH)}; sol.value = ${JSON.stringify(SLOW_SOL)}; to.value = '3';
      const body = document.getElementById('verdictBody'); body.hidden = true; body.innerHTML = '';
      const t0 = Date.now();
      document.getElementById('runBtn').click();
      while (body.hidden) { if (Date.now() - t0 > 60000) throw new Error('no verdict after Run'); await new Promise(r => setTimeout(r, 100)); }
      ch.value = saved[0]; sol.value = saved[1]; to.value = saved[2];
      const q = (s) => (body.querySelector(s) || {}).textContent || '';
      return { ms: Date.now() - t0, defaultTimeout: saved[2], title: q('.banner .title'), sub: q('.banner .sub') };
    })()`, 70000);
    ok('the page defaults to a ' + PAGE_TIMEOUT_S + ' s timeout', r.defaultTimeout === String(PAGE_TIMEOUT_S), 'timeoutS=' + r.defaultTimeout);
    ok('a check longer than the timeout is stopped with the timeout message (' + r.ms + ' ms)',
       /past the page's timeout \(3 s\)/.test(r.sub) && /Advanced options/.test(r.sub) && r.ms < 30000, r.title + ': ' + r.sub);
  } catch (e) { ok('a check longer than the timeout is stopped with the timeout message', false, e.message); }

  // 3. through the public API
  const call = (req) => evaluate(cdp, sessionId, `window.RocqComparator.check(${JSON.stringify(req)}).then(JSON.parse)`, CHECK_MS);
  let v;
  try { v = await call(request('sq', Z_CH, Z_SOL)); ok('Stdlib ZArith + ring accepted', v.ok === true, 'ok=' + v.ok + ' reason=' + v.reason + (v.detail ? ' ' + String(v.detail).slice(0, 160) : '')); }
  catch (e) { ok('Stdlib ZArith + ring accepted', false, e.message); }
  okLocal('lazy: the Stdlib pack was fetched by that import, mathcomp still not', servedUnder(log, 'Stdlib') > 0 && servedUnder(log, 'mathcomp') === 0,
     'Stdlib=' + servedUnder(log, 'Stdlib') + ' mathcomp=' + servedUnder(log, 'mathcomp'));
  if (HAS_MATHCOMP) {
    try {
      // this call also exercises the progress callback (download events, then check)
      const r = await evaluate(cdp, sessionId, `(async () => { const ev = []; const v = JSON.parse(await window.RocqComparator.check(${JSON.stringify(request('foo', M_CH, M_SOL))}, (p) => ev.push(p))); return { v, ev }; })()`, CHECK_MS);
      v = r.v;
      const dl = r.ev.filter((e) => e.stage === 'download'), last = dl[dl.length - 1];
      ok('progress: byte-accurate download events during the mathcomp fetch',
         dl.length > 0 && last.bytesTotal > 0 && last.bytes === last.bytesTotal && last.packsDone === last.packsTotal,
         dl.length + ' events, ' + (last ? last.packsTotal + ' packs, ' + last.bytes + '/' + last.bytesTotal + ' bytes' : 'none'));
      ok('progress: a check-stage event follows the download', r.ev.some((e) => e.stage === 'check'));
      ok('mathcomp: ssreflect proof accepted against the trusted .vos library', v.ok === true,
         'ok=' + v.ok + ' reason=' + v.reason + (v.detail ? ' ' + String(v.detail).replace(/\n/g, ' ').slice(0, 200) : '') +
         (v.targets && v.targets[0] ? ' assumptions=' + JSON.stringify(v.targets[0].assumptions).slice(0, 120) : ''));
    } catch (e) { ok('mathcomp: ssreflect proof accepted against the trusted .vos library', false, e.message); }
    okLocal('lazy: mathcomp packs fetched only by that import', servedUnder(log, 'mathcomp') > 0, 'mathcomp files=' + servedUnder(log, 'mathcomp'));
    try { v = await call(request('foo', M_CH, M_CH)); ok('mathcomp: Admitted ssreflect solution rejected as not_proved', v.ok === false && v.reason === 'not_proved', 'reason=' + v.reason); }
    catch (e) { ok('mathcomp: Admitted ssreflect solution rejected as not_proved', false, e.message); }
    if (HAS_ANALYSIS) {
      const t0 = Date.now();
      try {
        v = await call(request('foo', A_CH, A_SOL));
        ok('mathcomp-analysis: expR0 proof accepted (first analysis check ' + (Date.now() - t0) + ' ms)', v.ok === true,
           'ok=' + v.ok + ' reason=' + v.reason + (v.detail ? ' ' + String(v.detail).replace(/\n/g, ' ').slice(0, 200) : ''));
      } catch (e) { ok('mathcomp-analysis: expR0 proof accepted', false, e.message); }
      okLocal('lazy: analysis, algebra and micromega_plugin files fetched only by that import',
         servedUnder(log, 'mathcomp/analysis') > 0 && servedUnder(log, 'mathcomp/algebra') > 0 && servedUnder(log, 'micromega_plugin') > 0,
         'analysis=' + servedUnder(log, 'mathcomp/analysis') + ' algebra=' + servedUnder(log, 'mathcomp/algebra') + ' micromega_plugin=' + servedUnder(log, 'micromega_plugin'));
      try { v = await call(request('foo', A_CH, A_CH)); ok('mathcomp-analysis: Admitted solution rejected as not_proved', v.ok === false && v.reason === 'not_proved', 'reason=' + v.reason); }
      catch (e) { ok('mathcomp-analysis: Admitted solution rejected as not_proved', false, e.message); }
    }
  } else {
    console.log('skip mathcomp cases: no mathcomp packs in ' + path.join(DIST, 'coqlib', 'packs.json'));
  }
  // Coquelicot (Stdlib.ssr + mathcomp boot + Reals) and Equations (its plugin, linked): one proof each
  if (HAS_COQUELICOT) {
    try { v = await call(request('foo', C_CH, C_SOL)); ok('coquelicot: auto_derive proof accepted against the trusted .vos library', v.ok === true, 'ok=' + v.ok + ' reason=' + v.reason + (v.detail ? ' ' + String(v.detail).replace(/\n/g, ' ').slice(0, 200) : '')); }
    catch (e) { ok('coquelicot: auto_derive proof accepted against the trusted .vos library', false, e.message); }
    okLocal('lazy: the Coquelicot pack, Stdlib ssr and mathcomp boot fetched only by that import',
       servedUnder(log, 'Coquelicot') > 0 && servedUnder(log, 'Stdlib/ssr') > 0 && servedUnder(log, 'mathcomp/boot') > 0 && servedUnder(log, 'Equations') === 0,
       'Coquelicot=' + servedUnder(log, 'Coquelicot') + ' Stdlib/ssr=' + servedUnder(log, 'Stdlib/ssr') + ' mathcomp/boot=' + servedUnder(log, 'mathcomp/boot'));
    try { v = await call(request('foo', C_CH, C_CH)); ok('coquelicot: Admitted solution rejected as not_proved', v.ok === false && v.reason === 'not_proved', 'reason=' + v.reason); }
    catch (e) { ok('coquelicot: Admitted solution rejected as not_proved', false, e.message); }
  }
  if (HAS_EQUATIONS) {
    try { v = await call(request('foo', E_CH, E_SOL)); ok('equations: funelim proof accepted against the trusted .vos library', v.ok === true, 'ok=' + v.ok + ' reason=' + v.reason + (v.detail ? ' ' + String(v.detail).replace(/\n/g, ' ').slice(0, 200) : '')); }
    catch (e) { ok('equations: funelim proof accepted against the trusted .vos library', false, e.message); }
    okLocal('lazy: the Equations pack fetched only by that import', servedUnder(log, 'Equations') > 0, 'Equations files=' + servedUnder(log, 'Equations'));
    try { v = await call(request('foo', E_CH, E_CH)); ok('equations: Admitted solution rejected as not_proved', v.ok === false && v.reason === 'not_proved', 'reason=' + v.reason); }
    catch (e) { ok('equations: Admitted solution rejected as not_proved', false, e.message); }
  }
  try { v = await call(request('add_0_r', N_CH, N_CH)); ok('Admitted solution rejected as not_proved', v.ok === false && v.reason === 'not_proved', 'reason=' + v.reason); }
  catch (e) { ok('Admitted solution rejected as not_proved', false, e.message); }
  try { v = await call(request('add_0_r', N_CH, N_BAD)); ok('wrong statement rejected as statement_mismatch', v.ok === false && v.reason === 'statement_mismatch', 'reason=' + v.reason); }
  catch (e) { ok('wrong statement rejected as statement_mismatch', false, e.message); }

  await cdp.send('Target.closeTarget', { targetId });
  return results;
}

// The unsupported-browser path: with WebAssembly.validate answering no, the
// loader must spawn no worker, the page must name the missing extensions and
// the demo verdicts must still work.
async function unsupportedPass(cdp, origin) {
  const results = [];
  const ok = (name, cond, note) => { results.push({ name, cond: !!cond, note }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (note ? '  ' + note : '')); };
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  let workers = 0;
  cdp.on((m) => { if (m.method === 'Target.attachedToTarget' && m.sessionId === sessionId && m.params.targetInfo.type === 'worker') workers++; });
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: 'WebAssembly.validate = () => false;' }, sessionId);
  await cdp.send('Page.navigate', { url: origin + '/' }, sessionId);
  const r = await evaluate(cdp, sessionId, `(async () => {
    const t0 = Date.now();
    let n;
    while (!(n = document.getElementById('unavailableNotice')) || n.hidden) { if (Date.now() - t0 > 15000) throw new Error('the unavailable notice never showed'); await new Promise(r => setTimeout(r, 50)); }
    document.getElementById('loadDemoOk').click();
    const q = (s) => (document.querySelector(s) || {}).textContent || '';
    return { support: window.RocqComparator.support, detail: q('#unavailableDetail'), status: q('#backendStatusText'), runDisabled: document.getElementById('runBtn').disabled, demo: q('#verdictBody .banner .title') };
  })()`, 20000).catch((e) => ({ error: e.message }));
  await new Promise((res) => setTimeout(res, 500)); // a spawned worker would have attached by now
  ok('unsupported browser: the missing extensions are named', /lacks WebAssembly GC, tail calls and exception handling/.test(r.detail) && /Safari 18\.2\+/.test(r.detail), r.error || r.detail);
  ok('unsupported browser: no worker spawned, Run disabled', workers === 0 && r.runDisabled === true && r.status === 'Browser not supported', 'workers=' + workers + ' status=' + r.status);
  ok('unsupported browser: the demo verdict still renders', r.demo === 'Proved', r.demo);
  await cdp.send('Target.closeTarget', { targetId });
  return results;
}

(async () => {
  if (!REMOTE && !fs.existsSync(path.join(DIST, 'index.html'))) { console.error('no dist/index.html at ' + DIST + ' (run make site)'); process.exit(2); }
  const exe = findBrowser();
  if (!exe) { console.error('no Chromium-family browser found (set BROWSER=/path/to/chrome); skipping browser smoke test'); process.exit(3); }
  await loadSiteData();
  if (!HEAVY) console.log('SMOKE_HEAVY=0: the mathcomp-analysis case is skipped');
  const log = { served: [], notFound: [], blocked: [], block: null };
  const local = REMOTE ? null : await serve(DIST, log);
  const origin = REMOTE || ('http://127.0.0.1:' + local.port);
  const browser = launchBrowser(exe);
  let failed = 0;
  try {
    const cdp = await CDP.connect(await browser.wsUrl);
    console.log('browser: ' + exe + '\n' + (REMOTE ? 'site: ' + origin : 'serving: ' + DIST + ' at ' + origin));
    const TITLES = { auto: '1: as shipped (JSPI upgrade if the browser has it)', cps: '2: /?engine=cps (the cps engine, no JSPI)', fallback: '3: JSPI module blocked (fallback to the cps engine)', packfail: '4: a library pack blocked (download failure is reported)' };
    for (const variant of REMOTE ? ['auto', 'cps'] : ['auto', 'cps', 'fallback', ...(HAS_COQUELICOT ? ['packfail'] : [])]) {
      console.log('\n== pass ' + TITLES[variant] + ' ==');
      const res = await runPass(cdp, origin, variant, log);
      failed += res.filter((r) => !r.cond).length;
    }
    console.log('\n== unsupported browser (WebAssembly.validate stubbed out) ==');
    failed += (await unsupportedPass(cdp, origin)).filter((r) => !r.cond).length;
  } catch (e) { console.error('smoke test error: ' + (e.stack || e.message)); failed += 1; }
  finally { browser.kill(); if (local) local.server.close(); }
  console.log('\n' + (failed ? failed + ' FAILED' : 'ALL PASSED') + ' (real browser, both engines)');
  process.exit(failed ? 1 : 0);
})();

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
//   2. clicking Run on the page's default example produces an accepted verdict;
//   3. through window.RocqComparator: a Stdlib (ZArith + ring) proof is
//      accepted, an Admitted one is rejected as not_proved, a wrong statement is
//      a statement_mismatch; when the mathcomp packs are staged, an ssreflect
//      proof against the trusted .vos library is accepted;
//   4. lazy import: no Stdlib or mathcomp file is downloaded until a source
//      imports it.
//
// It runs TWICE: once as-is (the worker upgrades to the JSPI engine when the
// browser supports it) and once on /?engine=cps, which the page forwards to the
// worker to force the universal cps engine. Both engines must pass.
//
//   node test/browser_smoke.cjs [dist]            # BROWSER=/path/to/chrome to override
//
// Exit 0 = every assertion passed in both passes; non-zero otherwise. If no
// Chromium-family browser is found the test exits 3 with a clear message.
'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const cp = require('child_process'), os = require('os');

const DIST = path.resolve(process.argv[2] || path.join(__dirname, '..', 'dist'));
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
const SAMPLE_CONFIG = JSON.parse(fs.readFileSync(path.join(DIST, 'examples', 'config.sample.json'), 'utf8'));
function request(theorem, challenge, solution) {
  return JSON.stringify({ config: Object.assign({}, SAMPLE_CONFIG, { theorem_names: [theorem], timeout_s: 240 }),
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
const PACKS = JSON.parse(fs.readFileSync(path.join(DIST, 'coqlib', 'packs.json'), 'utf8'));
const HAS_MATHCOMP = PACKS.packs.some((p) => p.name === 'mathcomp-ssreflect');
const HAS_ANALYSIS = PACKS.packs.some((p) => p.name === 'mathcomp-analysis');
const servedUnder = (log, dir) => log.served.filter((p) => p.indexOf('/coqlib/user-contrib/' + dir + '/') === 0).length;

// One pass: fresh page, optional JSPI suppression inside the worker, all assertions.
async function runPass(cdp, origin, forceCps, log) {
  const results = []; const consoleErrors = []; const workerErrors = [];
  const ok = (name, cond, note) => { results.push({ name, cond: !!cond, note }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (note ? '  ' + note : '')); };

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

  log.served.length = 0; log.notFound.length = 0;
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
  const engine = (log.served.find((p) => /engine-(cps|jspi)\/rocq_engine\.js$/.test(p)) || '').replace(/\/rocq_engine\.js$/, '').replace(/^\//, '') || '(none)';
  ok('engine loaded', engine !== '(none)', engine + (forceCps ? ' (forced by ?engine=cps)' : ' (auto)'));
  if (forceCps) ok('?engine=cps selects the universal engine', engine === 'engine-cps', engine);
  const bad404 = log.notFound.filter((p) => !/favicon\.ico$/.test(p));
  ok('no missing assets (404)', bad404.length === 0, bad404.length ? bad404.slice(0, 5).join(' ') : log.served.length + ' files served');
  ok('no page-side JS errors', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));
  ok('no worker-side JS errors', workerErrors.length === 0, workerErrors.slice(0, 2).join(' | '));
  ok('lazy: no Stdlib or mathcomp file downloaded at startup', servedUnder(log, 'Stdlib') === 0 && servedUnder(log, 'mathcomp') === 0,
     'Stdlib=' + servedUnder(log, 'Stdlib') + ' mathcomp=' + servedUnder(log, 'mathcomp'));
  if (readyErr || notice) { await cdp.send('Target.closeTarget', { targetId }); return results; }

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

  // 3. through the public API
  const call = (req) => evaluate(cdp, sessionId, `window.RocqComparator.check(${JSON.stringify(req)}).then(JSON.parse)`, CHECK_MS);
  let v;
  try { v = await call(request('sq', Z_CH, Z_SOL)); ok('Stdlib ZArith + ring accepted', v.ok === true, 'ok=' + v.ok + ' reason=' + v.reason + (v.detail ? ' ' + String(v.detail).slice(0, 160) : '')); }
  catch (e) { ok('Stdlib ZArith + ring accepted', false, e.message); }
  ok('lazy: the Stdlib pack was fetched by that import, mathcomp still not', servedUnder(log, 'Stdlib') > 0 && servedUnder(log, 'mathcomp') === 0,
     'Stdlib=' + servedUnder(log, 'Stdlib') + ' mathcomp=' + servedUnder(log, 'mathcomp'));
  if (HAS_MATHCOMP) {
    try {
      v = await call(request('foo', M_CH, M_SOL));
      ok('mathcomp: ssreflect proof accepted against the trusted .vos library', v.ok === true,
         'ok=' + v.ok + ' reason=' + v.reason + (v.detail ? ' ' + String(v.detail).replace(/\n/g, ' ').slice(0, 200) : '') +
         (v.targets && v.targets[0] ? ' assumptions=' + JSON.stringify(v.targets[0].assumptions).slice(0, 120) : ''));
    } catch (e) { ok('mathcomp: ssreflect proof accepted against the trusted .vos library', false, e.message); }
    ok('lazy: mathcomp packs fetched only by that import', servedUnder(log, 'mathcomp') > 0, 'mathcomp files=' + servedUnder(log, 'mathcomp'));
    try { v = await call(request('foo', M_CH, M_CH)); ok('mathcomp: Admitted ssreflect solution rejected as not_proved', v.ok === false && v.reason === 'not_proved', 'reason=' + v.reason); }
    catch (e) { ok('mathcomp: Admitted ssreflect solution rejected as not_proved', false, e.message); }
    if (HAS_ANALYSIS) {
      const t0 = Date.now();
      try {
        v = await call(request('foo', A_CH, A_SOL));
        ok('mathcomp-analysis: expR0 proof accepted (first analysis check ' + (Date.now() - t0) + ' ms)', v.ok === true,
           'ok=' + v.ok + ' reason=' + v.reason + (v.detail ? ' ' + String(v.detail).replace(/\n/g, ' ').slice(0, 200) : ''));
      } catch (e) { ok('mathcomp-analysis: expR0 proof accepted', false, e.message); }
      ok('lazy: analysis, algebra and micromega_plugin files fetched only by that import',
         servedUnder(log, 'mathcomp/analysis') > 0 && servedUnder(log, 'mathcomp/algebra') > 0 && servedUnder(log, 'micromega_plugin') > 0,
         'analysis=' + servedUnder(log, 'mathcomp/analysis') + ' algebra=' + servedUnder(log, 'mathcomp/algebra') + ' micromega_plugin=' + servedUnder(log, 'micromega_plugin'));
      try { v = await call(request('foo', A_CH, A_CH)); ok('mathcomp-analysis: Admitted solution rejected as not_proved', v.ok === false && v.reason === 'not_proved', 'reason=' + v.reason); }
      catch (e) { ok('mathcomp-analysis: Admitted solution rejected as not_proved', false, e.message); }
    }
  } else {
    console.log('skip mathcomp cases: no mathcomp packs in ' + path.join(DIST, 'coqlib', 'packs.json'));
  }
  try { v = await call(request('add_0_r', N_CH, N_CH)); ok('Admitted solution rejected as not_proved', v.ok === false && v.reason === 'not_proved', 'reason=' + v.reason); }
  catch (e) { ok('Admitted solution rejected as not_proved', false, e.message); }
  try { v = await call(request('add_0_r', N_CH, N_BAD)); ok('wrong statement rejected as statement_mismatch', v.ok === false && v.reason === 'statement_mismatch', 'reason=' + v.reason); }
  catch (e) { ok('wrong statement rejected as statement_mismatch', false, e.message); }

  await cdp.send('Target.closeTarget', { targetId });
  return results;
}

(async () => {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) { console.error('no dist/index.html at ' + DIST + ' (run make site)'); process.exit(2); }
  const exe = findBrowser();
  if (!exe) { console.error('no Chromium-family browser found (set BROWSER=/path/to/chrome); skipping browser smoke test'); process.exit(3); }
  const log = { served: [], notFound: [] };
  const { server, port } = await serve(DIST, log);
  const origin = 'http://127.0.0.1:' + port;
  const browser = launchBrowser(exe);
  let failed = 0;
  try {
    const cdp = await CDP.connect(await browser.wsUrl);
    console.log('browser: ' + exe + '\nserving: ' + DIST + ' at ' + origin);
    for (const forceCps of [false, true]) {
      console.log('\n== pass ' + (forceCps ? '2: /?engine=cps (universal cps engine)' : '1: as shipped (JSPI upgrade if the browser has it)') + ' ==');
      const res = await runPass(cdp, origin, forceCps, log);
      failed += res.filter((r) => !r.cond).length;
    }
  } catch (e) { console.error('smoke test error: ' + (e.stack || e.message)); failed += 1; }
  finally { browser.kill(); server.close(); }
  console.log('\n' + (failed ? failed + ' FAILED' : 'ALL PASSED') + ' (real browser, both engines)');
  process.exit(failed ? 1 : 0);
})();

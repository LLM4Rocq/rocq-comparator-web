// judge_test.cjs — exercise the REAL in-browser engine(s) end to end under node.
//
// It mounts the Corelib prelude + Stdlib-subset .vo bundle (dist/coqlib, the
// SAME files the browser worker fetches) into the engine VFS, then runs with the
// prelude (NOT -noinit): a nat + tactics proof accepts, an admitted one is
// rejected, ZArith+ring and Reals+lra proofs accept, plus the axiom/statement
// checks. Proof that the full rocq-comparator kernel pipeline runs client-side.
//
// TWO ENGINES, ONE SUITE. dist ships engine-cps/ (universal) and engine-jspi/
// (JSPI upgrade). With no --engine, this file is an ORCHESTRATOR: it finds both
// engines under the given dist dir and spawns one child (worker mode) per engine
// so each gets a clean process (RocqComparator + its VFS are per-process
// singletons). Each engine must pass 12/12.
//
//   node test/judge_test.cjs [dist]                 # both engines, 12/12 each
//   node test/judge_test.cjs --engine dist/engine-cps/rocq_engine.js
//
// THE BROWSER FETCH BUG (guarded here). The engine's mount() consumes a
// byte-exact string (char code i === byte i). The browser worker builds that
// string with web/rocq_bytes.js (String.fromCharCode over the fetched bytes) —
// NOT `new TextDecoder('latin1')`, whose WHATWG "latin1" is windows-1252 and
// remaps bytes 0x80-0x9F, corrupting a .vo size field into the
// Invalid_argument("Bytes.create") anomaly seen in real browsers on Prelude.vo.
// This harness feeds the .vo/META through the EXACT SAME rocq_bytes.js
// conversion the worker uses (below), so a broken conversion fails here too —
// the corruption class is caught headlessly. Set ROCQ_DECODE=browser to force
// the pre-fix windows-1252 decode instead: the prelude/stdlib checks then FAIL
// (reproducing the browser bug in node), which is the "fails before the fix"
// regression. (Node's own TextDecoder happens to decode that range byte-for-byte,
// which is exactly why the old node test passed while every browser broke — so
// we never use TextDecoder in the guard; we replicate the browser's behavior
// explicitly with the windows-1252 table below.)
'use strict';
const path = require('path'), os = require('os'), fs = require('fs'), cp = require('child_process');

// The single source of truth for the byte-exact conversion — the same module the
// browser worker loads (web/rocq_bytes.js, shipped to dist/rocq_bytes.js).
const RocqBytes = require(path.join(__dirname, '..', 'web', 'rocq_bytes.js'));
// The shared lazy-import scanner/resolver — the SAME module the worker loads, so
// this harness exercises the same scan->resolve->fetch->mount path (Phase 2).
const RocqPacks = require(path.join(__dirname, '..', 'web', 'rocq_packs.js'));

// WHATWG windows-1252 index for 0x80-0x9F: what a REAL browser's
// TextDecoder('latin1') produces (0x81,0x8D,0x8F,0x90,0x9D decode to themselves).
const W1252 = {0x80:0x20AC,0x82:0x201A,0x83:0x0192,0x84:0x201E,0x85:0x2026,0x86:0x2020,0x87:0x2021,0x88:0x02C6,0x89:0x2030,0x8A:0x0160,0x8B:0x2039,0x8C:0x0152,0x8E:0x017D,0x91:0x2018,0x92:0x2019,0x93:0x201C,0x94:0x201D,0x95:0x2022,0x96:0x2013,0x97:0x2014,0x98:0x02DC,0x99:0x2122,0x9A:0x0161,0x9B:0x203A,0x9C:0x0153,0x9E:0x017E,0x9F:0x0178};
function browserLatin1Decode(u8) {
  let s = "";
  for (const b of u8) s += String.fromCharCode((b >= 0x80 && b <= 0x9f && W1252[b] !== undefined) ? W1252[b] : b);
  return s;
}

const DECODE = process.env.ROCQ_DECODE === 'browser' ? 'browser' : 'byteexact';
// The conversion this run feeds to mount(): byteexact (the fix, shared with the
// worker) or browser (the pre-fix windows-1252 decode, for the regression).
const convert = DECODE === 'browser'
  ? browserLatin1Decode
  : (u8) => RocqBytes.bytesToBinaryString(u8);

// -------- dispatch: orchestrator (no --engine) vs single-engine worker --------
const ei = process.argv.indexOf('--engine');
if (ei === -1) orchestrate();
else worker(path.resolve(process.argv[ei + 1]));

function findEngines(distRoot) {
  return ['engine-cps', 'engine-jspi']
    .map(d => path.join(distRoot, d, 'rocq_engine.js'))
    .filter(p => fs.existsSync(p));
}

function orchestrate() {
  // optional positional dist dir; also accept a direct engine glue path
  // (…/rocq_engine.js) and run just that one.
  let arg = process.argv[2];
  if (arg && arg.endsWith('rocq_engine.js') && fs.existsSync(arg)) {
    const r = cp.spawnSync(process.execPath, [__filename, '--engine', path.resolve(arg)], { stdio: 'inherit', env: process.env });
    process.exit(r.status === null ? 2 : r.status);
  }
  const distRoot = path.resolve(arg || path.join(__dirname, '..', 'dist'));
  const engines = findEngines(distRoot);
  if (!engines.length) {
    console.log('no engines found under ' + distRoot + ' (expected engine-cps/ and/or engine-jspi/) — run `make real`.');
    process.exit(2);
  }
  console.log('decode mode: ' + DECODE + (DECODE === 'browser' ? '  (pre-fix browser windows-1252: EXPECTED TO FAIL)' : '  (byte-exact, shared with the worker)'));
  let anyFail = false;
  for (const eng of engines) {
    const name = path.basename(path.dirname(eng));
    console.log('\n===================== ' + name + ' =====================');
    const r = cp.spawnSync(process.execPath, [__filename, '--engine', eng], { stdio: 'inherit', env: process.env });
    if (r.status !== 0) anyFail = true;
  }
  console.log('\n' + (anyFail ? 'SOME ENGINE FAILED' : 'ALL ENGINES PASSED'));
  process.exit(anyFail ? 1 : 0);
}

function worker(enginePath) {
  global.window = global;
  const engineDir = path.dirname(enginePath);              // …/dist/engine-<eff>
  const distRoot = path.dirname(engineDir);                // …/dist
  const effDir = path.basename(engineDir);                 // engine-cps | engine-jspi
  const coqlibDir = path.join(distRoot, 'coqlib');
  const isWasm = fs.existsSync(path.join(engineDir, 'rocq_engine.assets'));

  // ---- byte-exact guard (hard preflight; keeps the functional count at 12) ----
  // The mount conversion MUST map byte i -> char code i for all 0-255. A UTF-8 /
  // text-based decode would change bytes or length and fail here.
  (function assertByteExact() {
    const all = new Uint8Array(256); for (let i = 0; i < 256; i++) all[i] = i;
    const s = RocqBytes.bytesToBinaryString(all);
    if (s.length !== 256) throw new Error('rocq_bytes: length ' + s.length + ' != 256 (not byte-exact)');
    for (let i = 0; i < 256; i++) if (s.charCodeAt(i) !== i) throw new Error('rocq_bytes: byte ' + i + ' -> code ' + s.charCodeAt(i) + ' (not byte-exact)');
    // And prove the fix is load-bearing: the real Prelude.vo differs under the
    // browser windows-1252 decode (i.e. it holds 0x80-0x9F bytes that broke it).
    const prelude = path.join(coqlibDir, 'theories/Init/Prelude.vo');
    if (fs.existsSync(prelude)) {
      const u8 = new Uint8Array(fs.readFileSync(prelude));
      if (browserLatin1Decode(u8) === RocqBytes.bytesToBinaryString(u8))
        console.log('   note: Prelude.vo has no 0x80-0x9F bytes (guard still valid)');
    }
    console.log('GUARD: mount conversion byte-exact for all 256 values (no TextDecoder)  [decode=' + DECODE + ']');
  })();

  if (isWasm) {
    // (1) rocq_zarith.js must install globalThis.__rocqz BEFORE the engine wasm
    //     instantiates; (2) the glue resolves its .wasm at `<src>/code-*.wasm`
    //     relative to require.main.filename's dir (this file's dir), and src is
    //     patched to "engine-<eff>/rocq_engine.assets" — mirror that with a
    //     symlink; (3) RocqComparator installs asynchronously.
    require(path.join(distRoot, 'rocq_zarith.js'));
    const linkDir = path.join(__dirname, effDir, 'rocq_engine.assets');
    try {
      fs.mkdirSync(path.dirname(linkDir), { recursive: true });
      try { fs.unlinkSync(linkDir); } catch (_) {}
      fs.symlinkSync(path.join(engineDir, 'rocq_engine.assets'), linkDir);
      process.on('exit', function () { try { fs.unlinkSync(linkDir); fs.rmdirSync(path.dirname(linkDir)); } catch (_) {} });
    } catch (_) {}
  }
  try { process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'rcweb-'))); } catch (_) {}
  require(enginePath);

  // RocqComparator installs after async wasm instantiation — poll until present.
  function awaitEngine(timeoutMs) {
    return new Promise(function (resolve, reject) {
      const t0 = Date.now();
      (function poll() {
        if (global.RocqComparator && typeof global.RocqComparator.check === 'function') return resolve(global.RocqComparator);
        if (Date.now() - t0 > timeoutMs) return reject(new Error('engine did not install RocqComparator'));
        setTimeout(poll, 20);
      })();
    });
  }
  let rc = global.RocqComparator;

  let pass = 0, fail = 0;
  function ok(name, cond, extra) { (cond ? pass++ : fail++); console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); }

  // Mount the coqlib bundle the way rocq_worker.js does, but reading files from
  // disk instead of fetch(). Bytes go through `convert` — the SAME rocq_bytes.js
  // path the worker uses (or the browser windows-1252 sim under ROCQ_DECODE=browser).
  // ---- Phase 2 lazy packs (packs.json), else legacy single bundle (manifest.json) ----
  let manifest = null; const mountedPacks = {}; let mountedCount = 0;
  function mountPack(pk) {
    if (mountedPacks[pk.name]) return 0;
    if (pk.meta) rc.mount(pk.meta_vfs, convert(new Uint8Array(fs.readFileSync(path.join(coqlibDir, pk.meta)))));
    const vfs = manifest.coqlib_vfs || '/static/coqlib';
    for (const rel of (pk.vo || [])) {
      // a served .vos is mounted at a .vo VFS path (the worker does the same)
      const vfsPath = vfs + '/' + rel.replace(/\.vos$/, '.vo');
      rc.mount(vfsPath, convert(new Uint8Array(fs.readFileSync(path.join(coqlibDir, rel)))));
    }
    mountedPacks[pk.name] = true; mountedCount += (pk.vo || []).length;
    return (pk.vo || []).length;
  }
  // Predeclare every pack's dirs (0-byte .keep) so the recursive coqlib loadpath
  // (built once at the first check) binds every pack's logical name; the .vo stay lazy.
  function predeclareDirs() {
    if (!manifest || !manifest.packs) return;
    const vfs = manifest.coqlib_vfs || '/static/coqlib';
    const dirs = {};
    manifest.packs.forEach(p => (p.vo || []).forEach(rel => {
      const vfsPath = vfs + '/' + rel.replace(/\.vos$/, '.vo');
      dirs[vfsPath.slice(0, vfsPath.lastIndexOf('/'))] = true;
    }));
    Object.keys(dirs).forEach(d => { try { rc.mount(d + '/.keep', ''); } catch (e) {} });
  }
  // Mount the always-on packs (Corelib); returns #objects mounted at startup.
  function mountBundle() {
    const packsPath = path.join(coqlibDir, 'packs.json');
    if (fs.existsSync(packsPath)) {
      manifest = JSON.parse(fs.readFileSync(packsPath, 'utf8'));
      predeclareDirs();
      (manifest.packs || []).filter(p => p.always).forEach(mountPack);
      return mountedCount;
    }
    // legacy fallback: manifest.json = one bundle mounted up front
    const manifestPath = path.join(coqlibDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) return 0;
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest = { coqlib_vfs: m.coqlib_vfs || '/static/coqlib', packs: [] };
    if (m.meta) rc.mount(m.meta_vfs || '/static/lib/rocq-runtime/META', convert(new Uint8Array(fs.readFileSync(path.join(coqlibDir, m.meta)))));
    const vfs = manifest.coqlib_vfs;
    for (const rel of (m.vo || [])) rc.mount(vfs + '/' + rel, convert(new Uint8Array(fs.readFileSync(path.join(coqlibDir, rel)))));
    return (m.vo || []).length;
  }
  // Lazily fetch+mount the packs these sources import (scan->resolve->mount), cached.
  function ensurePacks(sources) {
    if (!manifest || !manifest.packs || !manifest.packs.length) return [];
    const names = RocqPacks.resolvePacks(manifest, RocqPacks.scanRequires(sources));
    const fetched = [];
    for (const name of names) {
      const pk = manifest.packs.find(p => p.name === name);
      if (pk && !mountedPacks[pk.name]) { mountPack(pk); fetched.push(pk.name); }
    }
    return fetched;
  }

  const base = {
    challenge: "challenge.v", solution: "solution.v",
    theorem_names: [], definition_names: ["foo"], permitted_axioms: [],
    loadpath: [], coqproject: null, top: null, timeout_s: 60,
    sandbox: "none", rocqchk: false, vm: false,
    impredicative_set: false, indices_matter: false, noinit: false,
    permitted_plugins: [], permitted_libraries: [], permit_challenge_axioms: true
  };
  const CH = "Definition foo : forall (A : Prop) (_ : A), A := fun A a => a.\n";
  const CHEAT = "Axiom cheat : forall (A : Prop) (_ : A), A.\nDefinition foo : forall (A : Prop) (_ : A), A := cheat.\n";

  async function check(cfg, ch, sol) {
    ensurePacks([ch, sol]);   // Phase 2: fetch+mount only the packs these sources import
    const req = { config: Object.assign({}, base, cfg), files: { "challenge.v": ch, "solution.v": sol } };
    return JSON.parse(await rc.check(JSON.stringify(req)));
  }

  (async () => {
    rc = await awaitEngine(60000);
    await rc.ready;
    ok("engine reports a Rocq version", typeof rc.version === 'string' && rc.version.length > 0, "version=" + rc.version);

    const nvo = mountBundle();
    ok("prelude (always) pack mounted", nvo > 0, "vo=" + nvo + " (Stdlib/mathcomp fetched lazily on Require)");

    // --- nat + tactics proof (needs the prelude: nat, +, =, induction, rewrite) ---
    const NATCH  = "Theorem foo : forall n : nat, n + 0 = n. Proof. Admitted.\n";
    const NATSOL = "Theorem foo : forall n : nat, n + 0 = n.\nProof. induction n as [|n IH]; simpl; [reflexivity | rewrite IH; reflexivity]. Qed.\n";
    let v = await check({ theorem_names: ["foo"], definition_names: [] }, NATCH, NATSOL);
    ok("nat+tactics proof accepted (prelude)", v.ok === true && v.targets[0].status === "proved", "reason=" + v.reason);
    v = await check({ theorem_names: ["foo"], definition_names: [] }, NATCH, NATCH);
    ok("admitted solution rejected (not_proved)", v.ok === false && v.reason === "not_proved");

    // --- Stdlib (Milestone 2): ZArith + ring, and Reals + lra ---
    const ZCH  = "From Stdlib Require Import ZArith. Open Scope Z_scope.\nTheorem foo : forall a b : Z, (a+b)*(a+b) = a*a + 2*a*b + b*b. Proof. Admitted.\n";
    const ZSOL = "From Stdlib Require Import ZArith. Open Scope Z_scope.\nTheorem foo : forall a b : Z, (a+b)*(a+b) = a*a + 2*a*b + b*b. Proof. intros; ring. Qed.\n";
    v = await check({ theorem_names: ["foo"], definition_names: [] }, ZCH, ZSOL);
    ok("Stdlib ZArith + ring proof accepted", v.ok === true && v.targets[0].status === "proved", "reason=" + v.reason);
    const RCH  = "From Stdlib Require Import Reals Lra. Open Scope R_scope.\nTheorem foo : forall x y : R, x <= y -> x - 1 <= y. Proof. Admitted.\n";
    const RSOL = "From Stdlib Require Import Reals Lra. Open Scope R_scope.\nTheorem foo : forall x y : R, x <= y -> x - 1 <= y. Proof. intros; lra. Qed.\n";
    v = await check({ theorem_names: ["foo"], definition_names: [] }, RCH, RSOL);
    ok("Stdlib Reals + lra proof accepted", v.ok === true && v.targets[0].status === "proved", "reason=" + v.reason);

    // --- axiom / statement checks (Prop-only; work with or without prelude) ---
    v = await check({}, CH, CH);
    ok("honest proof accepted", v.ok === true && v.targets[0].status === "proved");
    ok("all checks ran (rocqchk skipped)", v.checks.filter === "ok" && v.checks.statements === "ok" && v.checks.axioms === "ok" && v.checks.rocqchk === "skipped");

    v = await check({}, CH, CHEAT);
    ok("forbidden axiom rejected", v.ok === false && v.reason === "forbidden_axiom");

    v = await check({ permitted_axioms: ["challenge.cheat"] }, CH, CHEAT);
    ok("permitted axiom accepted + reported", v.ok === true && v.targets[0].assumptions.indexOf("challenge.cheat") >= 0);

    v = await check({}, CH, "Definition foo : forall (A : Prop) (B : Prop) (_ : A), A := fun A B a => a.\n");
    ok("statement mismatch rejected", v.ok === false && v.reason === "statement_mismatch" && v.targets[0].status === "mismatch");

    // malformed request -> out-of-band rejection
    let oob = false;
    try { await rc.check("{ not json"); } catch (e) { oob = true; }
    ok("malformed request rejects out-of-band", oob);

    // --- Phase 2: lazy per-pack import ---------------------------------------
    if (manifest && manifest.packs && manifest.packs.length > 1) {
      // laziness: a pack the sources never imported must NOT be mounted. The nat
      // and Prop checks above never import mathcomp, so no mathcomp pack loaded.
      const mcLoaded = Object.keys(mountedPacks).filter(n => n.indexOf("mathcomp") === 0);
      ok("lazy: no mathcomp pack fetched by non-mathcomp checks", mcLoaded.length === 0, "loaded=[" + mcLoaded.join(",") + "]");
      // resolver unit test on a representative mathcomp manifest (self-contained,
      // so it holds whether or not the mathcomp .vos are staged into this dist)
      const MCM = { coqlib_vfs: "/static/coqlib", packs: [
        { name:"corelib", always:true, prefixes:["Corelib"], vo:[] },
        { name:"stdlib", prefixes:["Stdlib"], vo:["user-contrib/Stdlib/ZArith/ZArith.vo"] },
        { name:"mathcomp-hb", prefixes:["HB","elpi","elpi_elpi"], vo:["user-contrib/HB/structures.vos"] },
        { name:"mathcomp-boot", prefixes:["mathcomp.boot"], requires:["mathcomp-hb"], vo:["user-contrib/mathcomp/boot/seq.vos"] },
        { name:"mathcomp-order", prefixes:["mathcomp.order"], requires:["mathcomp-hb","mathcomp-boot"], vo:["user-contrib/mathcomp/order/order.vos"] },
        { name:"mathcomp-ssreflect", prefixes:["mathcomp.ssreflect"], requires:["mathcomp-hb","mathcomp-boot","mathcomp-order"], vo:["user-contrib/mathcomp/ssreflect/all_ssreflect.vos"] } ] };
      const resolved = RocqPacks.resolvePacks(MCM, RocqPacks.scanRequires(["From mathcomp Require Import all_ssreflect."]));
      ok("lazy: resolver maps all_ssreflect -> hb+boot+order+ssreflect",
         ["mathcomp-hb","mathcomp-boot","mathcomp-order","mathcomp-ssreflect"].every(n => resolved.indexOf(n) >= 0),
         "resolved=[" + resolved.join(",") + "]");
      const rStd = RocqPacks.resolvePacks(MCM, RocqPacks.scanRequires(["From Stdlib Require Import ZArith."]));
      ok("lazy: resolver maps Stdlib -> stdlib pack only", rStd.length === 1 && rStd[0] === "stdlib", "resolved=[" + rStd.join(",") + "]");

      // --- mathcomp end-to-end DIAGNOSTIC (not a pass/fail assertion) --------
      // Fetch+mount the mathcomp packs all_ssreflect needs, then run a real proof
      // (an Admitted seq lemma proved with a mathcomp lemma). The lazy fetch and
      // the .vos mount are exercised here; the verdict is REPORTED (see BACKEND
      // §16 for the in-browser mathcomp status).
      if (process.env.ROCQ_MATHCOMP === '1' && manifest.packs.some(p => p.name === "mathcomp-boot")) {
        const MCH = "From mathcomp Require Import all_ssreflect.\nLemma foo (s : seq nat) : size (rev s) = size s.\nProof. Admitted.\n";
        const MSOL = "From mathcomp Require Import all_ssreflect.\nLemma foo (s : seq nat) : size (rev s) = size s.\nProof. exact: size_rev. Qed.\n";
        const fetched = ensurePacks([MCH, MSOL]);
        console.log("MATHCOMP: lazy-fetched packs = [" + fetched.join(", ") + "]");
        try {
          const mv = JSON.parse(await rc.check(JSON.stringify({ config: Object.assign({}, base, { theorem_names: ["foo"], definition_names: [] }), files: { "challenge.v": MCH, "solution.v": MSOL } })));
          console.log("MATHCOMP: verdict ok=" + mv.ok + " reason=" + (mv.reason || "-") + (mv.detail ? "  detail=" + String(mv.detail).replace(/\n/g," ").slice(0,160) : ""));
        } catch (e) { console.log("MATHCOMP: check threw " + (e && e.message || e)); }
      }
    }

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  })().catch(e => { console.log("HARNESS ERROR:", e && e.message || e); process.exit(2); });
}

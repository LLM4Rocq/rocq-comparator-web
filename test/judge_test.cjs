// judge_test.cjs — exercise the REAL in-browser engine (dist/rocq_engine.js)
// end to end under node: it mounts the Corelib prelude .vo bundle (dist/coqlib,
// same files the browser worker fetches) into the engine VFS, then runs with
// the prelude (NOT -noinit): a nat + tactics proof accepts, an admitted one is
// rejected, plus the axiom/statement checks. Proof that the full
// rocq-comparator kernel pipeline runs client-side (js_of_ocaml) WITH stdlib.
//
//   node test/judge_test.cjs dist/rocq_engine.js
global.window = global;
const path = require('path'), os = require('os'), fs = require('fs');
const enginePath = path.resolve(process.argv[2] || path.join(__dirname, '..', 'dist', 'rocq_engine.js'));
const distDir = path.dirname(enginePath);
try { process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'rcweb-'))); } catch (_) {}
require(enginePath);
const rc = global.RocqComparator;

let pass = 0, fail = 0;
function ok(name, cond, extra) { (cond ? pass++ : fail++); console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); }

// Mount the coqlib bundle the same way rocq_worker.js does, but reading files
// from disk instead of fetch(). Returns the number of .vo mounted.
function mountBundle() {
  const coqlibDir = path.join(distDir, 'coqlib');
  const manifestPath = path.join(coqlibDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return 0;
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (m.meta) rc.mount(m.meta_vfs || '/static/lib/rocq-runtime/META',
                       fs.readFileSync(path.join(coqlibDir, m.meta)).toString('latin1'));
  const coqlibVfs = m.coqlib_vfs || '/coqlib';
  for (const rel of (m.vo || []))
    rc.mount(coqlibVfs + '/' + rel, fs.readFileSync(path.join(coqlibDir, rel)).toString('latin1'));
  return (m.vo || []).length;
}

// non-noinit by default: the prelude is mounted, so checks see nat / = / -> /
// tactics. (A request may still pass noinit:true, but only as the FIRST check
// of the engine's lifetime — Driver.init is idempotent.)
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
  const req = { config: Object.assign({}, base, cfg), files: { "challenge.v": ch, "solution.v": sol } };
  return JSON.parse(await rc.check(JSON.stringify(req)));
}

(async () => {
  await rc.ready;
  ok("engine reports a Rocq version", typeof rc.version === 'string' && rc.version.length > 0, "version=" + rc.version);

  const nvo = mountBundle();
  ok("prelude bundle mounted", nvo > 0, "vo=" + nvo);

  // --- nat + tactics proof (needs the prelude: nat, +, =, induction, rewrite) ---
  const NATCH  = "Theorem foo : forall n : nat, n + 0 = n. Proof. Admitted.\n";
  const NATSOL = "Theorem foo : forall n : nat, n + 0 = n.\nProof. induction n as [|n IH]; simpl; [reflexivity | rewrite IH; reflexivity]. Qed.\n";
  let v = await check({ theorem_names: ["foo"], definition_names: [] }, NATCH, NATSOL);
  ok("nat+tactics proof accepted (prelude)", v.ok === true && v.targets[0].status === "proved", "reason=" + v.reason);
  v = await check({ theorem_names: ["foo"], definition_names: [] }, NATCH, NATCH);
  ok("admitted solution rejected (not_proved)", v.ok === false && v.reason === "not_proved");

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

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log("HARNESS ERROR:", e && e.message || e); process.exit(2); });

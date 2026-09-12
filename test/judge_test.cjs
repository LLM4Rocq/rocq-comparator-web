// judge_test.cjs — exercise the REAL in-browser engine (dist/rocq_engine.js)
// end to end under node: honest accept, forbidden-axiom reject, permitted
// axiom accept, and statement-mismatch reject. Proof that the full
// rocq-comparator kernel pipeline runs client-side (js_of_ocaml).
//
//   node test/judge_test.cjs dist/rocq_engine.js
global.window = global;
const path = require('path'), os = require('os'), fs = require('fs');
const enginePath = path.resolve(process.argv[2] || path.join(__dirname, '..', 'dist', 'rocq_engine.js'));
try { process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'rcweb-'))); } catch (_) {}
require(enginePath);
const rc = global.RocqComparator;

let pass = 0, fail = 0;
function ok(name, cond, extra) { (cond ? pass++ : fail++); console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); }

const base = {
  challenge: "challenge.v", solution: "solution.v",
  theorem_names: [], definition_names: ["foo"], permitted_axioms: [],
  loadpath: [], coqproject: null, top: null, timeout_s: 60,
  sandbox: "none", rocqchk: false, vm: false,
  impredicative_set: false, indices_matter: false, noinit: true,
  permitted_plugins: [], permitted_libraries: [], permit_challenge_axioms: true
};
const CH = "Definition foo : forall (A : Prop) (_ : A), A := fun A a => a.\n";
const CHEAT = "Axiom cheat : forall (A : Prop) (_ : A), A.\nDefinition foo : forall (A : Prop) (_ : A), A := cheat.\n";

async function check(cfg, sol) {
  const req = { config: Object.assign({}, base, cfg), files: { "challenge.v": CH, "solution.v": sol } };
  return JSON.parse(await rc.check(JSON.stringify(req)));
}

(async () => {
  await rc.ready;
  ok("engine reports a Rocq version", typeof rc.version === 'string' && rc.version.length > 0, "version=" + rc.version);

  let v = await check({}, CH);
  ok("honest proof accepted", v.ok === true && v.targets[0].status === "proved");
  ok("all checks ran (rocqchk skipped)", v.checks.filter === "ok" && v.checks.statements === "ok" && v.checks.axioms === "ok" && v.checks.rocqchk === "skipped");

  v = await check({}, CHEAT);
  ok("forbidden axiom rejected", v.ok === false && v.reason === "forbidden_axiom");

  v = await check({ permitted_axioms: ["challenge.cheat"] }, CHEAT);
  ok("permitted axiom accepted + reported", v.ok === true && v.targets[0].assumptions.indexOf("challenge.cheat") >= 0);

  v = await check({}, "Definition foo : forall (A : Prop) (B : Prop) (_ : A), A := fun A B a => a.\n");
  ok("statement mismatch rejected", v.ok === false && v.reason === "statement_mismatch" && v.targets[0].status === "mismatch");

  // malformed request -> out-of-band rejection
  let oob = false;
  try { await rc.check("{ not json"); } catch (e) { oob = true; }
  ok("malformed request rejects out-of-band", oob);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log("HARNESS ERROR:", e && e.message || e); process.exit(2); });

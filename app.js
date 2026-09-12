// Rocq Comparator — front-end glue.
//
// Talks to window.RocqComparator per the frontend<->backend contract:
//   ready: Promise<void>
//   check(requestJson: string): Promise<string>
//   version?: string
// This file never assumes the backend is present: everything degrades to a
// friendly "backend not available" state plus a demo-verdict path.

(() => {
  "use strict";

  // ---------------------------------------------------------------------
  // canonical check order (src/check.ml check_names) — anything the verdict
  // carries outside this list is still rendered, appended at the end.
  const CHECK_ORDER = [
    "filter", "challenge_compile", "solution_compile", "joined",
    "statements", "closure", "axioms", "hygiene", "libraries", "rocqchk",
  ];

  const INFRA_REASONS = new Set(["config_error", "challenge_error", "internal_error"]);

  // This build runs with -noinit (no Corelib prelude bundled — see BACKEND.md),
  // so the default example uses core Gallina only: forall / fun and no prelude
  // notations (no ->, =, /\, nat, ...). It is a genuine kernel-checked proof.
  const DEFAULT_CHALLENGE = `(* -noinit: core Gallina only (no prelude notations like -> or =). *)
Definition id_fun : forall (A : Prop) (_ : A), A :=
  fun A a => a.
`;

  const DEFAULT_SOLUTION = `Definition id_fun : forall (A : Prop) (_ : A), A :=
  fun A a => a.
`;

  // Bundled demo verdicts (also saved under examples/ as standalone files) so
  // the UI is fully reviewable with no worker/wasm present, and works when
  // this page is opened as a plain file:// document.
  const DEMO_VERDICT_ACCEPTED = {
    ok: true, reason: null, detail: null, sandboxed: false, sandbox: "none",
    rocq_version: "9.2.0",
    targets: [{ name: "add_n_0", status: "proved", assumptions: [], detail: null }],
    checks: {
      filter: "ok", challenge_compile: "ok", solution_compile: "ok", joined: "ok",
      statements: "ok", closure: "ok", axioms: "ok", hygiene: "ok", libraries: "ok",
      rocqchk: "skipped",
    },
    timing_s: {
      challenge_compile: 0.412, solution_compile: 0.487, joined: 0.021,
      statements: 0.004, closure: 0.006, axioms: 0.002, hygiene: 0.001, libraries: 0.001,
    },
  };

  const DEMO_VERDICT_REJECTED = {
    ok: false, reason: "forbidden_axiom",
    detail: "solution assumes Challenge.magic, which is not in permitted_axioms",
    sandboxed: false, sandbox: "none", rocq_version: "9.2.0",
    targets: [{
      name: "zero_one", status: "mismatch", assumptions: ["Challenge.magic"],
      detail: "depends on an axiom not permitted by the config: Challenge.magic",
    }],
    checks: {
      filter: "ok", challenge_compile: "ok", solution_compile: "ok", joined: "ok",
      statements: "ok", closure: "ok",
      axioms: { fail: "Challenge.magic is not a permitted axiom" },
      hygiene: "skipped", libraries: "skipped", rocqchk: "skipped",
    },
    timing_s: {
      challenge_compile: 0.398, solution_compile: 0.455, joined: 0.019,
      statements: 0.004, closure: 0.005, axioms: 0.002,
    },
  };

  // ---------------------------------------------------------------------
  // small DOM helpers
  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs, children) => {
    const n = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else n.setAttribute(k, v);
    }
    if (children) for (const c of children) n.appendChild(c);
    return n;
  };

  function splitList(s) {
    return s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
  }

  // ---------------------------------------------------------------------
  // line-numbered textarea gutter
  function wireGutter(wrapperId, textareaId) {
    const wrapper = $(wrapperId);
    const gutter = wrapper.querySelector(".gutter");
    const ta = $(textareaId);
    const render = () => {
      const lines = ta.value.split("\n").length;
      let out = "";
      for (let i = 1; i <= lines; i++) out += i + "\n";
      gutter.textContent = out;
    };
    ta.addEventListener("input", render);
    ta.addEventListener("scroll", () => { gutter.scrollTop = ta.scrollTop; });
    render();
    return ta;
  }

  const challengeSrc = wireGutter("challengeEditor", "challengeSrc");
  const solutionSrc = wireGutter("solutionEditor", "solutionSrc");
  challengeSrc.value = DEFAULT_CHALLENGE;
  solutionSrc.value = DEFAULT_SOLUTION;
  challengeSrc.dispatchEvent(new Event("input"));
  solutionSrc.dispatchEvent(new Event("input"));

  // ---------------------------------------------------------------------
  // axiom preset chips
  document.querySelectorAll(".preset-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      const field = $("permittedAxioms");
      const current = splitList(field.value);
      const preset = btn.dataset.preset;
      if (!current.includes(preset)) current.push(preset);
      field.value = current.join(", ");
    });
  });

  // ---------------------------------------------------------------------
  // backend detection / lifecycle
  const backendStatus = $("backendStatus");
  const backendStatusText = $("backendStatusText");
  const unavailableNotice = $("unavailableNotice");
  const unavailableDetail = $("unavailableDetail");
  const runBtn = $("runBtn");
  const runSpinner = $("runSpinner");
  const runNote = $("runNote");

  function setBackendState(state, text) {
    backendStatus.dataset.state = state;
    backendStatusText.textContent = text;
  }

  function showUnavailable(detail) {
    unavailableNotice.hidden = false;
    if (detail) unavailableDetail.textContent = detail;
    runBtn.disabled = true;
    runNote.textContent = "backend not available — Run is disabled; try the demo verdict buttons above.";
  }

  async function initBackend() {
    const rc = window.RocqComparator;
    if (!rc || typeof rc.check !== "function" || !rc.ready) {
      setBackendState("unavailable", "Rocq runtime not found");
      showUnavailable();
      return;
    }
    setBackendState("loading", "Loading Rocq runtime…");
    try {
      await rc.ready;
      const v = rc.version ? ` (Rocq ${rc.version})` : "";
      setBackendState("ready", `Rocq runtime ready${v}`);
      runBtn.disabled = false;
      runNote.textContent = "";
    } catch (e) {
      setBackendState("unavailable", "Rocq runtime failed to load");
      showUnavailable("The Rocq runtime failed to start" + (e && e.message ? `: ${e.message}` : "") + ".");
    }
  }
  initBackend();

  // ---------------------------------------------------------------------
  // build the REQUEST JSON from the form
  function buildRequest() {
    const theorem_names = splitList($("theoremNames").value);
    const definition_names = splitList($("definitionNames").value);
    const permitted_axioms = splitList($("permittedAxioms").value);
    const top = $("topName").value.trim();
    const timeout_s = Number($("timeoutS").value) || 60;

    const config = {
      challenge: "challenge.v",
      solution: "solution.v",
      theorem_names,
      definition_names,
      permitted_axioms,
      loadpath: [],
      coqproject: null,
      top: top || null,
      timeout_s,
      sandbox: "none",
      rocqchk: false, // browser has no rocqchk subprocess; backend forces this anyway
      vm: false, // forced off in the browser regardless
      impredicative_set: $("impredicativeSet").checked,
      indices_matter: $("indicesMatter").checked,
      noinit: $("noinitToggle") ? $("noinitToggle").checked : true,
      permitted_plugins: [],
      permitted_libraries: [],
      permit_challenge_axioms: $("permitChallengeAxioms").checked,
    };

    if (theorem_names.length === 0 && definition_names.length === 0) {
      throw new Error("enter at least one theorem name or definition name");
    }

    return {
      config,
      files: {
        "challenge.v": challengeSrc.value,
        "solution.v": solutionSrc.value,
      },
    };
  }

  // ---------------------------------------------------------------------
  // Run
  runBtn.addEventListener("click", async () => {
    const rc = window.RocqComparator;
    if (!rc) return;
    let request;
    try {
      request = buildRequest();
    } catch (e) {
      renderInternalError(e.message);
      return;
    }

    runBtn.disabled = true;
    runSpinner.hidden = false;
    runNote.textContent = "checking…";
    try {
      const responseJson = await rc.check(JSON.stringify(request));
      const verdict = JSON.parse(responseJson);
      renderVerdict(verdict);
      runNote.textContent = "";
    } catch (e) {
      renderInternalError((e && e.message) || String(e));
      runNote.textContent = "";
    } finally {
      runSpinner.hidden = true;
      runBtn.disabled = false;
    }
  });

  // ---------------------------------------------------------------------
  // demo verdict buttons (work with no backend at all)
  $("loadDemoOk").addEventListener("click", () => renderVerdict(DEMO_VERDICT_ACCEPTED));
  $("loadDemoRejected").addEventListener("click", () => renderVerdict(DEMO_VERDICT_REJECTED));

  // ---------------------------------------------------------------------
  // rendering
  const verdictEmpty = $("verdictEmpty");
  const verdictBody = $("verdictBody");

  function statusIcon(kind) {
    return kind === "ok" ? "✅" : kind === "rejected" ? "❌" : "⚠️";
  }

  function checkChip(name, status) {
    let display, mark;
    if (status === "ok") { display = "ok"; mark = "✓"; }
    else if (status === "skipped") { display = "skipped"; mark = "–"; }
    else { display = (status && status.fail) || "failed"; mark = "✗"; }
    const kind = status === "ok" ? "ok" : status === "skipped" ? "skipped" : "fail";
    const chip = el("span", {
      class: "check-chip", "data-status": kind,
      title: kind === "fail" ? display : `${name}: ${display}`,
    }, [
      el("span", { class: "mark", text: mark }),
      el("span", { text: name }),
    ]);
    return chip;
  }

  function renderInternalError(message) {
    verdictEmpty.hidden = true;
    verdictBody.hidden = false;
    verdictBody.innerHTML = "";
    const banner = el("div", { class: "banner", "data-kind": "infra" }, [
      el("span", { class: "icon", text: "⚠️" }),
      el("div", {}, [
        el("div", { class: "title", text: "Could not complete the check" }),
        el("div", { class: "sub", text: "This is an out-of-band failure (malformed request, wasm trap, out of memory, or the worker was terminated) — not a verdict on the proof." }),
      ]),
    ]);
    verdictBody.appendChild(banner);
    verdictBody.appendChild(el("div", { class: "detail-box", text: message }));
  }

  function renderVerdict(v) {
    verdictEmpty.hidden = true;
    verdictBody.hidden = false;
    verdictBody.innerHTML = "";

    const infra = !v.ok && v.reason && INFRA_REASONS.has(v.reason);
    const kind = v.ok ? "ok" : infra ? "infra" : "rejected";
    const title = v.ok ? "Proved" : infra ? "Infrastructure error" : "Rejected";

    const metaBits = [];
    if (v.rocq_version) metaBits.push(el("span", { text: `Rocq ${v.rocq_version}` }));
    metaBits.push(el("span", { text: `sandbox: ${v.sandbox || "none"}${v.sandboxed ? "" : " (unsandboxed — in-browser)"}` }));

    const banner = el("div", { class: "banner", "data-kind": kind }, [
      el("span", { class: "icon", text: statusIcon(kind) },),
      el("div", {}, [
        el("div", { class: "title", text: title }),
        v.reason ? el("div", { class: "sub", text: `reason: ${v.reason}` }) : el("div", { class: "sub", text: "no issues found" }),
      ]),
      el("div", { class: "meta" }, metaBits),
    ]);
    verdictBody.appendChild(banner);

    if (v.detail) {
      verdictBody.appendChild(el("div", { class: "detail-box", text: v.detail }));
    }

    // targets
    const targets = Array.isArray(v.targets) ? v.targets : [];
    if (targets.length) {
      const cards = targets.map((t) => {
        const row1 = el("div", { class: "row1" }, [
          el("span", { class: "tname", text: t.name }),
          el("span", { class: "status-chip", "data-status": t.status, text: t.status }),
        ]);
        const card = el("div", { class: "target-card" }, [row1]);
        if (t.assumptions && t.assumptions.length) {
          card.appendChild(el("div", { class: "axiom-list" },
            t.assumptions.map((a) => el("span", { class: "axiom-pill", text: a }))));
        } else {
          card.appendChild(el("div", { class: "no-axioms", text: "no assumptions used" }));
        }
        if (t.detail) card.appendChild(el("div", { class: "tdetail", text: t.detail }));
        return card;
      });
      verdictBody.appendChild(el("div", { class: "section" }, [
        el("h3", { text: "Targets" }),
        el("div", { class: "targets" }, cards),
      ]));
    }

    // checks, in canonical order, extras appended
    const checks = v.checks && typeof v.checks === "object" ? v.checks : {};
    const seen = new Set();
    const chips = [];
    for (const name of CHECK_ORDER) {
      if (name in checks) { chips.push(checkChip(name, checks[name])); seen.add(name); }
    }
    for (const name of Object.keys(checks)) {
      if (!seen.has(name)) chips.push(checkChip(name, checks[name]));
    }
    if (chips.length) {
      verdictBody.appendChild(el("div", { class: "section" }, [
        el("h3", { text: "Checks" }),
        el("div", { class: "checks" }, chips),
      ]));
    }

    // timing
    const timing = v.timing_s && typeof v.timing_s === "object" ? v.timing_s : {};
    const timingKeys = Object.keys(timing);
    if (timingKeys.length) {
      const total = timingKeys.reduce((s, k) => s + (Number(timing[k]) || 0), 0);
      const rows = timingKeys.map((k) => el("tr", {}, [
        el("td", { text: k }),
        el("td", { class: "tval", text: `${Number(timing[k]).toFixed(3)}s` }),
      ]));
      rows.push(el("tr", { class: "total" }, [
        el("td", { text: "total" }),
        el("td", { class: "tval", text: `${total.toFixed(3)}s` }),
      ]));
      const table = el("table", { class: "timing-table" }, rows);
      verdictBody.appendChild(el("div", { class: "section" }, [
        el("h3", { text: "Timing" }),
        table,
      ]));
    }
  }
})();

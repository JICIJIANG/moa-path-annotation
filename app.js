/* Serverless annotation UI.
 *
 * State lives in localStorage, keyed by annotator code, and is written on every change.
 * The export file is a BACKUP and a handoff, not the primary store — nobody remembers
 * to press save every time, and a lost afternoon of work is not recoverable.
 *
 * The tier and the four derived columns come from RUBRIC.derive, never from a form
 * field, so an internally inconsistent row cannot be produced. Steps are revealed one
 * at a time and a step after a terminating one is never drawn, so a row that stopped at
 * Step C cannot carry Step E values.
 */
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const S = {
  code: '', items: [], stage: 1, position: 0,
  answers: {},            // key -> { walk, submitted, seconds }
  stage2Items: null,      // key -> { ref_nodes, ref_relations }, loaded from file
  stage2Answers: {},      // key -> { rel_to_gold, alt_head, flag_gold, rel_note, submitted }
  enteredAt: 0, saveTimer: null, sinceBackup: 0,
};

const STORE = () => `moa-annot:${S.code}`;
const item = () => S.items[S.position];
const cur = () => (S.answers[item().key] ||= { walk: {}, submitted: false, seconds: 0 });

/* ------------------------------------------------------------ persistence */

function persist() {
  try {
    localStorage.setItem(STORE(), JSON.stringify({
      code: S.code, answers: S.answers, stage2Answers: S.stage2Answers,
      position: S.position, stage: S.stage, savedAt: Date.now(),
    }));
    $('#saved').textContent = 'saved locally';
  } catch (e) {
    $('#saved').textContent = 'SAVE FAILED';
    alert('The browser refused to save your progress locally (' + e.name + ').\n\n'
      + 'Export your work now with the Download button, and avoid private/incognito '
      + 'windows — they discard storage when closed.');
  }
}

function restore() {
  try {
    const raw = localStorage.getItem(STORE());
    if (!raw) return false;
    const d = JSON.parse(raw);
    S.answers = d.answers || {};
    S.stage2Answers = d.stage2Answers || {};
    S.position = d.position || 0;
    return true;
  } catch (_) { return false; }
}

const submittedCount = () => Object.values(S.answers).filter((a) => a.submitted).length;
const s2Count = () => Object.values(S.stage2Answers).filter((a) => a.submitted).length;

/* ------------------------------------------------------------------- gate */

/* FNV-1a/32, mirroring build_static.code_hash byte for byte (UTF-8, not UTF-16 units).
 * Bundles are named by this hash so no annotator name is in a filename, a script tag or
 * view-source. Concealment, not security — it keeps a visitor to a public site from
 * learning who is annotating, nothing more. */
function codeHash(code) {
  const bytes = new TextEncoder().encode(code);
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

$('#gate-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = $('#gate-code').value.trim().toLowerCase();
  const bundle = code && window[`B_${codeHash(code)}`];
  if (!bundle) {
    // Deliberately does not say which codes exist.
    $('#gate-error').textContent = 'That code has no bundle in this build.';
    return;
  }
  S.code = code;
  S.items = bundle.items;
  localStorage.setItem('moa-annot:last', code);
  const had = restore();
  $('#gate').hidden = true; $('#bar').hidden = false; $('#app').hidden = false;
  buildRubricDrawer();
  if (!had) S.position = 0;
  const next = S.items.findIndex((it) => !(S.answers[it.key] || {}).submitted);
  load(next >= 0 ? next : S.position);
});

// The code is remembered in this browser so the annotator types it once, but it is
// never listed anywhere before they do.
(() => {
  const last = localStorage.getItem('moa-annot:last');
  if (last) $('#gate-code').value = last;
})();

/* -------------------------------------------------------------- stage 1 */

function load(position) {
  S.stage = 1;
  S.position = Math.max(0, Math.min(position, S.items.length - 1));
  S.enteredAt = Date.now();
  const it = item();
  $('#stage1').hidden = false; $('#stage2').hidden = true;
  $('#who').textContent = `${S.code} · ${it.item_id}`;
  $('#s1-drug').textContent = it.drug;
  $('#s1-disease').textContent = it.disease;
  const w = cur().walk;
  $('#f-note').value = w.note || '';
  $('#f-refs').value = w.refs || '';
  $('#override-reason').value = w.override_reason || '';
  render();
}

function derived() {
  const it = item();
  return window.RUBRIC.derive(cur().walk, it.nodes, it.relations);
}

function render() {
  renderChain();
  renderSteps();
  renderVerdict(derived());
  renderFlags();
  updateBar();
}

function updateBar() {
  const done = S.stage === 1 ? submittedCount() : s2Count();
  const total = S.items.length;
  $('#counter').textContent = S.stage === 1
    ? `${done} / ${total} submitted` : `stage 2 · ${done} / ${total}`;
  $('#progress-fill').style.width = `${(100 * done) / total}%`;
  const unlocked = submittedCount() >= total && S.stage2Items;
  $('#btn-stage').textContent = S.stage === 1 ? 'Stage 2' : 'Stage 1';
  $('#btn-stage').disabled = S.stage === 1 && !unlocked;
  $('#btn-stage').title = unlocked ? ''
    : 'Stage 2 opens once every row is submitted and you load the stage-2 file.';
}

function touch(textOnly = false) {
  cur().seconds += (Date.now() - S.enteredAt) / 1000;
  S.enteredAt = Date.now();
  if (!textOnly) render(); else renderVerdict(derived());
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(persist, 300);
}

/* ---------------------------------------------------------------- chain */

function renderChain() {
  const it = item();
  const inStepE = reachedStepE();
  const ol = $('#chain');
  ol.innerHTML = '';
  ol.classList.toggle('markable', inStepE);
  const marks = cur().walk.marks || [];
  const ti = cur().walk.target_index ?? it.suggested_target_index;

  it.nodes.forEach((name, i) => {
    const li = el('li');
    const node = el('div', `node m-${marks[i] || ''}`);
    if (i === ti) node.classList.add('is-target');
    node.append(el('span', 'idx', `[${i}]`), el('span', 'name', name));
    if (inStepE) {
      node.append(el('span', 'mark', marks[i] || '·'));
      node.addEventListener('click', () => cycleMark(i));
    }
    li.append(node);
    if (i < it.relations.length) {
      const r = el('div', 'rel', `--${it.relations[i]}-->`);
      if (it.ambiguous_edges.includes(i)) r.classList.add('ambig');
      li.append(r);
    }
    ol.append(li);
  });
  $('#chain-hint').textContent = inStepE
    ? 'Click each node to cycle O → V → X. Every node must be marked.'
    : 'Read the chain. The decision tree is on the right.';
}

function cycleMark(i) {
  const it = item();
  const w = cur().walk;
  const marks = (w.marks || []).slice();
  while (marks.length < it.nodes.length) marks.push('');
  // Convention 5: the terminal disease node is never marked X.
  const order = i === it.nodes.length - 1 ? ['O', 'V'] : ['O', 'V', 'X'];
  marks[i] = order[(order.indexOf(marks[i]) + 1) % order.length];
  w.marks = marks;
  if (marks[i] !== 'X') {
    if (w.load_bearing) delete w.load_bearing[i];
    if (w.cross_domain) delete w.cross_domain[i];
  }
  touch();
}

/* ----------------------------------------------------------------- steps */

const W = () => cur().walk;
const answered = (k) => W()[k] !== undefined && W()[k] !== null;

function stoppedBefore(step) {
  const w = W();
  if (['worsens', 'conflict'].includes(w.net_polarity)) return true;
  if (step === 'B') return false;
  if (w.first_node_is_drug_target === false && w.any_node_in_context === false) return true;
  if (step === 'C') return false;
  if (w.target_gate_pass === false) return true;
  if (step === 'D') return false;
  if (w.endpoint_matches_query === false) return true;
  return false;
}

function reachedStepE() {
  return answered('net_polarity') && answered('first_node_is_drug_target')
    && answered('any_node_in_context') && answered('target_gate_pass')
    && answered('endpoint_matches_query') && !stoppedBefore('E');
}

function stepBox(title, terminated, done) {
  const d = el('div', `step${terminated ? ' terminated' : done ? ' done' : ''}`);
  d.append(el('h3', null, title));
  return d;
}

function choices(box, key, opts, store) {
  const row = el('div', 'choices');
  opts.forEach(([val, label]) => {
    const b = el('button', 'choice', label);
    b.setAttribute('aria-pressed', String((store || W())[key] === val));
    b.addEventListener('click', () => { (store || W())[key] = val; touch(); });
    row.append(b);
  });
  box.append(row);
  return row;
}

function renderSteps() {
  const wrap = $('#steps');
  wrap.innerHTML = '';
  const it = item();
  const w = W();
  const nAmbig = it.ambiguous_edges.length;

  {
    const stop = ['worsens', 'conflict'].includes(w.net_polarity);
    const box = stepBox('Step A · net polarity', stop, answered('net_polarity'));
    box.append(el('p', 'q', 'Compose the signed edges end to end. What does the chain conclude?'));
    choices(box, 'net_polarity', [
      ['reduces', 'reduces the disease'], ['worsens', 'worsens it → Tier 11'],
      ['unreadable', 'unreadable'], ['conflict', 'conflict'],
    ]);
    box.append(el('p', 'note-sm', nAmbig
      ? `${nAmbig} edge${nAmbig > 1 ? 's have' : ' has'} an undetermined direction (red in the chain). `
        + (nAmbig >= 2 ? 'Two or more ⇒ unreadable; skip Step A and continue.'
                       : 'Fewer than two, so polarity is still readable.')
      : 'No direction-ambiguous edges: polarity is readable.'));
    wrap.append(box);
    if (stop) return;
  }
  if (!answered('net_polarity')) return;

  {
    const stop = w.first_node_is_drug_target === false && w.any_node_in_context === false;
    const box = stepBox('Step B · triple failure', stop,
      answered('first_node_is_drug_target') && answered('any_node_in_context'));
    box.append(el('p', 'q', `Is “${it.nodes[1]}” — the first entity after the drug — a target of this drug?`));
    choices(box, 'first_node_is_drug_target', [[true, 'yes'], [false, 'no']]);
    const sub = el('div', 'sub');
    sub.append(el('p', 'q', 'Does ANY node in the chain relate to the biology of this drug or this disease?'));
    box.append(sub);
    choices(sub, 'any_node_in_context', [[true, 'yes'], [false, 'no']]);
    if (stop) box.append(el('p', 'note-sm', 'Both no ⇒ Tier 10 UNRELATED. The tree stops here.'));
    wrap.append(box);
    if (stop) return;
  }
  if (!answered('first_node_is_drug_target') || !answered('any_node_in_context')) return;

  {
    const stop = w.target_gate_pass === false;
    const box = stepBox('Step C · target gate', stop, answered('target_gate_pass'));
    const ti = w.target_index ?? it.suggested_target_index;
    box.append(el('p', 'q', `Does “${it.nodes[ti]}” qualify as a real binding target of this drug?`));
    choices(box, 'target_gate_pass', [[true, 'yes — gate passes'], [false, 'no → Tier 9']]);

    const slot = el('div', 'sub');
    slot.append(el('p', 'note-sm', 'Judging the wrong node? Pick the target slot:'));
    const sel = el('select');
    it.nodes.forEach((n, i) => {
      if (i === 0) return;
      const o = el('option', null, `[${i}] ${n}`);
      o.value = String(i); if (i === ti) o.selected = true;
      sel.append(o);
    });
    sel.addEventListener('change', () => { W().target_index = Number(sel.value); touch(); });
    slot.append(sel);
    if (ti !== 1) slot.append(el('p', 'note-sm',
      'Prodrug exception: the metabolite hop is skipped, so the gate judges what the active species binds.'));
    box.append(slot);

    if (w.target_gate_pass === true) {
      const ex = el('div', 'sub');
      ex.append(el('p', 'note-sm', 'Which exception let it pass? (none = it is simply the right target)'));
      choices(ex, 'target_exception', [
        ['none', 'none'], ['family_or_complex', 'right family / complex'],
        ['non_receptor_drug', 'non-receptor drug'], ['prodrug_metabolite', 'prodrug'],
      ]);
      box.append(ex);
    }
    wrap.append(box);
    if (stop) return;
  }
  if (!answered('target_gate_pass')) return;

  {
    const stop = w.endpoint_matches_query === false;
    const last = it.nodes[it.nodes.length - 1];
    const box = stepBox('Step D · endpoint gate', stop, answered('endpoint_matches_query'));
    box.append(el('p', 'q', `Is the terminal node “${last}” the queried disease (or an accepted synonym)?`));
    choices(box, 'endpoint_matches_query', [[true, 'yes'], [false, 'no — it was substituted']]);
    if (w.endpoint_matches_query === false) {
      const sub = el('div', 'sub');
      sub.append(el('p', 'q', `Is this drug clinically indicated for “${last}”?`));
      box.append(sub);
      choices(sub, 'drug_indicated_for_endpoint', [
        [true, 'yes → Tier 5'], [false, 'no, or it is not a disease at all → Tier 8'],
      ]);
    }
    wrap.append(box);
    if (stop) return;
  }
  if (!answered('endpoint_matches_query')) return;

  {
    const box = stepBox('Step E · chain assessment', false, reachedStepE());
    box.append(el('p', 'q', 'Mark every node in the chain on the left: O, V or X.'));
    box.append(el('p', 'note-sm', window.RUBRIC_TEXT.node_marks.mark));
    const marks = W().marks || [];
    const unmarked = it.nodes.filter((_, i) => !marks[i]).length;
    if (unmarked) box.append(el('p', 'note-sm', `${unmarked} node${unmarked > 1 ? 's' : ''} still unmarked.`));

    it.nodes.forEach((name, i) => {
      if (marks[i] !== 'X') return;
      const lb = W().load_bearing || {};
      const sub = el('div', 'sub');
      sub.append(el('p', 'q', `[${i}] ${name} — Test A: is its edge load-bearing or decorative?`));
      const row = el('div', 'choices');
      [[true, 'load-bearing'], [false, 'decorative']].forEach(([val, label]) => {
        const b = el('button', 'choice', label);
        b.setAttribute('aria-pressed', String(lb[i] === val));
        b.addEventListener('click', () => {
          W().load_bearing = { ...(W().load_bearing || {}), [i]: val };
          touch();
        });
        row.append(b);
      });
      sub.append(row);

      // Test B decides the tier only for a decorative X. For a load-bearing one the
      // tier is already settled, but the domain is still worth recording — the pilot
      // annotator did on 33 rows — so it is offered and marked optional.
      const decorative = lb[i] === false;
      if (decorative || lb[i] === true) {
        const cd = W().cross_domain || {};
        const t2 = el('div', 'sub');
        t2.append(el('p', 'q', decorative
          ? 'Test B: does the error cross a macroscopic biological domain?'
          : 'Domain of this X (optional — does not affect the tier):'));
        const r2 = el('div', 'choices');
        [[true, 'cross-domain'], [false, 'same-domain']].forEach(([val, label]) => {
          const b = el('button', 'choice', label);
          b.setAttribute('aria-pressed', String(cd[i] === val));
          b.addEventListener('click', () => {
            W().cross_domain = { ...(W().cross_domain || {}), [i]: val };
            touch();
          });
          r2.append(b);
        });
        t2.append(r2);
        sub.append(t2);
      }
      box.append(sub);
    });
    wrap.append(box);
  }
}

/* --------------------------------------------------------------- verdict */

function renderVerdict(d) {
  $('#v-tier').textContent = d.tier || '—';
  $('#v-score').textContent = d.score === null ? '' : d.score.toFixed(1);
  $('#v-reason').textContent = d.reason || 'Keep answering the tree.';
  const t = $('#v-cols');
  t.innerHTML = '';
  [['evidence_node', d.evidenceNode], ['test_A', d.testA], ['test_B', d.testB],
   ['x_position', d.xPosition], ['stopped at', d.stoppedAt ? `Step ${d.stoppedAt}` : '—']]
    .forEach(([k, v]) => {
      const tr = el('tr'); tr.append(el('td', null, k), el('td', null, v || '—')); t.append(tr);
    });
  const sel = $('#override-tier');
  if (!sel.dataset.built) {
    window.RUBRIC_TEXT.tiers.forEach((x) => {
      const o = el('option', null, `${x.n} ${x.name}  (${x.score.toFixed(1)})`);
      o.value = x.name; sel.append(o);
    });
    sel.dataset.built = '1';
    sel.addEventListener('change', () => { W().tier_override = sel.value || null; touch(); });
    $('#override-reason').addEventListener('input', (e) => {
      W().override_reason = e.target.value; touch(true);
    });
  }
  sel.value = W().tier_override || '';
  if (d.overridden) $('#override-box').open = true;
  $('#btn-submit').disabled = !d.tier;
}

function renderFlags() {
  const box = $('#flag-chips');
  box.innerHTML = '';
  ['FLAG-UNSURE', 'FLAG-SOURCE'].forEach((f) => {
    const b = el('button', 'chip', f);
    b.setAttribute('aria-pressed', String((W().flags || []).includes(f)));
    b.addEventListener('click', () => {
      const s = new Set(W().flags || []);
      s.has(f) ? s.delete(f) : s.add(f);
      W().flags = [...s];
      touch();
    });
    box.append(b);
  });
}

$('#f-note').addEventListener('input', (e) => { W().note = e.target.value; touch(true); });
$('#f-refs').addEventListener('input', (e) => { W().refs = e.target.value; touch(true); });

/* ------------------------------------------------------------ navigation */

$('#btn-submit').addEventListener('click', () => {
  const d = derived();
  if (!d.tier) return;
  cur().submitted = true;
  persist();
  S.sinceBackup += 1;
  const next = S.items.findIndex((it, i) => i > S.position && !(S.answers[it.key] || {}).submitted);
  const any = S.items.findIndex((it) => !(S.answers[it.key] || {}).submitted);
  if (next >= 0) load(next);
  else if (any >= 0) load(any);
  else { updateBar(); alert('Every row is submitted. Download your file and send it back.'); }
  if (S.sinceBackup >= 25) {
    S.sinceBackup = 0;
    if (confirm('25 more rows done. Download a backup now?')) exportJSON();
  }
});

$('#btn-prev').addEventListener('click', () => load(S.position - 1));
$('#btn-next').addEventListener('click', () => load(S.position + 1));
$('#btn-stage').addEventListener('click', () => {
  if (S.stage === 1) loadStage2(0); else load(0);
});

/* ------------------------------------------------------ export / import */

function download(name, text, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = el('a');
  a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function exportJSON() {
  download(`annotations_${S.code}.json`, JSON.stringify({
    format: 'moa-annotation/1',
    annotator: S.code,
    exported_at: new Date().toISOString(),
    n_submitted: submittedCount(),
    n_total: S.items.length,
    answers: S.answers,
    stage2: S.stage2Answers,
  }, null, 1), 'application/json');
  $('#saved').textContent = 'downloaded';
}

function exportCSV() {
  const cols = ['item_id', 'key', 'drug', 'disease', 'net_polarity', 'tier',
    'validity_score', 'stopped_at', 'evidence_node', 'test_A', 'test_B', 'x_position',
    'flags', 'note', 'refs', 'seconds', 'rel_to_gold', 'alt_head', 'flag_gold', 'rel_note'];
  const q = (v) => {
    const s = v === undefined || v === null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(',')];
  S.items.forEach((it) => {
    const a = S.answers[it.key] || { walk: {} };
    const d = window.RUBRIC.derive(a.walk, it.nodes, it.relations);
    const b = S.stage2Answers[it.key] || {};
    lines.push([it.item_id, it.key, it.drug, it.disease, a.walk.net_polarity, d.tier,
      d.score, d.stoppedAt, d.evidenceNode, d.testA, d.testB, d.xPosition,
      (a.walk.flags || []).join('|'), a.walk.note, a.walk.refs,
      Math.round(a.seconds || 0), b.rel_to_gold, b.alt_head, b.flag_gold, b.rel_note,
    ].map(q).join(','));
  });
  download(`annotations_${S.code}.csv`, '﻿' + lines.join('\n'), 'text/csv');
}

$('#btn-export').addEventListener('click', exportJSON);
$('#btn-export-csv').addEventListener('click', exportCSV);

$('#file-restore').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (d.format !== 'moa-annotation/1') throw new Error('not an annotation export');
    if (d.annotator !== S.code) {
      if (!confirm(`That file belongs to annotator ${d.annotator}, not ${S.code}. Load anyway?`)) return;
    }
    const mine = submittedCount();
    const theirs = Object.values(d.answers || {}).filter((a) => a.submitted).length;
    if (mine > theirs && !confirm(
      `This browser already has ${mine} submitted rows; the file has ${theirs}. Overwrite?`)) return;
    S.answers = d.answers || {};
    S.stage2Answers = d.stage2 || {};
    persist();
    load(0);
    alert(`Restored ${theirs} submitted rows.`);
  } catch (err) { alert('Could not read that file: ' + err.message); }
  e.target.value = '';
});

$('#file-stage2').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (!d.items) throw new Error('not a stage-2 file');
    if (d.annotator !== S.code) throw new Error(`that file is for ${d.annotator}, not ${S.code}`);
    S.stage2Items = Object.fromEntries(d.items.map((x) => [x.key, x]));
    updateBar();
    alert('Stage-2 reference paths loaded. The Stage 2 button is now available.');
  } catch (err) { alert('Could not read that file: ' + err.message); }
  e.target.value = '';
});

/* --------------------------------------------------------------- stage 2 */

function loadStage2(position) {
  if (submittedCount() < S.items.length) {
    alert('Finish and submit every stage-1 row first.'); return;
  }
  if (!S.stage2Items) { alert('Load the stage-2 file first.'); return; }
  S.stage = 2;
  S.position = Math.max(0, Math.min(position, S.items.length - 1));
  const it = item();
  const ref = S.stage2Items[it.key];
  const a = S.answers[it.key] || { walk: {} };
  const d = window.RUBRIC.derive(a.walk, it.nodes, it.relations);
  $('#stage1').hidden = true; $('#stage2').hidden = false;
  $('#who').textContent = `${S.code} · ${it.item_id}`;
  $('#s2-drug').textContent = it.drug;
  $('#s2-disease').textContent = it.disease;
  $('#s2-tier').textContent = `${d.tier ?? '—'}  (${(d.score ?? 0).toFixed(1)})`;
  drawChain($('#s2-pred'), it.nodes, it.relations, ref.ref_nodes);
  drawChain($('#s2-ref'), ref.ref_nodes, ref.ref_relations, it.nodes);
  S.stage2Answers[it.key] ||= {};
  $('#s2-note').value = S.stage2Answers[it.key].rel_note || '';
  renderStage2Questions();
  updateBar();
}

function drawChain(ol, nodes, rels, other) {
  ol.innerHTML = '';
  nodes.forEach((n, i) => {
    const li = el('li');
    if (other[i] !== n) li.classList.add('diff');
    const node = el('div', 'node');
    node.append(el('span', 'idx', `[${i}]`), el('span', 'name', n));
    li.append(node);
    if (i < rels.length) li.append(el('div', 'rel', `--${rels[i]}-->`));
    ol.append(li);
  });
}

function renderStage2Questions() {
  const store = S.stage2Answers[item().key];
  const wrap = $('#s2-questions');
  wrap.innerHTML = '';
  const ask = (key, title, question, opts, hint) => {
    const box = stepBox(title, false, !!store[key]);
    box.append(el('p', 'q', question));
    const row = el('div', 'choices');
    opts.forEach(([val, label]) => {
      const b = el('button', 'choice', label);
      b.setAttribute('aria-pressed', String(store[key] === val));
      b.addEventListener('click', () => { store[key] = val; renderStage2Questions(); persist(); });
      row.append(b);
    });
    box.append(row);
    if (hint) box.append(el('p', 'note-sm', hint));
    wrap.append(box);
  };
  ask('rel_to_gold', 'rel_to_gold', 'How does the predicted path relate to the reference?',
    [['SAME', 'SAME'], ['PARTIAL', 'PARTIAL'], ['UNRELATED', 'UNRELATED']],
    'A path can be Tier 1 and still not SAME. Do not revise your stage-1 tier.');
  ask('alt_head', 'alt_head', 'Does the prediction start from a different but legitimate target?',
    [['yes', 'yes'], ['no', 'no']]);
  ask('flag_gold', 'flag_gold', 'Do you think the REFERENCE itself is wrong or defective?',
    [['yes', 'yes'], ['no', 'no']],
    'It is one curated route and is sometimes mistaken. This does not change your tier.');
}

$('#s2-note').addEventListener('input', (e) => {
  S.stage2Answers[item().key].rel_note = e.target.value;
  clearTimeout(S.saveTimer); S.saveTimer = setTimeout(persist, 300);
});
$('#s2-submit').addEventListener('click', () => {
  const store = S.stage2Answers[item().key];
  if (!store.rel_to_gold) { alert('rel_to_gold is required.'); return; }
  store.submitted = true;
  persist();
  if (S.position + 1 < S.items.length) loadStage2(S.position + 1);
  else { updateBar(); alert('Stage 2 complete. Download your file and send it back.'); }
});
$('#s2-prev').addEventListener('click', () => loadStage2(S.position - 1));

/* -------------------------------------------------------- rubric drawer */

function buildRubricDrawer() {
  const t = window.RUBRIC_TEXT;
  const b = $('#rubric-body');
  b.innerHTML = '';
  b.append(el('h2', null, 'Decision procedure'), el('pre', null, t.decision_tree));
  b.append(el('h2', null, 'Tiers and scores'));
  const tb = el('table', 'tier-table');
  t.tiers.forEach((x) => {
    const tr = el('tr');
    tr.append(el('td', null, `Tier ${x.n}`), el('td', null, x.name), el('td', null, x.score.toFixed(1)));
    tb.append(tr);
  });
  b.append(tb);
  b.append(el('h2', null, 'Node marks'));
  Object.entries(t.node_marks).forEach(([k, v]) => b.append(el('pre', null, `${k}\n    ${v}`)));
  b.append(el('h2', null, 'Conventions'), el('pre', null, t.conventions));
}

$('#btn-rubric').addEventListener('click', () => { $('#rubric').hidden = false; });
$('#rubric-close').addEventListener('click', () => { $('#rubric').hidden = true; });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $('#rubric').hidden = true;
});

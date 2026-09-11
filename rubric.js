/* The 11-tier decision tree, ported from rubric.py.
 *
 * This runs in the browser so the annotator sees the derived verdict live with no
 * server. It is a SECOND implementation of logic that also exists in Python, which is
 * exactly the kind of duplication that drifts — so:
 *
 *   1. the exported file records the raw `walk`, never only the verdict;
 *   2. `ingest.py` re-derives every row with the Python implementation on the way in
 *      and reports any row where the two disagree;
 *   3. `tests/derive_cases.json` is a shared fixture both implementations are checked
 *      against, so a drift shows up as a failing test rather than as bad data.
 *
 * If the two ever disagree, Python wins: it is the one the analysis runs on.
 */
'use strict';

const TIER_NAMES = {
  1: 'EXACT', 2: 'IMPRECISE', 3: 'MISLOCATED', 4: 'FOREIGN-NODE',
  5: 'RIGHT-MECH-WRONG-DISEASE', 6: 'BROKEN-LINK', 7: 'BROKEN-CORE',
  8: 'OFF-TARGET-DISEASE', 9: 'WRONG-TARGET', 10: 'UNRELATED', 11: 'INVERTED',
};
const TIER_NUMBER = Object.fromEntries(
  Object.entries(TIER_NAMES).map(([n, name]) => [name, Number(n)]));
const TIER_ORDER = Object.keys(TIER_NAMES).map((n) => TIER_NAMES[n]);
const tierToScore = (n) => Math.round(((11 - n) / 10) * 10) / 10;

const METABOLITE_RELATIONS = new Set(
  ['has metabolite', 'is metabolised to', 'is metabolized to']);

/* Which node Step C judges. Usually [1], but the prodrug exception skips the
 * metabolite, and getting this wrong puts the metabolite in evidence_node instead of
 * the offending target. */
function suggestTargetIndex(nodes, relations) {
  if (relations.length && METABOLITE_RELATIONS.has(relations[0]) && nodes.length > 2) return 2;
  return 1;
}

/* Where an X sits, measured from the TARGET slot rather than from the start of the
 * path. "First effect" means immediately downstream of the drug's target, so on a
 * prodrug or family-node path the slot is not index 1. */
function xSlot(index, nNodes, targetIndex) {
  if (index <= targetIndex + 1) return 'first-effect';
  return index >= nNodes - 2 ? 'terminal' : 'mid-chain';
}

const BLANK = {
  tier: null, score: null, stoppedAt: null, evidenceNode: '',
  testA: 'n/a', testB: 'n/a', xPosition: 'n/a', reason: '', overridden: false,
};

function derive(walk, nodes, relations) {
  relations = relations || [];
  const w = walk || {};
  const first = nodes.length > 1 ? nodes[1] : '';
  const ti = (w.target_index === undefined || w.target_index === null)
    ? suggestTargetIndex(nodes, relations) : w.target_index;
  const target = (ti >= 0 && ti < nodes.length) ? nodes[ti] : first;

  const out = (tier, step, evidence, reason, a = 'n/a', b = 'n/a', x = 'n/a') => {
    const d = {
      tier, score: tierToScore(TIER_NUMBER[tier]), stoppedAt: step,
      evidenceNode: evidence, testA: a, testB: b, xPosition: x, reason, overridden: false,
    };
    if (w.tier_override && w.tier_override !== tier) {
      d.tier = w.tier_override;
      d.score = tierToScore(TIER_NUMBER[w.tier_override]);
      d.overridden = true;
      d.reason = `${reason}  [overridden: ${w.override_reason || ''}]`;
    }
    return d;
  };
  const unset = (v) => v === undefined || v === null;

  // Step A
  if (unset(w.net_polarity)) return { ...BLANK };
  if (w.net_polarity === 'worsens' || w.net_polarity === 'conflict') {
    return out('INVERTED', 'A', first,
      'Step A: the composed chain concludes the drug promotes the disease.');
  }

  // Step B
  if (unset(w.first_node_is_drug_target) || unset(w.any_node_in_context)) return { ...BLANK };
  if (w.first_node_is_drug_target === false && w.any_node_in_context === false) {
    return out('UNRELATED', 'B', first,
      'Step B: the first entity is not a target and nothing in the chain touches the '
      + 'biology of the drug or the disease.');
  }

  // Step C
  if (unset(w.target_gate_pass)) return { ...BLANK };
  if (w.target_gate_pass === false) {
    return out('WRONG-TARGET', 'C', target,
      `Step C: '${target}' is not a binding target of this drug and no exception applies.`);
  }

  // Step D
  if (unset(w.endpoint_matches_query)) return { ...BLANK };
  if (w.endpoint_matches_query === false) {
    const endpoint = nodes.length ? nodes[nodes.length - 1] : '';
    if (unset(w.drug_indicated_for_endpoint)) return { ...BLANK };
    if (w.drug_indicated_for_endpoint) {
      return out('RIGHT-MECH-WRONG-DISEASE', 'D', endpoint,
        'Step D: the endpoint was substituted, and the drug is indicated for the '
        + 'substituted endpoint.');
    }
    return out('OFF-TARGET-DISEASE', 'D', endpoint,
      'Step D: the endpoint was substituted and the drug is not indicated for it.');
  }

  // Step E
  const marks = w.marks || [];
  if (marks.length !== nodes.length || marks.some((m) => !['O', 'V', 'X'].includes(m))) {
    return { ...BLANK };
  }
  const lbAns = w.load_bearing || {};
  const cdAns = w.cross_domain || {};
  const xs = marks.map((m, i) => (m === 'X' ? i : -1)).filter((i) => i >= 0);
  const vs = marks.map((m, i) => (m === 'V' ? i : -1)).filter((i) => i >= 0);
  if (xs.some((i) => unset(lbAns[i]))) return { ...BLANK };

  const lb = xs.filter((i) => lbAns[i] === true);
  const dec = xs.filter((i) => lbAns[i] === false);
  if (dec.some((i) => unset(cdAns[i]))) return { ...BLANK };

  const names = (idx) => idx.map((i) => nodes[i]).join('; ');

  if (lb.length) {
    const firstEffect = lb.filter((i) => i <= ti + 1);
    const pos = xSlot(Math.min(...lb), nodes.length, ti);
    if (lb.length >= 2 || firstEffect.length) {
      const why = lb.length >= 2
        ? 'two or more load-bearing X'
        : 'a load-bearing X in the first-effect slot';
      // test_B is not consulted on this branch, but the domain of the X is still worth
      // keeping — the pilot annotator recorded it on 33 rows. Optional, never required.
      const b = cdAns[lb[0]] === undefined ? 'n/a'
        : (cdAns[lb[0]] ? 'cross-domain' : 'same-domain');
      return out('BROKEN-CORE', 'E', names(lb), `Step E: ${why}.`,
        'load-bearing', b, firstEffect.length ? 'first-effect' : pos);
    }
    const b = cdAns[lb[0]] === undefined ? 'n/a'
      : (cdAns[lb[0]] ? 'cross-domain' : 'same-domain');
    return out('BROKEN-LINK', 'E', names(lb),
      'Step E: exactly one load-bearing X, downstream of the first-effect slot.',
      'load-bearing', b, pos);
  }

  if (dec.length) {
    const crossing = dec.filter((i) => cdAns[i] === true);
    if (crossing.length) {
      return out('FOREIGN-NODE', 'E', names(crossing),
        'Step E: core intact, decorative X crossing a biological domain.',
        'decorative', 'cross-domain');
    }
    return out('MISLOCATED', 'E', names(dec),
      'Step E: core intact, decorative X within the same domain.',
      'decorative', 'same-domain');
  }

  if (vs.length) return out('IMPRECISE', 'E', names(vs), 'Step E: no X, at least one V.');
  return out('EXACT', 'E', '-', 'Step E: every node is O.');
}

window.RUBRIC = { TIER_NAMES, TIER_ORDER, TIER_NUMBER, tierToScore, derive, suggestTargetIndex, xSlot };

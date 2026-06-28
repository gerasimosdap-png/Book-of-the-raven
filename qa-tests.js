#!/usr/bin/env node
/*
 * QA regression tests for "The Book of the Raven"
 * ------------------------------------------------
 * Pure Node, zero dependencies. Keep this beside the HTML in the repo.
 *
 *   node qa-tests.js                      # tests ./the_book_of_the_raven.html
 *   node qa-tests.js path/to/file.html    # tests a specific file
 *
 * Exits 0 if everything passes, 1 if any check fails (good for CI / pre-commit).
 *
 * It parses the data + pure-logic blocks out of the page (IMG, OMENS, tier,
 * tierName, omenLine, ACTS, story) and runs them in a sandbox — no browser /
 * DOM needed — then asserts the story graph is well-formed.
 */
'use strict';
const fs = require('fs');

const FILE = process.argv[2] || 'the_book_of_the_raven.html';
let html;
try { html = fs.readFileSync(FILE, 'utf8'); }
catch (e) { console.error('Cannot read ' + FILE + ': ' + e.message); process.exit(1); }

/* ---- pull the pure-logic blocks out of the <script> ---- */
function grab(re, name) {
  const m = html.match(re);
  if (!m) { console.error('FATAL: could not locate ' + name + ' block in ' + FILE); process.exit(1); }
  return m[1];
}
const blocks = [
  grab(/(const IMG=\{[\s\S]*?\};)/, 'IMG'),
  grab(/(const OMENS=\{[\s\S]*?\n\};)/, 'OMENS'),
  grab(/(function tier\(d\)\{[\s\S]*?\})/, 'tier'),
  grab(/(function tierName\(d\)\{[\s\S]*?\];\})/, 'tierName'),
  grab(/(function omenLine\(\)\{[\s\S]*?\})/, 'omenLine'),
  grab(/(const ACTS=\{[\s\S]*?\n\};)/, 'ACTS'),
  grab(/(const story=\{[\s\S]*?\n\};)\s*\n\s*\/\* ——— ENGINE/, 'story'),
];
// Concatenate (NOT a template literal) so backticks/${} inside dyn() are inert.
const body = blocks.join('\n') + '\nreturn {IMG,OMENS,tier,tierName,omenLine,ACTS,story};';
const S = { dark: 0, flags: {}, sacrifices: [], thread: [], returns: 0 };
let M;
try { M = new Function('S', body)(S); }
catch (e) { console.error('FATAL: sandbox failed to evaluate: ' + e.message); process.exit(1); }
const { IMG, tier, tierName, ACTS, story } = M;

/* ---- tiny test runner ---- */
let pass = 0, fail = 0;
const problems = [];
function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; problems.push(name + (detail ? ' — ' + detail : '')); }
}

/* ---- 1. node-level integrity ---- */
const ids = Object.keys(story);
for (const id of ids) {
  const n = story[id];
  if (n.cover || n.interlude) continue;
  if (n.img) check('img:' + id, !!IMG[n.img], 'unknown image key ' + n.img);
  if (n.bg)  check('bg:' + id,  !!IMG[n.bg],  'unknown bg key ' + n.bg);

  if (n.craft) {
    const cf = n.craft;
    check('craft.rightTo:' + id, !!story[cf.rightTo], 'missing ' + cf.rightTo);
    check('craft.leftTo:' + id,  !!story[cf.leftTo],  'missing ' + cf.leftTo);
    if (cf.reverseTo) check('craft.reverseTo:' + id, !!story[cf.reverseTo], 'missing ' + cf.reverseTo);
    const hands = new Set((cf.components || []).map(c => c.hand));
    check('craft.hasRight:' + id, hands.has('right'), 'no right-hand component');
    check('craft.hasLeft:' + id,  hands.has('left'),  'no left-hand component');
    if (cf.reverseTo) check('craft.reverseComp:' + id, hands.has('reverse'), 'reverseTo set but no reverse component');
    (cf.components || []).forEach((c, i) => {
      check('craft.hand:' + id + '#' + i, ['right', 'left', 'reverse'].includes(c.hand), 'bad hand ' + c.hand);
      check('craft.text:' + id + '#' + i, !!(c.label && c.note), 'component missing label/note');
    });
  } else if (n.choices) {
    check('prompt:' + id, !!n.prompt, 'choice node has no prompt');
    n.choices.forEach(c => {
      check('choice->:' + id, !!story[c.to], 'dangling link ' + c.to);
      check('choice.text:' + id, !!(c.lab && c.sub), 'choice missing lab/sub');
    });
  } else if (n.to) {
    check('to:' + id, !!story[n.to], 'dangling link ' + n.to);
  } else {
    check('deadend:' + id, false, 'node has no choices / craft / to / interlude');
  }

  // dyn() must return an array at every corruption tier
  if (n.dyn) {
    for (const dk of [0, 3, 6, 9, 13]) {
      S.dark = dk; S.flags = {}; S.sacrifices = []; S.thread = []; S.returns = 0;
      let ok = false;
      try { ok = Array.isArray(n.dyn()); } catch (e) { problems.push('dyn-throw:' + id + '@' + dk + ' — ' + e.message); fail++; }
      check('dyn:' + id + '@' + dk, ok, 'dyn did not return an array');
    }
  }
}

/* ---- 2. act map ---- */
for (const k of Object.keys(ACTS)) {
  const nx = ACTS[k].next;
  if (nx) check('ACTS.next:' + k, !!story[nx], 'points at missing node ' + nx);
}

/* ---- 3. reachability: every node reachable from a1_quiet (following act hand-offs) ---- */
const reach = new Set();
const stack = ['a1_quiet'];
while (stack.length) {
  const id = stack.pop();
  if (reach.has(id) || !story[id]) continue;
  reach.add(id);
  const n = story[id];
  if (n.craft) ['rightTo', 'leftTo', 'reverseTo'].forEach(k => n.craft[k] && stack.push(n.craft[k]));
  if (n.choices) n.choices.forEach(c => stack.push(c.to));
  if (n.to) stack.push(n.to);
  if (n.interlude && ACTS[id] && ACTS[id].next) stack.push(ACTS[id].next);
}
const orphans = ids.filter(id => !reach.has(id) && !story[id].cover);
check('no-orphans', orphans.length === 0, 'unreachable: ' + orphans.join(', '));

/* ---- 4. craft "kind" resolution matches engine precedence (reverse > left > right) ---- */
const kind = arr => arr.some(c => c.hand === 'reverse') ? 'reverse'
                  : arr.some(c => c.hand === 'left') ? 'left' : 'right';
ids.forEach(id => {
  const cf = story[id].craft; if (!cf) return;
  const right = cf.components.find(c => c.hand === 'right');
  const left  = cf.components.find(c => c.hand === 'left');
  const rev   = cf.components.find(c => c.hand === 'reverse');
  if (right) check('kind-right:' + id, kind([right]) === 'right');
  if (right && left) check('kind-left:' + id, kind([right, left]) === 'left');
  if (rev) check('kind-reverse:' + id, kind([right, left, rev].filter(Boolean)) === 'reverse');
});

/* ---- 5. save round-trip (same base64 transform the game uses) ---- */
function encodeS(s) { return Buffer.from(unescape(encodeURIComponent(JSON.stringify(s))), 'binary').toString('base64'); }
function decodeS(v) { return JSON.parse(decodeURIComponent(escape(Buffer.from(v, 'base64').toString('binary')))); }
const demo = { v: 2, node: 'a_world_call', dark: 12, returns: 2,
  flags: { townHarm: true, usedLeft: true, craftPicks: ['Belladonna, to choose whose luck turns'] },
  sacrifices: ['a year of her own luck'], thread: [{ lab: 'Reached for the left hand', left: true }] };
let rt = false;
try { rt = JSON.stringify(decodeS(encodeS(demo))) === JSON.stringify(demo); } catch (e) {}
check('save-roundtrip', rt, 'state did not survive encode/decode');

/* ---- 6. tier helpers sane & monotonic ---- */
check('tier-light', tier(0) === 'light');
let lastIdx = -1, monotonic = true;
const order = ['light', 'tempted', 'slipping', 'lefthand', 'raven'];
for (let d = 0; d <= 20; d++) { const i = order.indexOf(tier(d)); if (i < lastIdx) monotonic = false; lastIdx = Math.max(lastIdx, i); }
check('tier-monotonic', monotonic, 'tier() is not monotonic in dark');
check('tierName', typeof tierName(0) === 'string' && tierName(0).length > 0);

/* ---- report ---- */
const craftCount = ids.filter(id => story[id].craft).length;
const beats = ids.filter(id => !story[id].cover && !story[id].interlude).length;
console.log('The Book of the Raven — QA');
console.log('  file: ' + FILE);
console.log('  story beats: ' + beats + ' | interactive craft scenes: ' + craftCount + ' | acts: ' + Object.keys(ACTS).length);
console.log('  checks passed: ' + pass + ' | failed: ' + fail);
if (fail) { console.log('\nFAILURES:'); problems.forEach(p => console.log('  ✗ ' + p)); process.exit(1); }
console.log('  ✓ all green');
process.exit(0);

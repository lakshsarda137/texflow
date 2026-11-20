import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeWorkflow, validateWorkflow, locate, planRun, renderTemplate,
  outputPath, countRendered, verifyRendered, normalizeRendered,
} from '../extension/lib/workflow.js';

const DOC = [
  '\\section{EDUCATION}',
  '  \\rsTitle{Example University} & \\rsLoc{Somewhere} \\\\',
  '  \\rsSub{B.S. Computer Science} & \\rsDate{May 2029 (Expected Graduation)} \\\\',
  '\\section{EXPERIENCE}',
  '  \\rsTitle{Acme} & \\rsDate{May 2026 -- Jul 2026} \\\\',
].join('\n');

const wf = (over = {}) => normalizeWorkflow({
  name: 'Class year',
  template: '\\rsDate{{{value}} (Expected Graduation)}',
  fileName: 'resume.pdf',
  variants: [
    { value: 'May 2028', folder: '~/Desktop/Apps/Junior' },
    { value: 'May 2029', folder: '~/Desktop/Apps/' },
  ],
  ...over,
});

const apply = (text, e) => text.slice(0, e.from) + e.insert + text.slice(e.to);

test('normalize fills defaults', () => {
  const w = normalizeWorkflow({ name: ' x ' });
  assert.equal(w.name, 'x');
  assert.equal(w.restore, true);
  assert.equal(w.verify, true);
  assert.deepEqual(w.variants, []);
  assert.ok(w.id);
});

test('valid workflow has no errors', () => {
  assert.deepEqual(validateWorkflow(wf()), []);
});

test('validation catches common mistakes', () => {
  const errs = validateWorkflow(wf({
    name: '', template: 'no placeholder', fileName: 'a/b.txt',
    variants: [{ value: 'A', folder: 'relative' }, { value: 'A', folder: '' }],
  }));
  const all = errs.join(' | ');
  assert.match(all, /name/);
  assert.match(all, /exactly once/);
  assert.match(all, /\.pdf/);
  assert.match(all, /must start with ~ or \//);
  assert.match(all, /listed twice/);
  assert.match(all, /Choose a folder/);
});

test('validation rejects bare placeholder and same-file collisions', () => {
  assert.match(validateWorkflow(wf({ template: '{{value}}' })).join(), /surrounding text/);
  const errs = validateWorkflow(wf({ variants: [
    { value: 'A', folder: '~/x' }, { value: 'B', folder: '~/x/' },
  ] }));
  assert.match(errs.join(), /same file/);
});

test('outputPath and renderTemplate', () => {
  assert.equal(outputPath('~/a/b/', 'r.pdf'), '~/a/b/r.pdf');
  assert.equal(renderTemplate('x{{value}}y', 'Q'), 'xQy');
});

test('locate finds the configured value', () => {
  const m = locate(DOC, wf());
  assert.equal(m.value, 'May 2029');
  assert.equal(m.line, 3);
});

test('locate falls back to any value and restores it', () => {
  const doc = DOC.replace('May 2029', 'Dec 2027');
  const plan = planRun(wf(), doc);
  assert.equal(plan.currentValue, 'Dec 2027');
  let t = doc;
  for (const s of plan.steps) if (s.edit) t = apply(t, s.edit);
  t = apply(t, plan.restore);
  assert.equal(t, doc);
});

test('locate errors when missing or ambiguous', () => {
  assert.throws(() => locate(DOC, wf({ template: '\\rsDate{{{value}} (Graduated)}' })), /Couldn't find/);
  assert.throws(() => locate(DOC + '\n' + DOC, wf()), /appears 2 times \(lines 3, 8\)/);
  assert.throws(() => locate(DOC, wf({ template: '\\rsDate{{{value}}}' })), /appears 2 times/);
});

test('locate does not span lines', () => {
  const doc = '\\rsDate{May\n2029 (Expected Graduation)}';
  assert.throws(() => locate(doc, wf()), /Couldn't find/);
});

test('plan runs the current value first, then others, then restores', () => {
  const plan = planRun(wf(), DOC);
  assert.equal(DOC.slice(plan.index, plan.index + plan.original.length), plan.original);
  assert.deepEqual(plan.steps.map((s) => s.value), ['May 2029', 'May 2028']);
  assert.equal(plan.steps[0].edit, null);
  assert.equal(plan.steps[0].path, '~/Desktop/Apps/resume.pdf');
  assert.equal(plan.steps[1].path, '~/Desktop/Apps/Junior/resume.pdf');

  let t = DOC;
  t = apply(t, plan.steps[1].edit);
  assert.match(t, /May 2028 \(Expected Graduation\)/);
  assert.equal(t.slice(plan.restore.from, plan.restore.to), plan.restore.expected);
  t = apply(t, plan.restore);
  assert.equal(t, DOC);
});

test('plan tracks span length when values differ in length', () => {
  const w = wf({ variants: [
    { value: 'Spring 2028', folder: '~/a' },
    { value: 'May 2029', folder: '~/b' },
    { value: 'Fall 2030 or later', folder: '~/c' },
  ] });
  const plan = planRun(w, DOC);
  let t = DOC;
  for (const s of plan.steps) {
    if (!s.edit) continue;
    assert.equal(t.slice(s.edit.from, s.edit.to), s.edit.expected);
    t = apply(t, s.edit);
    assert.ok(t.includes(renderTemplate(w.template, s.value)));
  }
  t = apply(t, plan.restore);
  assert.equal(t, DOC);
});

test('no restore when disabled or already back at original', () => {
  assert.equal(planRun(wf({ restore: false }), DOC).restore, null);
  const single = wf({ variants: [{ value: 'May 2029', folder: '~/a' }] });
  assert.equal(planRun(single, DOC).restore, null);
});

test('longest value wins when values overlap', () => {
  const w = wf({ template: '\\rsDate{{{value}})}', variants: [
    { value: 'May 2029 (Expected Graduation', folder: '~/a' },
    { value: 'May 2029', folder: '~/b' },
  ] });
  assert.equal(locate(DOC, w).value, 'May 2029 (Expected Graduation');
});

test('rendered-text helpers', () => {
  assert.equal(normalizeRendered('May 2026 -- Jul~2026'), 'May2026–Jul2026');
  assert.equal(normalizeRendered('\\textbf{R\\&D}'), 'R&D');
  const pdf = 'B.S. Computer Science May 2028 (Expected Graduation) Acme May 2026 – Jul 2026';
  assert.equal(countRendered(pdf, 'May 2028'), 1);
  assert.equal(countRendered(pdf, 'May 2026 -- Jul 2026'), 1);
  assert.equal(countRendered(pdf, ''), 0);
});

test('verifyRendered detects stale and missing output', () => {
  const old = 'May 2029 (Expected Graduation)';
  const neu = 'May 2028 (Expected Graduation)';
  assert.equal(verifyRendered({ before: old, after: neu, value: 'May 2028', edited: true }), null);
  assert.match(verifyRendered({ before: old, after: old, value: 'May 2028', edited: true }), /doesn't show/);
  assert.match(verifyRendered({ before: neu, after: neu, value: 'May 2028', edited: true }), /didn't change/);
  assert.equal(verifyRendered({ before: null, after: old, value: 'May 2029', edited: false }), null);
});

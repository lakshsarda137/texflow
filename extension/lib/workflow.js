// Pure workflow logic: no chrome.* APIs, so it can be unit-tested in Node.

export const PLACEHOLDER = '{{value}}';

const uid = () =>
  (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).slice(0, 13);

export function newWorkflow() {
  return normalizeWorkflow({
    name: '',
    template: '',
    fileName: 'output.pdf',
    variants: [
      { value: '', folder: '' },
      { value: '', folder: '' },
    ],
  });
}

/** Fill defaults so older/hand-written configs always have every field. */
export function normalizeWorkflow(raw = {}) {
  return {
    id: raw.id || uid(),
    name: String(raw.name ?? '').trim(),
    template: String(raw.template ?? ''),
    fileName: String(raw.fileName ?? 'output.pdf').trim(),
    restore: raw.restore !== false,
    verify: raw.verify !== false,
    variants: (Array.isArray(raw.variants) ? raw.variants : []).map((v) => ({
      value: String(v?.value ?? ''),
      folder: String(v?.folder ?? '').trim(),
    })),
  };
}

/** Returns a list of human-readable problems; empty means valid. */
export function validateWorkflow(wf) {
  const errors = [];
  if (!wf.name) errors.push('Give the workflow a name.');

  const count = wf.template.split(PLACEHOLDER).length - 1;
  if (count !== 1) {
    errors.push(`"Text to change" must contain ${PLACEHOLDER} exactly once (found ${count}).`);
  } else {
    const [before, after] = wf.template.split(PLACEHOLDER);
    if (!before.trim() && !after.trim()) {
      errors.push(`Add some surrounding text around ${PLACEHOLDER} so texflow can find the right spot.`);
    }
  }
  if (wf.template.includes('\n')) errors.push('"Text to change" must be on a single line.');

  if (!/^[^/\\]+\.pdf$/i.test(wf.fileName)) {
    errors.push('File name must end in .pdf and must not contain slashes.');
  }

  if (wf.variants.length === 0) errors.push('Add at least one value.');
  const seen = new Set();
  wf.variants.forEach((v, i) => {
    const n = i + 1;
    if (!v.value.trim()) errors.push(`Value ${n} is empty.`);
    if (v.value.includes('\n')) errors.push(`Value ${n} must be on a single line.`);
    if (seen.has(v.value)) errors.push(`Value "${v.value}" is listed twice.`);
    seen.add(v.value);
    if (!v.folder) errors.push(`Choose a folder for value ${n}.`);
    else if (!/^(~|\/)/.test(v.folder)) errors.push(`Folder for value ${n} must start with ~ or /.`);
  });

  const paths = wf.variants.map((v) => outputPath(v.folder, wf.fileName));
  if (new Set(paths).size !== paths.length) {
    errors.push('Two values save to the same file; give each value its own folder.');
  }
  return errors;
}

export function outputPath(folder, fileName) {
  return `${folder.replace(/\/+$/, '')}/${fileName}`;
}

export function renderTemplate(template, value) {
  return template.split(PLACEHOLDER).join(value);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function regexFor(template, valuePattern) {
  const [before, after] = template.split(PLACEHOLDER);
  return new RegExp(`${escapeRe(before)}(${valuePattern})${escapeRe(after)}`, 'g');
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

function allMatches(text, re) {
  const out = [];
  for (const m of text.matchAll(re)) {
    out.push({ index: m.index, length: m[0].length, value: m[1], line: lineOf(text, m.index) });
  }
  return out;
}

/**
 * Find the single place in `text` that the workflow controls.
 * First looks for the template filled with one of the configured values; if
 * that finds nothing, accepts any single-line value (so a doc that currently
 * says something else still works, and gets restored afterwards).
 */
export function locate(text, wf) {
  const values = [...wf.variants.map((v) => v.value)].sort((a, b) => b.length - a.length);
  const exact = allMatches(text, regexFor(wf.template, values.map(escapeRe).join('|')));
  const found = exact.length ? exact : allMatches(text, regexFor(wf.template, '[^\\n]*?'));

  if (found.length === 1) return found[0];
  if (found.length === 0) {
    throw new Error(
      `Couldn't find "${renderTemplate(wf.template, '…')}" in the open file. ` +
        'Check the text matches your .tex source exactly, and that the right file is open.'
    );
  }
  throw new Error(
    `"${renderTemplate(wf.template, '…')}" appears ${found.length} times ` +
      `(lines ${found.map((f) => f.line).join(', ')}). Add more surrounding text so it matches only one place.`
  );
}

/**
 * Turn a workflow + current document into concrete steps. The value already in
 * the document runs first (no edit needed), then the rest in configured order.
 * Every edit replaces the same span, whose length changes as values change.
 */
export function planRun(wf, text) {
  const match = locate(text, wf);
  const original = text.slice(match.index, match.index + match.length);

  const ordered = [...wf.variants].sort(
    (a, b) => (b.value === match.value) - (a.value === match.value)
  );

  let current = original;
  const steps = ordered.map((v) => {
    const insert = renderTemplate(wf.template, v.value);
    const edit =
      insert === current ? null : { from: match.index, to: match.index + current.length, expected: current, insert };
    current = insert;
    return { value: v.value, path: outputPath(v.folder, wf.fileName), edit };
  });

  const restore =
    wf.restore && current !== original
      ? { from: match.index, to: match.index + current.length, expected: current, insert: original }
      : null;

  return { line: match.line, currentValue: match.value, original, steps, restore };
}

/** Collapse a LaTeX-ish value into the text a PDF viewer would show. */
export function normalizeRendered(s) {
  return s
    .replace(/---/g, '—')
    .replace(/--/g, '–')
    .replace(/``|''/g, '"')
    .replace(/~/g, ' ')
    .replace(/\\([&%$#_])/g, '$1')
    .replace(/\\[a-zA-Z]+\*?/g, '')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, '');
}

export function countRendered(pdfText, value) {
  const hay = normalizeRendered(pdfText);
  const needle = normalizeRendered(value);
  if (!needle) return 0;
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

/**
 * Did the compiled PDF pick up the change? For an edited step the new value
 * must appear more often than in the previous PDF; otherwise it must appear.
 */
export function verifyRendered({ before, after, value, edited }) {
  const now = countRendered(after, value);
  if (now === 0) return `The compiled PDF doesn't show "${value}".`;
  if (edited && before != null && now <= countRendered(before, value)) {
    return `The PDF didn't change after setting "${value}"; the edit may not have reached the compiler.`;
  }
  return null;
}

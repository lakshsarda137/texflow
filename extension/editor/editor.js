import { newWorkflow, normalizeWorkflow, validateWorkflow, PLACEHOLDER } from '../lib/workflow.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
let wf = null;
let isNew = true;
let overleafTabId = params.has('tab') ? Number(params.get('tab')) : null;

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c != null) node.append(c);
  return node;
}

function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload }).then((r) => {
    if (!r?.ok) throw new Error(r?.error ?? 'No response');
    return r.value;
  });
}

/** Prefer the tab the popup was opened from; otherwise the most recent Overleaf project tab. */
async function findOverleafTab() {
  if (overleafTabId != null) {
    const tab = await chrome.tabs.get(overleafTabId).catch(() => null);
    if (tab?.url && /overleaf\.com\/project\//.test(tab.url)) return overleafTabId;
  }
  const tabs = await chrome.tabs.query({ url: ['https://www.overleaf.com/project/*', 'https://overleaf.com/project/*'] });
  tabs.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
  overleafTabId = tabs[0]?.id ?? null;
  if (overleafTabId == null) throw new Error('Open your project in Overleaf in another tab first.');
  return overleafTabId;
}

function readForm() {
  wf.name = $('name').value.trim();
  wf.template = $('template').value;
  wf.fileName = $('file-name').value.trim();
  wf.restore = $('restore').checked;
  wf.verify = $('verify').checked;
  wf.variants = [...document.querySelectorAll('.variant')].map((row) => ({
    value: row.querySelector('.value').value,
    folder: row.querySelector('.folder').value.trim(),
  }));
  return normalizeWorkflow(wf);
}

const folderTimers = new WeakMap();
function checkFolder(row) {
  const input = row.querySelector('.folder');
  const mark = row.querySelector('.folder-state');
  clearTimeout(folderTimers.get(row));
  folderTimers.set(row, setTimeout(async () => {
    const path = input.value.trim();
    if (!path) { mark.textContent = ''; return; }
    try {
      const r = await send('checkDir', { path });
      mark.textContent = r.exists ? '✓' : '✕';
      mark.className = `folder-state ${r.exists ? 'state-done' : 'state-error'}`;
      mark.title = r.exists ? r.path : `Folder not found: ${r.path}`;
    } catch (e) {
      mark.textContent = '?';
      mark.className = 'folder-state muted';
      mark.title = e.message;
    }
  }, 250));
}

function variantRow(v = { value: '', folder: '' }) {
  const value = el('input', { type: 'text', className: 'value', placeholder: 'Value, e.g. May 2028', value: v.value, autocomplete: 'off' });
  const folder = el('input', { type: 'text', className: 'folder code', placeholder: '~/Desktop/Applications/Junior', value: v.folder, spellcheck: false, autocomplete: 'off' });
  const browse = el('button', { textContent: 'Browse…' });
  const state = el('span', { className: 'folder-state' });
  const remove = el('button', { className: 'link danger', textContent: 'Remove', title: 'Remove this value' });
  const row = el('div', { className: 'variant' }, value, folder, browse, state, remove);

  folder.addEventListener('input', () => checkFolder(row));
  browse.addEventListener('click', async () => {
    browse.disabled = true;
    try {
      const r = await send('chooseFolder', { start: folder.value.trim() || '~/Desktop' });
      if (r.path) { folder.value = r.path; checkFolder(row); }
    } catch (e) {
      showErrors([e.message]);
    } finally {
      browse.disabled = false;
    }
  });
  remove.addEventListener('click', () => row.remove());
  if (v.folder) checkFolder(row);
  return row;
}

function render() {
  $('heading').textContent = isNew ? 'New workflow' : `Edit “${wf.name || 'workflow'}”`;
  document.title = `texflow · ${isNew ? 'New workflow' : wf.name}`;
  $('name').value = wf.name;
  $('template').value = wf.template;
  $('file-name').value = wf.fileName;
  $('restore').checked = wf.restore;
  $('verify').checked = wf.verify;
  $('variants').replaceChildren(
    el('div', { className: 'variants-head' }, el('span', { textContent: 'Value' }), el('span', { textContent: 'Folder' })),
    ...wf.variants.map(variantRow));
  $('delete').classList.toggle('hidden', isNew);
}

function showErrors(errors) {
  const box = $('errors');
  box.replaceChildren(...errors.map((e) => el('li', { textContent: e })));
  box.classList.toggle('hidden', errors.length === 0);
}

function showProbe(kind, text) {
  const box = $('probe-result');
  box.textContent = text;
  box.className = `notice small ${kind}`;
}

async function save() {
  const next = readForm();
  const errors = validateWorkflow(next);
  showErrors(errors);
  if (errors.length) return;
  const { workflows = [] } = await chrome.storage.local.get('workflows');
  const i = workflows.findIndex((w) => w.id === next.id);
  if (i >= 0) workflows[i] = next; else workflows.push(next);
  await chrome.storage.local.set({ workflows });
  wf = next;
  isNew = false;
  history.replaceState(null, '', `?id=${encodeURIComponent(wf.id)}${overleafTabId != null ? `&tab=${overleafTabId}` : ''}`);
  render();
  $('saved').textContent = 'Saved.';
  setTimeout(() => { $('saved').textContent = ''; }, 2000);
}

let deleteArmed = false;
async function remove() {
  if (!deleteArmed) {
    deleteArmed = true;
    $('delete').textContent = 'Click again to delete';
    setTimeout(() => { deleteArmed = false; $('delete').textContent = 'Delete'; }, 4000);
    return;
  }
  const { workflows = [] } = await chrome.storage.local.get('workflows');
  await chrome.storage.local.set({ workflows: workflows.filter((w) => w.id !== wf.id) });
  window.close();
}

async function init() {
  const { workflows = [] } = await chrome.storage.local.get('workflows');
  const existing = params.get('id') && workflows.find((w) => w.id === params.get('id'));
  wf = existing ? normalizeWorkflow(existing) : newWorkflow();
  isNew = !existing;
  render();

  $('add-variant').addEventListener('click', () => $('variants').append(variantRow()));
  $('save').addEventListener('click', save);
  $('cancel').addEventListener('click', () => window.close());
  $('delete').addEventListener('click', remove);

  $('from-cursor').addEventListener('click', async () => {
    try {
      const { line } = await send('cursorLine', { tabId: await findOverleafTab() });
      if (!line) throw new Error('Click on the line you want in the Overleaf editor first.');
      $('template').value = line;
      $('template').focus();
      showProbe('', 'Now select the part that changes (e.g. “May 2029”) and click “Make selection {{value}}”.');
    } catch (e) {
      showProbe('bad', e.message);
    }
  });

  $('mark-value').addEventListener('click', () => {
    const t = $('template');
    const { selectionStart: s, selectionEnd: e, value } = t;
    if (s === e) { showProbe('bad', 'Select the part of the text that changes first.'); return; }
    const picked = value.slice(s, e);
    t.value = value.slice(0, s) + PLACEHOLDER + value.slice(e);
    const firstEmpty = [...document.querySelectorAll('.variant .value')].find((i) => !i.value);
    if (firstEmpty) firstEmpty.value = picked;
    showProbe('ok', `“${picked}” is now {{value}}. Add the other values below.`);
  });

  $('probe').addEventListener('click', async () => {
    try {
      const tabId = await findOverleafTab();
      const r = await send('probe', { tabId, workflow: readForm() });
      showProbe('ok', `Found on line ${r.line} of ${r.docName}. It currently says “${r.currentValue}”.`);
    } catch (e) {
      showProbe('bad', e.message);
    }
  });

  try {
    const r = await send('checkDir', { path: '~' });
    $('host-pill').textContent = r.exists ? 'Helper ready' : 'Helper error';
    $('host-pill').className = 'pill ok';
  } catch (e) {
    $('host-pill').textContent = 'Helper missing';
    $('host-pill').className = 'pill bad';
    $('host-pill').title = e.message;
  }
}

init();

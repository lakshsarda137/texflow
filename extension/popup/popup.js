import { normalizeWorkflow, outputPath, validateWorkflow } from '../lib/workflow.js';

const $ = (id) => document.getElementById(id);
let tabId = null;
let tabOk = false;
let running = false;

function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, tabId, ...payload }).then((r) => {
    if (!r?.ok) throw new Error(r?.error ?? 'No response');
    return r.value;
  });
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c != null) node.append(c);
  return node;
}

function openEditor(id) {
  const params = new URLSearchParams();
  if (id) params.set('id', id);
  if (tabId != null) params.set('tab', String(tabId));
  chrome.tabs.create({ url: chrome.runtime.getURL(`editor/editor.html?${params}`) });
  window.close();
}

async function renderList() {
  const { workflows = [] } = await chrome.storage.local.get('workflows');
  const list = workflows.map(normalizeWorkflow);
  $('list').replaceChildren();
  $('empty').classList.toggle('hidden', list.length > 0);

  for (const wf of list) {
    const problems = validateWorkflow(wf);
    const run = el('button', { className: 'primary', textContent: 'Run' });
    run.disabled = !tabOk || running || problems.length > 0;
    run.title = problems[0] ?? (tabOk ? 'Compile every value and save the PDFs' : 'Open an Overleaf project first');
    run.addEventListener('click', async () => {
      run.disabled = true;
      try {
        await send('run', { workflowId: wf.id });
      } catch (e) {
        showRun({ workflowName: wf.name, status: 'error', message: e.message, steps: [] });
      }
    });
    const edit = el('button', { textContent: 'Edit' });
    edit.addEventListener('click', () => openEditor(wf.id));

    const targets = el('div', { className: 'targets' });
    for (const v of wf.variants) {
      targets.append(el('div', { className: 'ellipsis' },
        el('b', { textContent: v.value || '(empty)' }), ' → ', outputPath(v.folder, wf.fileName)));
    }

    $('list').append(el('li', { className: 'wf' },
      el('div', { className: 'row' },
        el('div', { className: 'name grow ellipsis', textContent: wf.name || 'Untitled' }), edit, run),
      el('div', { className: 'template ellipsis', textContent: wf.template, title: wf.template }),
      targets,
      problems.length ? el('div', { className: 'small state-error', textContent: problems[0] }) : null));
  }
}

const ICON = { pending: '○', editing: '◐', compiling: '◐', saving: '◐', done: '✓', error: '✕' };

function showRun(run) {
  if (!run) { $('run').classList.add('hidden'); return; }
  $('run').classList.remove('hidden');
  $('run-title').textContent = run.workflowName ?? 'Run';
  $('run-steps').replaceChildren(...(run.steps ?? []).map((s) => {
    const cls = s.state === 'done' ? 'state-done' : s.state === 'error' ? 'state-error' : s.state === 'pending' ? 'muted' : 'state-active';
    return el('li', {},
      el('span', { className: `status-icon ${cls}`, textContent: ICON[s.state] ?? '○' }),
      el('div', { className: 'grow' },
        el('div', {}, el('span', { className: 'value', textContent: s.value }), ' ',
          el('span', { className: 'detail', textContent: s.detail ?? '' })),
        el('div', { className: 'path', textContent: s.savedPath ?? s.path })));
  }));

  const restoreText = {
    pending: '', running: 'Restoring original text…', done: 'Original text restored.',
    skipped: 'Original text unchanged.', error: `Couldn't restore original text: ${run.restoreError ?? ''}`, off: '',
  }[run.restore] ?? '';
  $('run-restore').textContent = restoreText;
  $('run-restore').className = `small ${run.restore === 'error' ? 'state-error' : 'muted'}`;

  const msg = $('run-message');
  msg.textContent = run.message ?? '';
  msg.className = `notice small ${run.status === 'error' ? 'bad' : run.status === 'done' ? 'ok' : ''}`;
  $('run-dismiss').classList.toggle('hidden', run.status === 'running');

  const wasRunning = running;
  running = run.status === 'running';
  if (wasRunning !== running) renderList();
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? null;

  $('new').addEventListener('click', () => openEditor(null));
  $('run-dismiss').addEventListener('click', async () => {
    await chrome.storage.session.remove('run');
    showRun(null);
  });

  const { run } = await chrome.storage.session.get('run');
  showRun(run);
  await renderList();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && 'run' in changes) showRun(changes.run.newValue);
    if (area === 'local' && 'workflows' in changes) renderList();
  });

  try {
    const status = await send('status');
    const pill = $('host-pill');
    pill.textContent = status.host.ok ? 'Helper ready' : 'Helper missing';
    pill.className = `pill ${status.host.ok ? 'ok' : 'bad'}`;
    pill.title = status.host.ok ? `Native helper v${status.host.version}` : status.host.error;
    $('host-help').classList.toggle('hidden', status.host.ok);

    tabOk = status.tab.ok;
    const line = $('tab-line');
    if (status.tab.ok) {
      line.textContent = `Will run on ${status.tab.docName} in “${status.tab.projectName}”` +
        (status.tab.hasPreview ? '' : ' — PDF preview is hidden');
      line.className = 'notice small ok';
    } else {
      line.textContent = status.tab.error;
      line.className = 'notice small';
    }
    running = status.running;
  } catch (e) {
    $('tab-line').textContent = e.message;
  }
  await renderList();
}

init();

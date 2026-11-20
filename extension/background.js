import { normalizeWorkflow, validateWorkflow, planRun, locate, verifyRendered } from './lib/workflow.js';

const HOST = 'com.texflow.host';
const OVERLEAF_PROJECT = /^https:\/\/(www\.)?overleaf\.com\/project\/[0-9a-f]{24}/i;

// ---------------------------------------------------------------- storage

async function getWorkflows() {
  const { workflows } = await chrome.storage.local.get('workflows');
  return (workflows ?? []).map(normalizeWorkflow);
}

/**
 * First install: load personal workflows from extension/local-workflows.json
 * if that (git-ignored) file exists; otherwise start empty.
 */
async function seedWorkflows() {
  const { workflows } = await chrome.storage.local.get('workflows');
  if (Array.isArray(workflows)) return;
  let seeded = [];
  try {
    const res = await fetch(chrome.runtime.getURL('local-workflows.json'));
    if (res.ok) {
      const data = await res.json();
      seeded = (Array.isArray(data) ? data : data.workflows ?? []).map(normalizeWorkflow);
    }
  } catch {
    // no local seed file — that's fine
  }
  await chrome.storage.local.set({ workflows: seeded });
}

chrome.runtime.onInstalled.addListener(seedWorkflows);
chrome.runtime.onStartup.addListener(seedWorkflows);

// ---------------------------------------------------------- native helper

function native(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(HOST, { id: crypto.randomUUID(), ...message }, (res) => {
      const err = chrome.runtime.lastError;
      if (err) {
        const notInstalled = /not found|forbidden|not allowed|exited/i.test(err.message);
        reject(new Error(notInstalled
          ? 'The texflow helper is not installed. Run native-host/install.sh, then reload the extension.'
          : `Helper error: ${err.message}`));
        return;
      }
      if (!res?.ok) reject(new Error(res?.error ?? 'The helper returned no response.'));
      else resolve(res);
    });
  });
}

// ------------------------------------------------------------- page agent

async function call(tabId, method, arg = null) {
  await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: ['agent/overleaf-agent.js'] });
  const [frame] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [method, arg],
    func: async (m, a) => {
      try {
        return { ok: true, value: await window.__texflow[m](a) };
      } catch (e) {
        return { ok: false, error: String(e?.message ?? e) };
      }
    },
  });
  if (!frame?.result) throw new Error('No response from the Overleaf tab. Was it closed or reloaded?');
  if (!frame.result.ok) throw new Error(frame.result.error);
  return frame.result.value;
}

async function overleafTab(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.url || !OVERLEAF_PROJECT.test(tab.url)) {
    throw new Error('Open an Overleaf project in this tab first.');
  }
  return tab;
}

async function editorInfo(tabId) {
  await overleafTab(tabId);
  const info = await call(tabId, 'info');
  if (!info.ready) throw new Error('The Overleaf editor is still loading. Try again in a moment.');
  return info;
}

const folderOf = (path) => path.replace(/\/[^/]+$/, '') || '/';

// -------------------------------------------------------------------- run

let activeRun = null;

async function setRun(state) {
  await chrome.storage.session.set({ run: structuredClone(state) });
}

function notify(title, message) {
  chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon128.png', title, message, priority: 0 });
}

async function run(tabId, workflowId) {
  if (activeRun) throw new Error('A run is already in progress.');
  const wf = (await getWorkflows()).find((w) => w.id === workflowId);
  if (!wf) throw new Error('Workflow not found.');
  const problems = validateWorkflow(wf);
  if (problems.length) throw new Error(problems[0]);

  const state = {
    workflowId, workflowName: wf.name, tabId, status: 'running', message: 'Starting…',
    steps: [], restore: wf.restore ? 'pending' : 'off', startedAt: Date.now(), finishedAt: null,
  };
  activeRun = state;
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20_000);
  const update = (patch) => setRun(Object.assign(state, patch));
  const stepUpdate = (i, patch) => { Object.assign(state.steps[i], patch); return setRun(state); };

  let plan = null;
  let docId = null;
  let span = null; // text currently occupying the controlled span

  try {
    await update({ message: 'Checking the helper…' });
    await native({ type: 'ping' });

    await update({ message: 'Reading the open file…' });
    const info = await editorInfo(tabId);
    docId = info.docId;
    if (wf.verify && !info.hasPreview) {
      throw new Error('Show the PDF preview in Overleaf so texflow can check each PDF (or turn off "Check each PDF" for this workflow).');
    }
    plan = planRun(wf, info.text);
    span = plan.original;

    // Fail before touching the document if any destination is missing.
    for (const step of plan.steps) {
      const dir = await native({ type: 'checkDir', path: folderOf(step.path) });
      if (!dir.exists) throw new Error(`Folder does not exist: ${dir.path}`);
    }

    state.docName = info.docName;
    state.line = plan.line;
    state.steps = plan.steps.map((s) => ({ value: s.value, path: s.path, state: 'pending', detail: '' }));
    await update({ message: `Found on line ${plan.line} of ${info.docName}` });

    for (const [i, step] of plan.steps.entries()) {
      if (step.edit) {
        await stepUpdate(i, { state: 'editing', detail: `Setting "${step.value}"` });
        await call(tabId, 'applyEdit', { ...step.edit, docId });
        span = step.edit.insert;
      }

      await stepUpdate(i, { state: 'compiling', detail: 'Compiling…' });
      const out = await call(tabId, 'compile', { waitForChange: Boolean(step.edit) });

      if (wf.verify) {
        if (out.after == null) throw new Error('Could not read the PDF preview to check it.');
        const problem = verifyRendered({ before: out.before, after: out.after, value: step.value, edited: Boolean(step.edit) });
        if (problem) throw new Error(problem);
      }

      await stepUpdate(i, { state: 'saving', detail: 'Saving…' });
      const pdf = await call(tabId, 'fetchPdf', { downloadUrl: out.downloadUrl });
      const saved = await native({ type: 'save', path: step.path, data: pdf.data, overwrite: true });
      await stepUpdate(i, { state: 'done', detail: `Saved ${Math.round(saved.bytes / 1024)} KB`, savedPath: saved.path });
    }
    await update({ status: 'done', message: `Saved ${plan.steps.length} PDF${plan.steps.length === 1 ? '' : 's'}.` });
  } catch (e) {
    const i = state.steps.findIndex((s) => s.state !== 'done' && s.state !== 'pending');
    if (i >= 0) state.steps[i].state = 'error';
    await update({ status: 'error', message: String(e?.message ?? e) });
  } finally {
    if (plan && span !== plan.original && wf.restore) {
      try {
        await update({ restore: 'running' });
        await call(tabId, 'applyEdit', {
          from: plan.index, to: plan.index + span.length, expected: span, insert: plan.original, docId,
        });
        await update({ restore: 'done' });
        await call(tabId, 'compile', { settleMs: 1000 }).catch(() => {});
      } catch (e) {
        await update({ restore: 'error', restoreError: String(e?.message ?? e) });
      }
    } else if (state.restore === 'pending') {
      await update({ restore: 'skipped' });
    }
    clearInterval(keepAlive);
    await update({ finishedAt: Date.now() });
    activeRun = null;

    if (state.status === 'done') notify(`texflow: ${wf.name}`, state.message);
    else notify(`texflow: ${wf.name} failed`, state.message);
  }
}

// --------------------------------------------------------------- messages

const handlers = {
  async status({ tabId }) {
    const host = await native({ type: 'ping' }).then((r) => ({ ok: true, version: r.version }), (e) => ({ ok: false, error: e.message }));
    let tab = null;
    try {
      const info = await editorInfo(tabId);
      tab = { ok: true, docName: info.docName, projectName: info.projectName, hasPreview: info.hasPreview };
    } catch (e) {
      tab = { ok: false, error: e.message };
    }
    return { host, tab, running: Boolean(activeRun) };
  },

  async probe({ tabId, workflow }) {
    const info = await editorInfo(tabId);
    const m = locate(info.text, normalizeWorkflow(workflow));
    return { line: m.line, currentValue: m.value, docName: info.docName };
  },

  async cursorLine({ tabId }) {
    const info = await editorInfo(tabId);
    return { line: info.cursorLine?.trim() ?? '' };
  },

  async checkDir({ path }) {
    return native({ type: 'checkDir', path });
  },

  async run({ tabId, workflowId }) {
    if (activeRun) throw new Error('A run is already in progress.');
    // Fire and forget: progress is published to chrome.storage.session.
    run(tabId, workflowId).catch(async (e) => {
      await setRun({ workflowId, status: 'error', message: e.message, steps: [], restore: 'off', startedAt: Date.now(), finishedAt: Date.now() });
    });
    return { started: true };
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  handler(msg).then(
    (value) => sendResponse({ ok: true, value }),
    (e) => sendResponse({ ok: false, error: String(e?.message ?? e) })
  );
  return true; // keep the channel open for the async response
});

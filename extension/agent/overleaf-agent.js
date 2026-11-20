// Injected into the Overleaf editor page (MAIN world) by the service worker.
// Exposes window.__texflow with small, single-purpose operations; all planning
// happens in the extension. Relies on Overleaf internals observed in the live
// editor: window.overleaf.unstable.store ('editor.view' is the CodeMirror 6
// EditorView), the Recompile button (.compile-button) and the PDF.js text
// layer in the preview pane.
(() => {
  if (window.__texflow?.version === 1) return;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function store() {
    const s = window.overleaf?.unstable?.store;
    if (!s) throw new Error('This page does not look like the Overleaf editor.');
    return s;
  }

  function view() {
    const v = store().get('editor.view');
    if (!v?.state?.doc) throw new Error('The Overleaf editor is not ready yet.');
    return v;
  }

  function meta(name) {
    return document.querySelector(`meta[name="${name}"]`)?.content ?? '';
  }

  function compileButton() {
    return document.querySelector('button.compile-button');
  }

  function isCompiling() {
    const b = compileButton();
    return !b || b.getAttribute('data-ol-loading') === 'true' || b.disabled;
  }

  function pdfText() {
    const layers = document.querySelectorAll('.pdf-viewer .textLayer, .textLayer');
    if (!layers.length) return null;
    return [...new Set(layers)].map((l) => l.textContent).join(' ');
  }

  async function waitFor(fn, timeoutMs, what) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(250);
    }
    throw new Error(`Timed out waiting for ${what}.`);
  }

  function info() {
    const s = window.overleaf?.unstable?.store;
    const v = s?.get('editor.view');
    const ready = Boolean(v?.state?.doc);
    let cursorLine = null;
    if (ready) {
      const head = v.state.selection.main.head;
      cursorLine = v.state.doc.lineAt(head).text;
    }
    return {
      ready,
      projectId: meta('ol-project_id'),
      projectName: meta('ol-projectName'),
      docId: s?.get('editor.open_doc_id') ?? null,
      docName: s?.get('editor.open_doc_name') ?? null,
      text: ready ? v.state.doc.toString() : null,
      cursorLine,
      hasPreview: pdfText() !== null,
    };
  }

  /** Replace [from, to) only if it still holds `expected` (guards against concurrent edits). */
  function applyEdit({ from, to, expected, insert, docId }) {
    const v = view();
    const openDoc = store().get('editor.open_doc_id');
    if (docId && openDoc !== docId) {
      throw new Error('A different file was opened mid-run. Re-open the original file and run again.');
    }
    const actual = v.state.doc.sliceString(from, to);
    if (actual !== expected) {
      throw new Error('The document changed while texflow was running. Nothing else was modified.');
    }
    v.dispatch({ changes: { from, to, insert }, userEvent: 'input.texflow' });
    return { line: v.state.doc.lineAt(from).number };
  }

  /**
   * Click Recompile exactly like the user would, and capture Overleaf's own
   * /compile response by briefly wrapping fetch. Optionally waits for the PDF
   * preview text to change so the caller can verify the new output.
   */
  async function compile({ settleMs = 1500, timeoutMs = 120000, waitForChange = false } = {}) {
    await sleep(settleMs); // let the edit reach Overleaf's servers before compiling
    await waitFor(() => !isCompiling(), timeoutMs, 'a running compile to finish');

    const before = pdfText();
    const original = window.fetch;
    let result = null;
    let failure = null;
    window.fetch = async function (...args) {
      const res = await original.apply(this, args);
      try {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url ?? '';
        if (/\/project\/[^/]+\/compile(\?|$)/.test(url)) {
          res.clone().json().then((j) => { result = j; }, (e) => { failure = e; });
        }
      } catch (e) {
        failure = e;
      }
      return res;
    };

    try {
      compileButton().click();
      await waitFor(() => result || failure, timeoutMs, 'Overleaf to compile');
    } finally {
      window.fetch = original;
    }
    if (failure) throw new Error(`Could not read the compile result: ${failure.message ?? failure}`);
    if (result.status !== 'success') {
      const hint = result.status === 'failure' ? ' (LaTeX errors — check the logs in Overleaf)' : '';
      throw new Error(`Overleaf compile ended with status "${result.status}"${hint}.`);
    }
    const pdf = (result.outputFiles || []).find((f) => f.path === 'output.pdf');
    if (!pdf) throw new Error('Compile succeeded but produced no PDF.');

    let after = null;
    if (before !== null) {
      try {
        after = waitForChange
          ? await waitFor(() => { const t = pdfText(); return t && t !== before ? t : null; }, 20000, 'the PDF preview to update')
          : (await sleep(1500), pdfText());
      } catch {
        after = pdfText();
      }
    }

    const params = new URLSearchParams({ popupDownload: 'true' });
    if (result.compileGroup) params.set('compileGroup', result.compileGroup);
    if (result.clsiServerId) params.set('clsiserverid', result.clsiServerId);
    return {
      build: pdf.build,
      downloadUrl: `/download/project/${meta('ol-project_id')}/build/${pdf.build}/output/output.pdf?${params}`,
      before,
      after,
    };
  }

  async function fetchPdf({ downloadUrl }) {
    const res = await fetch(downloadUrl, { credentials: 'include' });
    if (!res.ok) throw new Error(`PDF download failed (HTTP ${res.status}).`);
    const blob = await res.blob();
    const dataUrl = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
    const data = String(dataUrl).split(',')[1] ?? '';
    if (!atob(data.slice(0, 8)).startsWith('%PDF-')) throw new Error('Downloaded file is not a PDF.');
    return { data, bytes: blob.size };
  }

  window.__texflow = { version: 1, info, applyEdit, compile, fetchPdf };
})();

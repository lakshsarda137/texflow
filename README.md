# texflow

A Chrome extension that turns one Overleaf document into several PDFs and files
each one in the right folder on your Mac.

You define a **workflow**: one piece of text in your `.tex` source that changes,
plus a list of values. Each value has its own folder. When you click **Run**,
texflow:

1. finds that text in the file open in Overleaf (it must match exactly one place),
2. for each value: sets the text, clicks Recompile, checks the PDF preview shows
   the new value, downloads the PDF and saves it to that value's folder,
3. puts the original text back.

Nothing else in the document is touched. Workflows aren't tied to a project. They
run on whichever Overleaf project and file is open in the current tab.

### Example

Same document, different class year, different folder:

| Text to change | `\rsDate{{{value}} (Expected Graduation)}` |
| --- | --- |
| `May 2028` | `~/Desktop/Applications/Junior/resume.pdf` |
| `May 2029` | `~/Desktop/Applications/resume.pdf` |

## Install

Requirements: macOS, Google Chrome 116+ (Brave, Edge, Arc and Chromium also work), and `python3`.

1. **Clone**

   ```sh
   git clone https://github.com/lakshsarda137/texflow.git
   ```

2. **Install the helper.** Chrome extensions can only save into `~/Downloads`, so a tiny
   Python script (standard library only) does the final write.

   ```sh
   sh texflow/native-host/install.sh
   ```

   The script copies the helper to `~/Library/Application Support/texflow/`
   and registers it with your browsers. Run `native-host/uninstall.sh` to remove it.

3. **Load the extension.** Open `chrome://extensions`, turn on **Developer mode**,
   click **Load unpacked**, and choose the `texflow/extension` folder.
   The extension ID is fixed (`pfbfelhdpdmgifcfcpdapkpgfjphefcn`), so the helper recognizes it.

4. Pin texflow to the toolbar.

## Use

1. Open your project in Overleaf, with the file you want to change open in the editor
   and the PDF preview visible.
2. Click the texflow icon, then **+ New workflow**. The editor opens in a new tab:
   - **Text to change**: click the line in Overleaf, then **Use line at cursor in Overleaf**.
     Select the part that changes and click **Make selection {{value}}**.
     Trim the line down to something unique (e.g. `\rsDate{{{value}} (Expected Graduation)}`).
     **Test on open file** confirms it matches exactly one place.
   - **Values**: one row per value, each with a folder (type it or click **Browse…**).
     A ✓ appears when the folder exists.
   - **PDF file name**: the name each PDF is saved under. Existing files are replaced.
3. Back in Overleaf, click the texflow icon and press **Run**. Progress shows in
   the popup, and a notification appears when it finishes.

### Options

- **Put the original text back when done** (on by default). After the run, the
  document reads exactly as it did before.
- **Check each PDF shows its value** (on by default). Before saving, texflow reads
  the rendered text in Overleaf's PDF preview and confirms the new value is there
  and the PDF actually changed. Turn this off if your value is mostly LaTeX
  commands that don't appear as plain text.

### Preloading your own workflows

Put a `local-workflows.json` next to `manifest.json` (same shape as
[`local-workflows.example.json`](extension/local-workflows.example.json)) before
loading the extension, and its workflows are added on first install. The file is
git-ignored so personal paths stay on your machine.

## How it works

```
popup / editor ──messages──▶ service worker ──executeScript (MAIN world)──▶ Overleaf tab
                                   │                                       • CodeMirror edit
                                   │                                       • click Recompile, read /compile reply
                                   │                                       • fetch PDF (same-origin)
                                   └──native messaging──▶ texflow helper (python3) ──▶ ~/…/folder/file.pdf
```

- `extension/lib/workflow.js` has the pure logic: validation, locating the one
  matching span, ordering steps (the value already in the document runs first),
  restore edits, and rendered-text verification.
- `extension/agent/overleaf-agent.js` runs inside Overleaf. Edits only apply if the
  span still holds the expected text, so concurrent typing or a file switch
  aborts the run instead of corrupting the document.
- `native-host/texflow_host.py` only writes `.pdf` files that start with `%PDF-`,
  inside your home folder, into folders that already exist. Writes are atomic.

texflow relies on Overleaf's editor internals (`window.overleaf.unstable.store`,
the Recompile button, the PDF.js text layer). If Overleaf changes these, runs fail
with a clear error rather than saving a wrong PDF.

## Develop

```sh
npm test   # node --test for the core logic + python unittest for the helper
```

After editing extension files, click the reload icon on texflow in `chrome://extensions`.

## License

MIT

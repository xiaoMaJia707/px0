// web/src/diff.js
// Git diff view for the active tab: renders the file's unified diff against
// HEAD in a dedicated overlay (like the Markdown preview), in either a
// side-by-side split layout (default) or a single-column unified layout.
// Unlike the code viewport this is not virtualized -- a file's own diff is
// bounded in size, so a plain DOM render is simple and fast enough.
import { $, S, doc_, esc, api } from './state.js';
import { syncPreview } from './markdown.js';
import { setStatusNote, updateStatus } from './status.js';

export const diffview = $('#diffview');
const diffContent = $('#diffcontent');

let shown = null; // doc the diff view is currently showing, null while hidden

// d.diffMode is 'split' | 'unified' | null (off), per tab. The layout last
// picked (split vs unified) is remembered globally as the default for the
// next file entering diff view.
function setLayoutPref(mode) {
  try { localStorage.setItem('px0.diffLayout', mode); } catch {}
}

export function layoutPref() {
  try { return localStorage.getItem('px0.diffLayout') || 'split'; } catch { return 'split'; }
}

function diffMode(d = doc_()) {
  return (d && d.diffMode) || null;
}

/* Show or hide the diff overlay to match the active tab, and re-render when
   the layout (split/unified) changes while already showing the same doc --
   switching layout doesn't change which doc is "shown", so that alone can't
   be the signal to redraw. Call whenever either might have changed. */
export function syncDiffView() {
  const d = doc_();
  const want = (d && d.diffMode) ? d : null;
  if (want !== shown) {
    shown = want;
    diffview.hidden = !want;
    if (want) drawDiff(want);
    else diffContent.replaceChildren();
  } else if (want && want.diffHunks !== undefined) {
    renderDiff(want);
  }
}

export async function toggleDiff() {
  if (!S.meta?.git) return;
  const d = doc_();
  if (!d) return;
  if (!d.diffMode && !d.diffAvailable) { setStatusNote('No diff — clean file or not a git repo'); return; }
  setDiffMode(d.diffMode ? 'source' : (layoutPref() || 'split'));
}

export async function setDiffMode(mode) {
  const d = doc_();
  if (!d) return;
  if (mode !== 'source' && !d.diffAvailable) { setStatusNote('No diff — clean file or not a git repo'); return; }
  if (mode === 'source') {
    d.diffMode = null;
    d.diffDismissed = true;
  } else {
    d.diffMode = mode;
    d.diffDismissed = false;
    setLayoutPref(mode);
  }
  syncPreview(); // markdown preview and diff view are mutually exclusive
  syncDiffView();
  updateStatus();
}

async function drawDiff(d) {
  if (d.diffText === undefined) {
    diffContent.replaceChildren();
    try {
      d.diffReq = d.diffReq || api('/api/diff', { path: d.path });
      const j = await d.diffReq;
      d.diffText = j.diff || '';
      d.diffHunks = parseDiff(d.diffText);
    } catch (e) {
      d.diffText = '';
      d.diffHunks = [];
      setStatusNote('No diff: ' + e.message);
    } finally {
      d.diffReq = null;
    }
    if (shown !== d) return;
  }
  renderDiff(d);
}

function renderDiff(d) {
  renderHunks(diffContent, d.diffHunks, d.diffMode, 'No changes against HEAD.');
}

/* Render parsed diff hunks (from parseDiff) into any container in either
   layout, replacing whatever was there. Used by the active-tab diff overlay and
   (per file) by the git history view. emptyMsg shows when there are no hunks (a
   clean file, or a commit that didn't touch the scoped path). */
export function renderHunks(container, hunks, mode, emptyMsg = 'No changes.') {
  container.replaceChildren();
  if (!hunks || !hunks.length) {
    const p = document.createElement('div');
    p.className = 'diff-empty';
    p.textContent = emptyMsg;
    container.append(p);
    return;
  }
  container.append(hunksFragment(hunks, mode));
}

// The hunk rows for one file, as a fragment so a caller can precede it with a
// file banner (the git history view) or append it alone (the active tab).
function hunksFragment(hunks, mode) {
  const frag = document.createDocumentFragment();
  for (const hunk of hunks) {
    frag.append(hunkHeader(hunk));
    frag.append(mode === 'unified' ? unifiedTable(hunk) : splitTable(hunk));
  }
  return frag;
}

/* Render a whole commit's diff (from parseCommitDiff) into a container: a banner
   per file with its change kind, then that file's hunks (or a note for a
   binary / rename-only / mode-only change that carries no textual hunks). A file
   still present after the commit gets an "Open file" link to its current
   content. emptyMsg covers a commit with no file changes at all (e.g. a merge
   commit, whose default `git show` output carries no patch). */
export function renderCommitDiff(container, files, mode, emptyMsg = 'No file changes.') {
  container.replaceChildren();
  if (!files || !files.length) {
    const p = document.createElement('div');
    p.className = 'diff-empty';
    p.textContent = emptyMsg;
    container.append(p);
    return;
  }
  const frag = document.createDocumentFragment();
  for (const f of files) {
    // Each file is a collapsible section, collapsed by default so a large commit
    // opens as a scannable list of filenames; clicking a header reveals its diff.
    const fileEl = document.createElement('div');
    fileEl.className = 'diff-file collapsed';

    const body = document.createElement('div');
    body.className = 'diff-file-body';
    if (f.hunks.length) {
      body.append(hunksFragment(f.hunks, mode));
    } else {
      const note = document.createElement('div');
      note.className = 'diff-empty diff-file-note';
      note.textContent = fileNote(f);
      body.append(note);
    }

    const head = fileHeader(f);
    fileEl.append(head, body);
    setFileCollapsed(fileEl, true);
    head.addEventListener('click', () => setFileCollapsed(fileEl, !fileEl.classList.contains('collapsed')));
    head.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setFileCollapsed(fileEl, !fileEl.classList.contains('collapsed')); }
    });
    frag.append(fileEl);
  }
  container.append(frag);
}

// Collapses or expands one file section, keeping the header's ARIA state in sync.
function setFileCollapsed(fileEl, collapsed) {
  fileEl.classList.toggle('collapsed', collapsed);
  const head = fileEl.querySelector('.diff-file-head');
  if (head) head.setAttribute('aria-expanded', String(!collapsed));
}

// Collapses or expands every file section in a rendered commit diff. Used by the
// history view's fold-all / expand-all toggle.
export function setAllFilesCollapsed(container, collapsed) {
  for (const fileEl of container.querySelectorAll('.diff-file')) setFileCollapsed(fileEl, collapsed);
}

// True when at least one file section in the container is expanded.
export function anyFileExpanded(container) {
  return container.querySelector('.diff-file:not(.collapsed)') !== null;
}

// A short description of a hunk-less file change, so "changed" never reads as
// "unchanged" in the history view.
export function fileNote(f) {
  if (f.binary) return 'Binary file — no textual diff.';
  if (f.kind === 'renamed') return 'Renamed' + (f.oldPath && f.newPath ? ' — no content change.' : '.');
  if (f.kind === 'mode') return 'File mode changed — no content change.';
  if (f.kind === 'added') return 'Added (empty file).';
  if (f.kind === 'deleted') return 'Deleted.';
  return 'No textual diff.';
}

// A file banner for the git history view: the display path, a change-kind tag,
// and (when the file still exists) a link opening its current content in a new
// browser tab, so several files from a commit can be opened side by side while
// the history view stays put.
function fileHeader(f) {
  const el = document.createElement('div');
  el.className = 'diff-file-head';
  el.tabIndex = 0;
  el.setAttribute('role', 'button');

  const caret = document.createElement('span');
  caret.className = 'diff-file-caret';
  caret.setAttribute('aria-hidden', 'true');
  el.append(caret);

  const name = document.createElement('span');
  name.className = 'diff-file-name';
  name.textContent = f.display;
  name.title = f.display;
  el.append(name);

  if (f.kind && f.kind !== 'modified') {
    const tag = document.createElement('span');
    tag.className = 'diff-file-tag';
    tag.textContent = f.kind;
    el.append(tag);
  }

  // Only offer "Open file" when the file still exists after this commit (it has
  // a new-side path and wasn't deleted); opening a deleted path would 404.
  if (f.newPath && f.kind !== 'deleted') {
    const open = document.createElement('a');
    open.className = 'diff-file-open';
    open.textContent = 'Open file';
    open.href = '?path=' + encodeURIComponent(f.newPath);
    open.target = '_blank';
    open.rel = 'noopener';
    open.title = 'Open the current version of this file in a new tab';
    // The header toggles collapse; the link opens a tab -- don't do both.
    open.addEventListener('click', e => e.stopPropagation());
    el.append(open);
  }
  return el;
}

function hunkHeader(hunk) {
  const el = document.createElement('div');
  el.className = 'diff-hunk-head';
  el.textContent = '@@ -' + hunk.oldStart + ' +' + hunk.newStart + ' @@' + (hunk.section ? ' ' + hunk.section : '');
  return el;
}

/* ---------- unified diff parsing ---------- */

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@[ \t]?(.*)$/;

// Parses a unified diff (as returned by `git diff` or a single file's `git
// show`) into hunks: each a flat list of rows tagged ctx/add/del carrying old-
// and/or new-file line numbers. File headers (diff --git, index, ---, +++) are
// skipped -- this is for one file's diff. Use parseCommitDiff for a whole
// commit spanning several files.
export function parseDiff(text) {
  if (!text) return [];
  const hunks = [];
  let cur = null, oldLine = 0, newLine = 0;
  for (const line of text.split('\n')) {
    const m = HUNK_RE.exec(line);
    if (m) {
      oldLine = +m[1];
      newLine = +m[3];
      cur = { oldStart: oldLine, newStart: newLine, section: m[5] || '', rows: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur || line === '' || line.startsWith('\\')) continue; // trailing split artifact, pre-hunk header, or "\ No newline..."
    const c = line[0], body = line.slice(1);
    if (c === '+') cur.rows.push({ type: 'add', newLine: newLine++, text: body });
    else if (c === '-') cur.rows.push({ type: 'del', oldLine: oldLine++, text: body });
    else cur.rows.push({ type: 'ctx', oldLine: oldLine++, newLine: newLine++, text: body });
  }
  return hunks;
}

/* ---------- whole-commit diff parsing ---------- */

// Parses a whole commit's `git show` output into one entry per file, so the
// history view can label every changed file -- including changes that carry no
// textual hunks (binary, pure rename, mode-only), which a hunk-only parser
// would silently drop and misreport as "no changes". Each file carries:
//   display  human path ("old -> new" for a rename)
//   newPath  repo-relative path after the commit, or '' if deleted (for "Open file")
//   oldPath  repo-relative path before the commit, or ''
//   kind     added | deleted | renamed | mode | modified
//   binary   true if git reported a binary change
//   hunks    textual hunks (possibly empty)
// A file block starts at "diff --git"; the a/ b/ prefixes are stripped.
export function parseCommitDiff(text) {
  if (!text) return [];
  const files = [];
  let f = null;
  const flush = () => { if (f) { finalizeFile(f); files.push(f); } };
  let oldLine = 0, newLine = 0, cur = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      f = { display: '', newPath: '', oldPath: '', kind: 'modified', binary: false, hunks: [] };
      cur = null;
      const pair = parseGitHeaderPaths(line.slice(11));
      f.oldPath = pair.a; f.newPath = pair.b; // provisional; refined below
      continue;
    }
    if (!f) continue; // preamble before the first file (there is none from git show --format=)
    if (line.startsWith('new file mode')) { f.kind = 'added'; f.oldPath = ''; continue; }
    if (line.startsWith('deleted file mode')) { f.kind = 'deleted'; f.newPath = ''; continue; }
    if (line.startsWith('rename from ')) { f.kind = 'renamed'; f.oldPath = renamePath(line.slice(12)); continue; }
    if (line.startsWith('rename to ')) { f.kind = 'renamed'; f.newPath = renamePath(line.slice(10)); continue; }
    if (line.startsWith('old mode ') || line.startsWith('new mode ')) { if (f.kind === 'modified') f.kind = 'mode'; continue; }
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) { f.binary = true; continue; }
    if (line.startsWith('--- ')) { const p = line.slice(4); if (p !== '/dev/null') f.oldPath = headerPath(p); continue; }
    if (line.startsWith('+++ ')) { const p = line.slice(4); if (p !== '/dev/null') f.newPath = headerPath(p); continue; }
    const m = HUNK_RE.exec(line);
    if (m) {
      if (f.kind === 'mode') f.kind = 'modified'; // a mode change that also has hunks is a content change
      oldLine = +m[1];
      newLine = +m[3];
      cur = { oldStart: oldLine, newStart: newLine, section: m[5] || '', rows: [] };
      f.hunks.push(cur);
      continue;
    }
    if (!cur || line === '' || line.startsWith('\\')) continue;
    const c = line[0], body = line.slice(1);
    if (c === '+') cur.rows.push({ type: 'add', newLine: newLine++, text: body });
    else if (c === '-') cur.rows.push({ type: 'del', oldLine: oldLine++, text: body });
    else cur.rows.push({ type: 'ctx', oldLine: oldLine++, newLine: newLine++, text: body });
  }
  flush();
  return files;
}

// Fills in a file's human-readable display path once all its header lines are
// seen: "old -> new" for a rename, otherwise whichever path exists.
function finalizeFile(f) {
  if (f.kind === 'renamed' && f.oldPath && f.newPath && f.oldPath !== f.newPath) {
    f.display = f.oldPath + ' → ' + f.newPath;
  } else {
    f.display = f.newPath || f.oldPath;
  }
}

// Splits a "diff --git a/x b/y" tail into the a- and b-side paths. The a/ b/
// header is genuinely ambiguous when a path contains a space ("a/x y b/z"), so
// this is best-effort and the ---/+++/rename lines override it whenever they
// exist. The cases with NO such lines -- binary and mode-only changes -- always
// have the same path on both sides ("a/P b/P"), which parses unambiguously:
//   quoted:    "a/..." "b/..."     -> each side a fully C-quoted token
//   symmetric: a/P b/P           -> P is the same length on both sides
// Only a genuine rename-with-space falls back to first " b/", and a rename
// always has rename from/to lines to correct it.
function parseGitHeaderPaths(s) {
  // Quoted form: git wraps a whole side in "..." (prefix included) when the path
  // has special bytes, e.g.  "a/foo\tbar" "b/foo\tbar"  . Each side is quoted
  // independently, the two sides separated by a space.
  if (s.startsWith('"')) {
    const a = readQuoted(s, 0);
    // The second side starts at the next non-space; it may or may not be quoted.
    let j = a.end;
    while (j < s.length && s[j] === ' ') j++;
    const b = s[j] === '"' ? readQuoted(s, j) : { value: s.slice(j), end: s.length };
    return { a: stripDiffPrefix(a.value), b: stripDiffPrefix(b.value) };
  }
  // Symmetric unquoted form "a/P b/P": both paths equal, so P has a known length.
  if (s.startsWith('a/')) {
    const rest = s.slice(2);            // "P b/P"
    if (rest.length % 2 === 1) {         // len(P) + 3 (" b/") + len(P) is odd
      const n = (rest.length - 3) / 2;
      if (n >= 0 && rest.slice(n, n + 3) === ' b/' && rest.slice(0, n) === rest.slice(n + 3)) {
        return { a: rest.slice(0, n), b: rest.slice(n + 3) };
      }
    }
    // Fall back to the first " b/" (a rename with a space; rename lines fix it).
    const i = rest.indexOf(' b/');
    if (i >= 0) return { a: rest.slice(0, i), b: rest.slice(i + 3) };
  }
  return { a: '', b: '' };
}

// Reads a C-style quoted git path starting at the opening quote index, undoing
// git's escaping (\t \n \" \\ and \NNN octal bytes decoded as UTF-8). Returns the
// unquoted value and the index just past the closing quote.
function readQuoted(s, open) {
  if (open < 0 || s[open] !== '"') return { value: '', end: -1 };
  const bytes = [];
  let i = open + 1;
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === '"') { i++; break; }
    if (c !== '\\') { for (const b of utf8Bytes(c)) bytes.push(b); continue; }
    const e = s[++i];
    if (e >= '0' && e <= '7') { // \NNN octal byte
      bytes.push(parseInt(s.substr(i, 3), 8) & 0xff);
      i += 2;
    } else {
      bytes.push(({ t: 9, n: 10, r: 13 }[e] ?? e.charCodeAt(0)));
    }
  }
  return { value: bytesToStr(bytes), end: i };
}

function utf8Bytes(ch) { return Array.from(new TextEncoder().encode(ch)); }
function bytesToStr(bytes) { return new TextDecoder().decode(new Uint8Array(bytes)); }

// Strips git's a/ or b/ diff prefix, undoing C-style quoting first (a ---/+++/
// rename line quotes the path exactly as the diff --git line does). A path with
// no prefix (e.g. --no-prefix output) is left as-is.
function headerPath(p) {
  if (p.startsWith('"')) return stripDiffPrefix(readQuoted(p, 0).value);
  return stripDiffPrefix(p);
}

// A rename from/to path: no a/ b/ prefix, but git still C-quotes it when it has
// special bytes.
function renamePath(p) {
  return p.startsWith('"') ? readQuoted(p, 0).value : p;
}

// Drops git's a/ or b/ diff prefix from an already-unquoted header path.
function stripDiffPrefix(p) {
  return (p.startsWith('a/') || p.startsWith('b/')) ? p.slice(2) : p;
}

/* ---------- unified layout: one row per diff line ---------- */

function unifiedTable(hunk) {
  const table = document.createElement('div');
  table.className = 'diff-table diff-unified';
  for (const row of hunk.rows) {
    const r = document.createElement('div');
    r.className = 'diff-row diff-' + row.type;
    r.append(
      lineCell(row.type === 'add' ? '' : row.oldLine),
      lineCell(row.type === 'del' ? '' : row.newLine),
      markerCell(row.type),
      codeCell(row.text),
    );
    table.append(r);
  }
  return table;
}

/* ---------- split layout: deletions and additions paired side by side ---------- */

function splitTable(hunk) {
  const table = document.createElement('div');
  table.className = 'diff-table diff-split';
  for (const pair of pairRows(hunk.rows)) {
    const r = document.createElement('div');
    r.className = 'diff-row-pair';
    r.append(splitSide(pair.left, 'left'), splitSide(pair.right, 'right'));
    table.append(r);
  }
  return table;
}

// Walks a hunk's flat row list, pairing each run of deletions with the run of
// additions that immediately follows it (a "changed" block) index-by-index,
// padding the shorter side with blanks. Context rows go straight across.
function pairRows(rows) {
  const pairs = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    if (row.type === 'ctx') { pairs.push({ left: row, right: row }); i++; continue; }
    let dels = [], adds = [];
    while (i < rows.length && rows[i].type === 'del') dels.push(rows[i++]);
    while (i < rows.length && rows[i].type === 'add') adds.push(rows[i++]);
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) pairs.push({ left: dels[k] || null, right: adds[k] || null });
  }
  return pairs;
}

function splitSide(row, side) {
  const el = document.createElement('div');
  el.className = 'diff-side diff-side-' + side + (row ? ' diff-' + row.type : ' diff-blank');
  if (!row) { el.append(lineCell(''), markerCell(''), codeCell('')); return el; }
  const ln = side === 'left' ? row.oldLine : row.newLine;
  el.append(lineCell(ln), markerCell(row.type), codeCell(row.text));
  return el;
}

function lineCell(n) {
  const el = document.createElement('div');
  el.className = 'diff-ln';
  el.textContent = n === '' || n === undefined ? '' : String(n);
  return el;
}

const MARKS = { add: '+', del: '-', ctx: '' };

function markerCell(type) {
  const el = document.createElement('div');
  el.className = 'diff-mk';
  el.textContent = MARKS[type] || '';
  return el;
}

function codeCell(text) {
  const el = document.createElement('div');
  el.className = 'diff-code';
  el.innerHTML = esc(text || '') || '&nbsp;';
  return el;
}

export function initDiff() {
  const sw = $('#diff-switch');
  if (!sw) return;
  sw.addEventListener('mousedown', e => {
    if (!e.target.closest('button')) e.preventDefault();
  });
  const btn = $('#diff-btn');
  if (btn) {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      toggleDiff();
    });
  }
  const menu = $('#diff-menu');
  if (menu) {
    menu.addEventListener('click', e => {
      const item = e.target.closest('[data-diff-opt]');
      if (!item) return;
      e.stopPropagation();
      setDiffMode(item.dataset.diffOpt);
      item.blur();
    });
  }
}

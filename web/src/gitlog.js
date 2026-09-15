// web/src/gitlog.js
// Read-only git history browser (full-screen overlay). Two layouts, toggled from
// the header and remembered in localStorage:
//   V1 (classic): commit list left; selecting a commit shows all its files as a
//     single collapsible diff on the right (fold/expand-all).
//   V2 (tree):    left splits into commit list (top) + the selected commit's file
//     tree (bottom); the right is empty until a file is picked, then that file's
//     diff opens as a tab (multiple files -> multiple tabs, scoped to the commit).
// Both share one data path: /api/gitlog for the list, /api/gitshow for the diff
// (which returns the whole commit; parseCommitDiff splits it per file). Scope is
// the whole repo or a single file (its own history). Commits load 50 at a time
// with a "Load more" row so a huge repo never blocks. Lazy: nothing loads until
// opened, so it never touches the boot path.
import { $, S, doc_, api } from './state.js';
import {
  parseCommitDiff, renderCommitDiff, renderHunks, fileNote,
  layoutPref, setAllFilesCollapsed, anyFileExpanded,
} from './diff.js';

const PAGE = 50; // commits per fetch; "Load more" grows the request by this much
const MODE_KEY = 'px0-gitlog-mode';

const gitlog = $('#gitlog');
const gitlogList = $('#gitlog-list');
const treeEl = $('#gitlog-tree');
const tabsEl = $('#gitlog-tabs');
const diffEl = $('#gitlog-diff');
const titleEl = $('#gitlog-title');
const scopeEl = $('#gitlog-scope');
const foldEl = $('#gitlog-fold');
const modeEl = $('#gitlog-mode');

let mode = readMode();  // 'v1' | 'v2'
let scope = '';         // '' = whole repo, otherwise a file path
let commits = [];       // the commit list currently shown
let limit = PAGE;       // how many commits the last fetch asked for
let sel = null;         // hash of the selected commit
let curFiles = [];      // parsed files of the selected commit (shared by both modes)
let tabs = [];          // V2: open file tabs, each is a file from curFiles
let activeTab = -1;     // V2: index into tabs of the shown file, -1 = none
// Two independent staleness tokens: the commit-list fetch and the commit-diff
// fetch are separate async streams, so paging the list ("Load more") must NOT
// cancel an in-flight diff for the already-selected commit. listGen guards
// loadCommits; diffGen guards selectCommit. closeGitlog bumps both.
let listGen = 0;
let diffGen = 0;

function readMode() {
  try { return localStorage.getItem(MODE_KEY) === 'v2' ? 'v2' : 'v1'; } catch { return 'v1'; }
}
function saveMode() {
  try { localStorage.setItem(MODE_KEY, mode); } catch { /* private mode: keep session value */ }
}

/* Human-friendly age from an ISO date, coarsening as it gets older -- the same
   feel as a commit list in a typical git UI, without pulling in a date library. */
function relTime(iso) {
  const then = Date.parse(iso);
  if (isNaN(then)) return '';
  const s = Math.max(0, (Date.now() - then) / 1000);
  if (s < 60) return 'just now';
  const m = s / 60;
  if (m < 60) return Math.floor(m) + 'm ago';
  const h = m / 60;
  if (h < 24) return Math.floor(h) + 'h ago';
  const d = h / 24;
  if (d < 30) return Math.floor(d) + 'd ago';
  const mo = d / 30;
  if (mo < 12) return Math.floor(mo) + 'mo ago';
  return Math.floor(d / 365) + 'y ago';
}

export function openGitlog(path = '') {
  if (!S.meta?.git) return;
  scope = path;
  limit = PAGE;
  gitlog.hidden = false;
  applyMode();
  loadCommits();
}

export function closeGitlog() {
  listGen++; diffGen++; // abandon any in-flight request so it can't write into the hidden overlay
  gitlog.hidden = true;
}

export function gitlogOpen() {
  return !gitlog.hidden;
}

// Reflect the current mode on the overlay (CSS shows/hides the V2 panels) and on
// the toggle button, which is labelled by the layout it switches TO.
function applyMode() {
  gitlog.classList.toggle('mode-v2', mode === 'v2');
  modeEl.textContent = mode === 'v2' ? 'Classic view' : 'Tree view';
  modeEl.title = mode === 'v2' ? 'Switch to the classic single-diff layout' : 'Switch to the file-tree + tabs layout';
}

function toggleMode() {
  mode = mode === 'v2' ? 'v1' : 'v2';
  saveMode();
  applyMode();
  // Re-render the current selection into the newly active layout (no refetch:
  // curFiles is already parsed). Clear the other layout's transient state.
  if (mode === 'v1') { clearTabs(); }
  else { treeEl.replaceChildren(); }
  if (sel) renderSelected();
  updateFoldButton();
}

// Toggle between whole-repo history and the active file's own history. Only
// offered when a file is open; otherwise the button is hidden.
function toggleScope() {
  const d = doc_();
  scope = scope ? '' : (d ? d.path : '');
  limit = PAGE;
  loadCommits();
}

async function loadCommits({ keepSel = false } = {}) {
  const my = ++listGen;
  if (!keepSel) {
    // Full reload (open / scope change): also abandon any in-flight diff, since
    // the selection is being reset.
    diffGen++;
    sel = null;
    commits = [];
    curFiles = [];
    clearTabs();
    treeEl.replaceChildren();
    diffEl.replaceChildren();
    titleEl.textContent = scope ? 'File History' : 'Git History';
    updateScopeButton();
    gitlogList.replaceChildren(msg('Loading\u2026'));
    updateFoldButton();
  }
  let j;
  try {
    j = await api('/api/gitlog', { path: scope, limit });
  } catch (e) {
    if (my !== listGen) return;
    if (!keepSel) gitlogList.replaceChildren(msg('Failed to load history: ' + e.message));
    return;
  }
  if (my !== listGen) return;
  if (!j.available) {
    // git log failed / repo unavailable -- distinct from a repo that simply has
    // no commits for this scope, which returns available:true with an empty list.
    gitlogList.replaceChildren(msg('Git history unavailable.'));
    return;
  }
  commits = j.commits || [];
  drawList();
  if (!keepSel && commits.length) selectCommit(commits[0].hash);
}

// Fetch the next page of commits, keeping the current selection and diff intact.
function loadMore() {
  limit += PAGE;
  loadCommits({ keepSel: true });
}

function drawList() {
  if (!commits.length) {
    gitlogList.replaceChildren(msg(scope ? 'No history for this file.' : 'No commits.'));
    return;
  }
  const frag = document.createDocumentFragment();
  for (const c of commits) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'gitlog-item' + (c.hash === sel ? ' sel' : '');
    row.dataset.hash = c.hash;

    const subj = document.createElement('div');
    subj.className = 'gitlog-subj';
    subj.textContent = c.subject;

    const meta = document.createElement('div');
    meta.className = 'gitlog-meta';
    const sha = document.createElement('span');
    sha.className = 'gitlog-sha';
    sha.textContent = c.short;
    const who = document.createElement('span');
    who.className = 'gitlog-author';
    who.textContent = c.author;
    const when = document.createElement('span');
    when.className = 'gitlog-when';
    when.textContent = relTime(c.date);
    when.title = c.date;
    meta.append(sha, who, when);

    row.append(subj, meta);
    frag.append(row);
  }
  // Offer more only when the last fetch came back full -- a short page means we
  // already have every commit for this scope.
  if (commits.length >= limit) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'gitlog-more';
    more.dataset.more = '1';
    more.textContent = 'Load more';
    frag.append(more);
  }
  gitlogList.replaceChildren(frag);
}

async function selectCommit(hash) {
  sel = hash;
  const my = ++diffGen;
  // Drop the previous commit's parsed files immediately so a mode toggle while
  // this fetch is in flight can't render stale content as the new selection.
  curFiles = [];
  for (const el of gitlogList.children) {
    if (el.dataset && el.dataset.hash) el.classList.toggle('sel', el.dataset.hash === hash);
  }
  clearTabs();
  treeEl.replaceChildren(msg('Loading\u2026'));
  diffEl.replaceChildren(msg('Loading diff\u2026'));
  updateFoldButton();
  let j;
  try {
    j = await api('/api/gitshow', { rev: hash, path: scope });
  } catch (e) {
    if (my !== diffGen) return;
    curFiles = [];
    treeEl.replaceChildren();
    diffEl.replaceChildren(msg('Failed to load diff: ' + e.message));
    return;
  }
  if (my !== diffGen || sel !== hash) return;
  curFiles = parseCommitDiff(j.diff || '');
  renderSelected();
}

// Render the current commit (curFiles) into whichever layout is active.
function renderSelected() {
  if (mode === 'v2') {
    drawTree();
    // Right starts empty until the reader picks a file from the tree.
    if (activeTab < 0) {
      diffEl.replaceChildren(msg(curFiles.length
        ? 'Select a file on the left to view its diff.'
        : (scope ? 'This commit did not change this file.' : 'No file changes (a merge or empty commit).')));
    }
  } else {
    renderCommitDiff(diffEl, curFiles, layoutPref(), scope
      ? 'This commit did not change this file.'
      : 'No default patch (a merge commit, or an empty commit).');
  }
  updateFoldButton();
}

/* ---- V2: file tree of the selected commit --------------------------------- */

const STATUS_BADGE = { added: 'A', deleted: 'D', renamed: 'R', modified: 'M', mode: 'M' };
const STATUS_CLASS = { added: 'git-A', deleted: 'git-D', renamed: 'git-R', modified: 'git-M', mode: 'git-M' };

// Path shown/keyed in the tree: the new path for anything that still exists,
// the old path for a deletion.
function filePath(f) { return f.newPath || f.oldPath || ''; }

// Build a nested {dirs, files} tree from the flat file list, then render it with
// single-child directory chains collapsed (a/b/c) so a deep path stays readable.
function drawTree() {
  if (!curFiles.length) {
    treeEl.replaceChildren(msg(scope ? 'This commit did not change this file.' : 'No file changes.'));
    return;
  }
  const root = { dirs: new Map(), files: [] };
  curFiles.forEach((f, idx) => {
    const parts = filePath(f).split('/');
    const fname = parts.pop();
    let node = root;
    for (const p of parts) {
      if (!node.dirs.has(p)) node.dirs.set(p, { dirs: new Map(), files: [] });
      node = node.dirs.get(p);
    }
    node.files.push({ name: fname, idx, f });
  });
  const frag = document.createDocumentFragment();
  renderTreeNode(root, 0, frag);
  treeEl.replaceChildren(frag);
}

function renderTreeNode(node, depth, out) {
  // Directories first (compressing single-child chains), then files.
  for (let [name, child] of node.dirs) {
    let label = name;
    const d = depth;
    // Collapse a/b/c when each level has exactly one child dir and no files.
    while (child.files.length === 0 && child.dirs.size === 1) {
      const [nm, only] = child.dirs.entries().next().value;
      label += '/' + nm;
      child = only;
    }
    const row = document.createElement('div');
    row.className = 'gitlog-tree-row dir';
    row.style.paddingLeft = (8 + d * 14) + 'px';
    const nm = document.createElement('span');
    nm.className = 'gitlog-tree-name gitlog-tree-dir';
    nm.textContent = label + '/';
    row.append(nm);
    out.append(row);
    renderTreeNode(child, d + 1, out);
  }
  for (const item of node.files) {
    const f = item.f;
    const row = document.createElement('div');
    row.className = 'gitlog-tree-row file';
    row.style.paddingLeft = (8 + depth * 14) + 'px';
    row.dataset.idx = String(item.idx);
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    const nm = document.createElement('span');
    nm.className = 'gitlog-tree-name';
    nm.textContent = item.name;
    nm.title = f.display || item.name;
    row.append(nm);
    const badge = document.createElement('span');
    badge.className = 'gitlog-tree-badge ' + (STATUS_CLASS[f.kind] || 'git-M');
    badge.textContent = STATUS_BADGE[f.kind] || 'M';
    row.append(badge);
    out.append(row);
  }
}

/* ---- V2: file tabs -------------------------------------------------------- */

function clearTabs() {
  tabs = [];
  activeTab = -1;
  tabsEl.replaceChildren();
}

// Open a file (by its index in curFiles) as a tab, or focus it if already open.
function openFileTab(idx) {
  const f = curFiles[idx];
  if (!f) return;
  let ti = tabs.findIndex(t => t.idx === idx);
  if (ti < 0) { tabs.push({ idx, f }); ti = tabs.length - 1; }
  activeTab = ti;
  drawTabs();
  markTreeSelection();
  showTab();
}

function drawTabs() {
  const frag = document.createDocumentFragment();
  tabs.forEach((t, i) => {
    const tab = document.createElement('div');
    tab.className = 'gitlog-tab' + (i === activeTab ? ' sel' : '');
    tab.dataset.tab = String(i);
    tab.tabIndex = 0;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(i === activeTab));
    const nm = document.createElement('span');
    nm.className = 'gitlog-tab-name';
    const base = filePath(t.f).split('/').pop();
    nm.textContent = base;
    nm.title = t.f.display || base;
    const x = document.createElement('span');
    x.className = 'gitlog-tab-x';
    x.dataset.close = String(i);
    x.tabIndex = 0;
    x.setAttribute('role', 'button');
    x.setAttribute('aria-label', 'Close ' + base);
    x.textContent = '\u00d7';
    tab.append(nm, x);
    frag.append(tab);
  });
  tabsEl.replaceChildren(frag);
}

function showTab() {
  const t = tabs[activeTab];
  if (!t) { diffEl.replaceChildren(msg('Select a file on the left to view its diff.')); return; }
  renderHunks(diffEl, t.f.hunks, layoutPref(), fileNote(t.f));
}

function closeTab(i) {
  tabs.splice(i, 1);
  if (tabs.length === 0) { activeTab = -1; }
  else if (activeTab >= tabs.length) { activeTab = tabs.length - 1; }
  else if (i < activeTab) { activeTab--; }
  drawTabs();
  markTreeSelection();
  showTab();
}

function markTreeSelection() {
  const openIdx = new Set(tabs.map(t => t.idx));
  const activeIdx = activeTab >= 0 ? tabs[activeTab].idx : -1;
  for (const el of treeEl.querySelectorAll('.gitlog-tree-row.file')) {
    const idx = +el.dataset.idx;
    el.classList.toggle('sel', idx === activeIdx);
    el.classList.toggle('open', openIdx.has(idx));
  }
}

/* ---- fold button (V1 only) ------------------------------------------------ */

// V1 fold/expand-all toggle: shown whenever the selected commit has files.
// Hidden entirely in V2 (each file is its own tab, nothing to fold).
function updateFoldButton() {
  if (!foldEl) return;
  if (mode === 'v2' || !curFiles.length) { foldEl.hidden = true; return; }
  foldEl.hidden = false;
  foldEl.textContent = anyFileExpanded(diffEl) ? 'Fold all' : 'Expand all';
}

function updateScopeButton() {
  const d = doc_();
  // Offer the toggle only when a file is open (something to scope to), or when
  // already scoped (so the reader can get back to the whole-repo view).
  if (!d && !scope) { scopeEl.hidden = true; return; }
  scopeEl.hidden = false;
  if (scope) {
    scopeEl.textContent = 'All commits';
    scopeEl.title = 'Show the whole repository history';
  } else {
    scopeEl.textContent = 'This file';
    scopeEl.title = 'Show only the active file\u2019s history';
  }
}

function msg(text) {
  const el = document.createElement('div');
  el.className = 'gitlog-msg';
  el.textContent = text;
  return el;
}

export function initGitlog() {
  if (!gitlog) return;
  applyMode();
  $('#gitlog-close').addEventListener('click', closeGitlog);
  modeEl.addEventListener('click', toggleMode);
  scopeEl.addEventListener('click', toggleScope);
  if (foldEl) foldEl.addEventListener('click', () => {
    setAllFilesCollapsed(diffEl, anyFileExpanded(diffEl));
    updateFoldButton();
  });
  gitlog.addEventListener('mousedown', e => { if (e.target === gitlog) closeGitlog(); });
  gitlogList.addEventListener('click', e => {
    if (e.target.closest('[data-more]')) { loadMore(); return; }
    const row = e.target.closest('.gitlog-item');
    if (row && row.dataset.hash !== sel) selectCommit(row.dataset.hash);
  });
  treeEl.addEventListener('click', e => {
    const row = e.target.closest('.gitlog-tree-row.file');
    if (row) openFileTab(+row.dataset.idx);
  });
  treeEl.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest('.gitlog-tree-row.file');
    if (row) { e.preventDefault(); openFileTab(+row.dataset.idx); }
  });
  tabsEl.addEventListener('click', e => {
    const x = e.target.closest('[data-close]');
    if (x) { e.stopPropagation(); closeTab(+x.dataset.close); return; }
    const tab = e.target.closest('[data-tab]');
    if (tab) { activeTab = +tab.dataset.tab; drawTabs(); markTreeSelection(); showTab(); }
  });
  tabsEl.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const x = e.target.closest('[data-close]');
    if (x) { e.preventDefault(); e.stopPropagation(); closeTab(+x.dataset.close); return; }
    const tab = e.target.closest('[data-tab]');
    if (tab) { e.preventDefault(); activeTab = +tab.dataset.tab; drawTabs(); markTreeSelection(); showTab(); }
  });
}

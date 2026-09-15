// web/src/gitlog.js
// Read-only git history browser: a full-screen overlay listing recent commits
// on the left and, for the selected commit, the diff it introduced on the
// right. The diff reuses diff.js's parser and renderer so it looks identical to
// the active-tab diff view. Scope is either the whole repo or a single file
// (that file's own history / evolution). Lazy: nothing loads until opened, so
// it never touches the boot path.
import { $, S, doc_, api } from './state.js';
import { parseCommitDiff, renderCommitDiff, layoutPref, setAllFilesCollapsed, anyFileExpanded } from './diff.js';

const gitlog = $('#gitlog');
const gitlogList = $('#gitlog-list');
const diffEl = $('#gitlog-diff');
const titleEl = $('#gitlog-title');
const scopeEl = $('#gitlog-scope');
const foldEl = $('#gitlog-fold');

let scope = '';       // '' = whole repo, otherwise a file path
let commits = [];     // the commit list currently shown
let sel = null;       // hash of the selected commit
let gen = 0;          // bumped on every open/reload to drop stale async results

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
  gitlog.hidden = false;
  loadCommits();
}

export function closeGitlog() {
  gen++; // abandon any in-flight request so it can't write into the hidden overlay
  gitlog.hidden = true;
}

export function gitlogOpen() {
  return !gitlog.hidden;
}

// Toggle between whole-repo history and the active file's own history. Only
// offered when a file is open; otherwise the button is hidden.
function toggleScope() {
  const d = doc_();
  scope = scope ? '' : (d ? d.path : '');
  loadCommits();
}

async function loadCommits() {
  const my = ++gen;
  sel = null;
  commits = [];
  titleEl.textContent = scope ? 'File History' : 'Git History';
  updateScopeButton();
  gitlogList.replaceChildren(msg('Loading…'));
  diffEl.replaceChildren();
  updateFoldButton(false);
  let j;
  try {
    j = await api('/api/gitlog', { path: scope, limit: 200 });
  } catch (e) {
    if (my !== gen) return;
    gitlogList.replaceChildren(msg('Failed to load history: ' + e.message));
    return;
  }
  if (my !== gen) return;
  if (!j.available) {
    // git log failed / repo unavailable -- distinct from a repo that simply has
    // no commits for this scope, which returns available:true with an empty list.
    gitlogList.replaceChildren(msg('Git history unavailable.'));
    return;
  }
  commits = j.commits || [];
  drawList();
  if (commits.length) selectCommit(commits[0].hash);
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
  gitlogList.replaceChildren(frag);
}

async function selectCommit(hash) {
  sel = hash;
  const my = ++gen;
  for (const el of gitlogList.children) {
    if (el.dataset) el.classList.toggle('sel', el.dataset.hash === hash);
  }
  diffEl.replaceChildren(msg('Loading diff…'));
  updateFoldButton(false);
  let j;
  try {
    j = await api('/api/gitshow', { rev: hash, path: scope });
  } catch (e) {
    if (my !== gen) return;
    diffEl.replaceChildren(msg('Failed to load diff: ' + e.message));
    return;
  }
  if (my !== gen || sel !== hash) return;
  const files = parseCommitDiff(j.diff || '');
  renderCommitDiff(diffEl, files, layoutPref(), scope
    ? 'This commit did not change this file.'
    : 'No default patch (a merge commit, or an empty commit).');
  // Files render collapsed; offer a fold/expand-all toggle whenever the commit
  // touched a file, so the control stays put instead of appearing to be replaced
  // by the scope button on single-file commits.
  updateFoldButton(files.length > 0);
}

// Shows the fold/expand-all button (when there are files) and labels it by the
// action it will perform next: "Expand all" while everything is collapsed,
// "Fold all" once anything is open.
function updateFoldButton(show) {
  if (!foldEl) return;
  if (!show) { foldEl.hidden = true; return; }
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
  $('#gitlog-close').addEventListener('click', closeGitlog);
  scopeEl.addEventListener('click', toggleScope);
  if (foldEl) foldEl.addEventListener('click', () => {
    setAllFilesCollapsed(diffEl, anyFileExpanded(diffEl));
    updateFoldButton(true);
  });
  gitlog.addEventListener('mousedown', e => { if (e.target === gitlog) closeGitlog(); });
  gitlogList.addEventListener('click', e => {
    const row = e.target.closest('.gitlog-item');
    if (row && row.dataset.hash !== sel) selectCommit(row.dataset.hash);
  });
}

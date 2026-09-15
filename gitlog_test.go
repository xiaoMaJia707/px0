package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// gitLogRepo builds a repo with a short, known history: two commits touching
// two files, so log ordering and per-file scoping are both testable. Returns
// the served root and the two commit hashes (newest first: h2, h1).
func gitLogRepo(tb testing.TB) (root, h2, h1 string) {
	tb.Helper()
	root = tb.TempDir()
	if r, err := filepath.EvalSymlinks(root); err == nil {
		root = r
	}
	write := func(rel, body string) {
		p := filepath.Join(root, filepath.FromSlash(rel))
		os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			tb.Fatal(err)
		}
	}
	run := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = root
		cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null")
		if out, err := cmd.CombinedOutput(); err != nil {
			tb.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	revParse := func() string {
		cmd := exec.Command("git", "rev-parse", "HEAD")
		cmd.Dir = root
		cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null")
		out, err := cmd.Output()
		if err != nil {
			tb.Fatal(err)
		}
		return strings.TrimSpace(string(out))
	}
	run("init")
	run("config", "user.email", "t@example.com")
	run("config", "user.name", "T")
	run("config", "commit.gpgsign", "false")
	// First commit: two files.
	write("a.go", "one\n")
	write("b.go", "b original\n")
	run("add", "-A")
	// A subject with a tab and a quote round-trips through the newline/NUL format.
	run("commit", "-qm", "first\t\"commit\"")
	h1 = revParse()
	// Second commit: only a.go changes.
	write("a.go", "one\ntwo\n")
	run("add", "-A")
	run("commit", "-qm", "second change to a")
	h2 = revParse()
	return root, h2, h1
}

func TestGitLog(t *testing.T) {
	if !gitInstalled() {
		t.Skip("git not installed")
	}
	root, h2, h1 := gitLogRepo(t)

	all, ok := gitLog(root, "", 0)
	if !ok {
		t.Fatal("gitLog ok=false for a real repo")
	}
	if len(all) != 2 {
		t.Fatalf("gitLog returned %d commits, want 2: %+v", len(all), all)
	}
	// Newest first.
	if all[0].Hash != h2 || all[1].Hash != h1 {
		t.Errorf("order = %q,%q, want %q,%q", all[0].Hash, all[1].Hash, h2, h1)
	}
	if all[0].Subject != "second change to a" {
		t.Errorf("subject = %q, want %q", all[0].Subject, "second change to a")
	}
	// A subject with a tab and a quote must round-trip intact.
	if all[1].Subject != "first\t\"commit\"" {
		t.Errorf("subject = %q, want %q", all[1].Subject, "first\t\"commit\"")
	}
	if all[0].Short == "" || !strings.HasPrefix(all[0].Hash, all[0].Short) {
		t.Errorf("short %q not a prefix of hash %q", all[0].Short, all[0].Hash)
	}
	if all[0].Author != "T" || all[0].Date == "" {
		t.Errorf("author/date = %q/%q, want T/<iso>", all[0].Author, all[0].Date)
	}

	// Scoped to b.go: only the first commit touched it.
	forB, ok := gitLog(root, "b.go", 0)
	if !ok || len(forB) != 1 || forB[0].Hash != h1 {
		t.Errorf("gitLog(b.go) = %+v ok=%v, want just %q", forB, ok, h1)
	}
}

// Field values containing the old unit/record separators must not corrupt
// parsing: fields are newline-separated (which no field can contain) and
// commits are NUL-separated, so a \x1f/\x1e anywhere -- including in the author
// name, which is not the last field -- is just ordinary text.
func TestGitLogSeparatorInjection(t *testing.T) {
	if !gitInstalled() {
		t.Skip("git not installed")
	}
	root := t.TempDir()
	if r, err := filepath.EvalSymlinks(root); err == nil {
		root = r
	}
	run := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = root
		cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "f.go"), []byte("x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("init")
	run("config", "user.email", "t@example.com")
	// An author name carrying both separators -- author is field 3, not last, so
	// this is exactly the case a subject-only guard would miss.
	run("config", "user.name", "Ann\x1fEve\x1eX")
	run("config", "commit.gpgsign", "false")
	run("add", "-A")
	// A subject also carrying the separators plus a newline. git's %s collapses
	// newlines to spaces (its own subject normalization); the separators must
	// survive verbatim in both fields.
	evil := "pwn\x1ffield\x1erecord\nsecond line"
	run("commit", "-qm", evil)

	all, ok := gitLog(root, "", 0)
	if !ok || len(all) != 1 {
		t.Fatalf("gitLog = %d commits ok=%v, want exactly 1 (separators must not split it)", len(all), ok)
	}
	if all[0].Author != "Ann\x1fEve\x1eX" {
		t.Errorf("author = %q, want %q (separators in a non-last field must not shift others)", all[0].Author, "Ann\x1fEve\x1eX")
	}
	want := "pwn\x1ffield\x1erecord second line"
	if all[0].Subject != want {
		t.Errorf("subject = %q, want %q", all[0].Subject, want)
	}
	// The hash and date fields must remain well-formed, proving no shift.
	if len(all[0].Hash) != 40 || !strings.Contains(all[0].Date, "T") {
		t.Errorf("hash/date corrupted: hash=%q date=%q", all[0].Hash, all[0].Date)
	}
}

// gitLog on a repo with no commits reports ok=false (git log exits non-zero),
// so the caller can distinguish a failure from a genuinely empty result rather
// than presenting the failure as "no commits".
func TestGitLogEmptyRepo(t *testing.T) {
	if !gitInstalled() {
		t.Skip("git not installed")
	}
	root := t.TempDir()
	if r, err := filepath.EvalSymlinks(root); err == nil {
		root = r
	}
	cmd := exec.Command("git", "init")
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git init: %v\n%s", err, out)
	}
	if c, ok := gitLog(root, "", 0); ok || c != nil {
		t.Errorf("gitLog(empty repo) = %+v ok=%v, want nil/false", c, ok)
	}
}

// Without --follow, a file's scoped log lists exactly the commits git show can
// display a diff for under that path. Scoping to new.go after a rename shows
// only the rename commit (not the pre-rename create commit, whose diff under
// new.go would be empty), and gitShow for that commit+path is non-empty -- the
// list and the diff stay consistent.
func TestGitLogFileScopeConsistent(t *testing.T) {
	if !gitInstalled() {
		t.Skip("git not installed")
	}
	root := t.TempDir()
	if r, err := filepath.EvalSymlinks(root); err == nil {
		root = r
	}
	run := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = root
		cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	write := func(rel, body string) {
		if err := os.WriteFile(filepath.Join(root, rel), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("old.go", "one\n")
	run("init")
	run("config", "user.email", "t@example.com")
	run("config", "user.name", "T")
	run("config", "commit.gpgsign", "false")
	run("add", "-A")
	run("commit", "-qm", "create old.go")
	run("mv", "old.go", "new.go")
	write("new.go", "one\ntwo\n")
	run("add", "-A")
	run("commit", "-qm", "rename and edit")

	commits, ok := gitLog(root, "new.go", 0)
	if !ok || len(commits) != 1 {
		t.Fatalf("gitLog(new.go) = %d commits ok=%v, want 1 (only the rename commit; no --follow)", len(commits), ok)
	}
	// Every listed commit must have a showable diff for that path.
	if d := gitShow(root, commits[0].Hash, "new.go"); d == "" {
		t.Errorf("gitShow(%s, new.go) empty -- a listed commit must have a diff to open", commits[0].Short)
	}
}

func TestGitShow(t *testing.T) {
	if !gitInstalled() {
		t.Skip("git not installed")
	}
	root, h2, h1 := gitLogRepo(t)

	// The second commit added "two" to a.go.
	d := gitShow(root, h2, "")
	if !strings.Contains(d, "+two") || !strings.Contains(d, "a.go") {
		t.Errorf("show(h2) missing expected diff:\n%s", d)
	}
	// Scoped to b.go: h2 didn't touch it -> empty.
	if d := gitShow(root, h2, "b.go"); d != "" {
		t.Errorf("show(h2, b.go) = %q, want empty (untouched)", d)
	}
	// h1 created b.go.
	if d := gitShow(root, h1, "b.go"); !strings.Contains(d, "+b original") {
		t.Errorf("show(h1, b.go) missing b.go creation:\n%s", d)
	}

	// Injection guard: a rev that looks like a flag is refused, never run.
	for _, bad := range []string{"--upload-pack=touch pwned", "-n1", "", "HEAD;rm", "a b"} {
		if d := gitShow(root, bad, ""); d != "" {
			t.Errorf("gitShow(%q) = %q, want empty (rejected)", bad, d)
		}
	}
}

func TestValidRev(t *testing.T) {
	ok := []string{"HEAD", "abc123", "feature/x", "v1.2.3", "a_b-c"}
	bad := []string{"", "-n", "--flag", "a b", "a;b", "a|b", "$(x)", "a\tb", "main..other", "a...b"}
	for _, s := range ok {
		if !validRev(s) {
			t.Errorf("validRev(%q) = false, want true", s)
		}
	}
	for _, s := range bad {
		if validRev(s) {
			t.Errorf("validRev(%q) = true, want false", s)
		}
	}
}

func TestGitLogAPI(t *testing.T) {
	if !gitInstalled() {
		t.Skip("git not installed")
	}
	root, h2, _ := gitLogRepo(t)
	ix := NewIndex(root)
	ix.Build()
	s := NewServer(ix, nil)

	code, body := get(t, s, "/api/gitlog")
	if code != 200 || body["available"] != true {
		t.Fatalf("gitlog status=%d available=%v", code, body["available"])
	}
	commits := body["commits"].([]any)
	if len(commits) != 2 {
		t.Fatalf("gitlog returned %d commits, want 2", len(commits))
	}

	// Show the newest commit's diff.
	code, body = get(t, s, "/api/gitshow?rev="+h2)
	if code != 200 || body["available"] != true {
		t.Fatalf("gitshow status=%d available=%v", code, body["available"])
	}
	if !strings.Contains(body["diff"].(string), "+two") {
		t.Errorf("gitshow diff missing +two:\n%s", body["diff"])
	}

	// An invalid rev is refused: 200, available false, empty diff (never 500).
	_, body = get(t, s, "/api/gitshow?rev=--upload-pack")
	if body["available"] != false || body["diff"] != "" {
		t.Errorf("gitshow bad rev: available=%v diff=%q, want false/empty", body["available"], body["diff"])
	}
}

func TestGitLogDisabled(t *testing.T) {
	if !gitInstalled() {
		t.Skip("git not installed")
	}
	gitDisabled = true
	defer func() { gitDisabled = false }()

	root, h2, _ := gitLogRepo(t)
	if c, ok := gitLog(root, "", 0); c != nil || ok {
		t.Errorf("gitLog returned %v ok=%v with -no-git", c, ok)
	}
	if d := gitShow(root, h2, ""); d != "" {
		t.Errorf("gitShow returned %q with -no-git", d)
	}
	ix := NewIndex(root)
	ix.Build()
	s := NewServer(ix, nil)
	_, body := get(t, s, "/api/gitlog")
	if body["available"] != false {
		t.Errorf("gitlog available = %v with -no-git, want false", body["available"])
	}
}

// gitShow's output for hunk-less changes must still carry the header markers the
// frontend parser keys on -- a rename ("rename from/to") and a binary change
// ("Binary files ... differ") -- so the history view can label a change that has
// no textual diff instead of misreporting it as "no changes".
func TestGitShowNonTextualMarkers(t *testing.T) {
	if !gitInstalled() {
		t.Skip("git not installed")
	}
	root := t.TempDir()
	if r, err := filepath.EvalSymlinks(root); err == nil {
		root = r
	}
	run := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = root
		cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	revParse := func() string {
		cmd := exec.Command("git", "rev-parse", "HEAD")
		cmd.Dir = root
		cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null")
		out, err := cmd.Output()
		if err != nil {
			t.Fatal(err)
		}
		return strings.TrimSpace(string(out))
	}
	run("init")
	run("config", "user.email", "t@example.com")
	run("config", "user.name", "T")
	run("config", "commit.gpgsign", "false")
	// Baseline with a text file to rename and a binary blob (a NUL forces binary).
	if err := os.WriteFile(filepath.Join(root, "a.go"), []byte("hi\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "blob.bin"), []byte{0, 1, 2, 0, 3}, 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", "-A")
	run("commit", "-qm", "baseline")

	// A pure rename (no content change) -- git reports it with no @@ hunks.
	run("mv", "a.go", "b.go")
	run("commit", "-qam", "rename a.go")
	renameRev := revParse()
	d := gitShow(root, renameRev, "")
	if !strings.Contains(d, "rename from a.go") || !strings.Contains(d, "rename to b.go") {
		t.Errorf("rename commit diff missing rename markers:\n%s", d)
	}

	// A binary change -- git reports "Binary files ... differ", no hunks.
	if err := os.WriteFile(filepath.Join(root, "blob.bin"), []byte{0, 9, 9, 0, 9, 9}, 0o644); err != nil {
		t.Fatal(err)
	}
	run("commit", "-qam", "change binary")
	binRev := revParse()
	d = gitShow(root, binRev, "")
	if !strings.Contains(d, "Binary files") {
		t.Errorf("binary commit diff missing binary marker:\n%s", d)
	}

	// Contract with the frontend parser (web/src/diff.js parseGitHeaderPaths):
	// a path with a special byte is emitted as a fully C-quoted token including
	// the a/ b/ prefix -- "a/foo\tbar.bin" -- not a"...". A binary change has no
	// ---/+++ lines, so this quoted "diff --git" header is the only place its name
	// appears; if git's format drifts, the frontend would show an empty filename.
	tabName := "foo\tbar.bin"
	if err := os.WriteFile(filepath.Join(root, tabName), []byte{0, 1, 0}, 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", "-A")
	run("commit", "-qm", "add tab-named binary")
	d = gitShow(root, revParse(), "")
	if !strings.Contains(d, `diff --git "a/foo\tbar.bin" "b/foo\tbar.bin"`) {
		t.Errorf("quoted-header contract broken -- frontend path parser expects fully-quoted a/ b/ tokens:\n%s", d)
	}
}

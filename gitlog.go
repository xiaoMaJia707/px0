package main

import (
	"os/exec"
	"strconv"
	"strings"
)

// commit is one entry in the read-only git log: enough to render a browsable
// list and open the change it introduced.
type commit struct {
	Hash    string `json:"hash"`
	Short   string `json:"short"`
	Author  string `json:"author"`
	Date    string `json:"date"` // ISO 8601, from %aI
	Subject string `json:"subject"`
}

// gitLog returns recent commits, optionally scoped to a single path (that
// file's own history). The bool reports whether the command ran: false means
// git is off/absent or `git log` failed (a bare repo with no commits included),
// so the caller can tell a genuine empty result from a failure.
// Fails quiet -> (nil, false).
//
// Commits are NUL-separated via -z; within a commit the five fields are
// newline-separated (%n). None of the fields can contain a newline -- %H/%h are
// hex, %aI is an ISO date, git forbids newlines in author names (%an), and %s
// is the subject (the first line of the message) by definition -- so a field
// can never absorb or shift another. (A NUL byte inside a field, only reachable
// via a hand-crafted commit object, would still split a record; that is the
// standard limit of any -z parse and is out of scope for normal repositories.)
// --literal-pathspecs keeps a crafted path from turning into pathspec magic
// (e.g. ":(glob)"). The path scope is a literal `git log -- <path>`, so the
// commits it lists are exactly the ones gitShow can display for that path (no
// --follow: that would list pre-rename commits whose diff under the new path is
// empty, showing history the viewer can't open).
func gitLog(root, relpath string, limit int) ([]commit, bool) {
	if !gitAvailable(root) {
		return nil, false
	}
	if limit <= 0 || limit > 1000 {
		limit = 200
	}
	format := "--pretty=format:%H%n%h%n%an%n%aI%n%s"
	args := []string{"--literal-pathspecs", "-C", root, "log", "-z", "-n", strconv.Itoa(limit), format}
	if relpath != "" {
		args = append(args, "--", relpath)
	}
	out, err := exec.Command("git", args...).Output()
	if err != nil {
		return nil, false
	}
	var commits []commit
	for _, rec := range strings.Split(string(out), "\x00") {
		if rec == "" {
			continue
		}
		f := strings.SplitN(rec, "\n", 5)
		if len(f) == 5 {
			commits = append(commits, commit{f[0], f[1], f[2], f[3], f[4]})
		}
	}
	return commits, true
}

// gitShow returns the unified diff a commit introduced, optionally narrowed to
// one file (that file's change in that commit). Fails quiet -> "". The rev must
// pass validRev so a query parameter can never turn into a git flag.
// --no-ext-diff and --no-textconv keep a repository's own git config/attributes
// from running an external diff helper or textconv filter on our behalf.
func gitShow(root, hash, relpath string) string {
	if !gitAvailable(root) || !validRev(hash) {
		return ""
	}
	args := []string{"--literal-pathspecs", "-C", root, "show", "--no-color", "--no-ext-diff", "--no-textconv", "--format=", hash}
	if relpath != "" {
		args = append(args, "--", relpath)
	}
	out, err := exec.Command("git", args...).Output()
	if err != nil {
		return ""
	}
	return string(out)
}

// validRev guards against flag/argument injection: it accepts only the
// characters that make up commit hashes and ordinary ref names, rejects
// anything starting with '-' so a rev can never be read as a git option, and
// rejects ".." so a range (main..other) can't stand in for a single commit.
func validRev(s string) bool {
	if s == "" || strings.HasPrefix(s, "-") || strings.Contains(s, "..") {
		return false
	}
	for _, r := range s {
		if !(r == '/' || r == '.' || r == '_' || r == '-' ||
			(r >= '0' && r <= '9') || (r >= 'a' && r <= 'z') ||
			(r >= 'A' && r <= 'Z')) {
			return false
		}
	}
	return true
}

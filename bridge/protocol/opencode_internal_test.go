package protocol

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// skillFile writes a SKILL.md under root at rel and returns its path.
func skillFile(t *testing.T, root, rel string) string {
	t.Helper()
	path := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("# skill\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestSkillSourceTellsTheProjectsOwnFromTheUsersAndTheAgents(t *testing.T) {
	base := t.TempDir()
	checkout := filepath.Join(base, "billing-api")
	inside := skillFile(t, checkout, ".agents/skills/release/SKILL.md")
	neighbour := skillFile(t, base, "billing-api-other/.agents/skills/neighbour/SKILL.md")
	home := skillFile(t, base, "home/.agents/skills/tdd/SKILL.md")

	cases := []struct {
		name, path, want string
	}{
		{"in the checkout", inside, "project"},
		{"in a folder whose name starts like the checkout's", neighbour, "personal"},
		{"elsewhere on the machine", home, "personal"},
		{"OpenCode's own", "skill://opencode/SKILL.md", "built-in"},
		{"in the checkout, gone since", filepath.Join(checkout, ".agents", "skills", "gone", "SKILL.md"), "project"},
		{"no path", "", ""},
	}
	for _, c := range cases {
		if got := skillSource(c.path, checkout); got != c.want {
			t.Errorf("%s: skillSource(%q) = %q, want %q", c.name, c.path, got, c.want)
		}
	}
}

func TestSkillSourceSeesThroughSymlinks(t *testing.T) {
	base := t.TempDir()
	checkout := filepath.Join(base, "billing-api")
	inside := skillFile(t, checkout, ".agents/skills/release/SKILL.md")
	link := filepath.Join(base, "linked")
	if err := os.Symlink(checkout, link); err != nil {
		t.Skipf("can't make a symlink here: %v", err)
	}
	viaLink := filepath.Join(link, ".agents", "skills", "release", "SKILL.md")

	if got := skillSource(viaLink, checkout); got != "project" {
		t.Errorf("a skill reached through a link to the checkout: got %q, want project", got)
	}
	if got := skillSource(inside, link); got != "project" {
		t.Errorf("a checkout reached through a link: got %q, want project", got)
	}
}

func TestSkillSourceIgnoresCaseOnWindows(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("paths are case-sensitive here")
	}
	checkout := filepath.Join(t.TempDir(), "billing-api")
	inside := skillFile(t, checkout, ".agents/skills/release/SKILL.md")

	if got := skillSource(strings.ToUpper(inside[:1])+inside[1:], strings.ToLower(checkout[:1])+checkout[1:]); got != "project" {
		t.Errorf("a drive letter in another case: got %q, want project", got)
	}
}

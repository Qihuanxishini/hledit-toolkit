package main

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func mainTestCaptureStdout(t *testing.T, fn func()) string {
	t.Helper()
	old := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout = w
	fn()
	_ = w.Close()
	os.Stdout = old
	out, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}
	return string(out)
}

func mainTestRunMain(t *testing.T, args ...string) string {
	t.Helper()
	return mainTestCaptureStdout(t, func() {
		if code := run(args); code != 0 {
			t.Fatalf("run(%v) exit code = %d, want 0", args, code)
		}
	})
}

func mainTestRunForCode(t *testing.T, args ...string) (stdout, stderr string, code int) {
	t.Helper()
	oldOut := os.Stdout
	oldErr := os.Stderr
	outR, outW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	errR, errW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout = outW
	os.Stderr = errW
	code = run(args)
	_ = outW.Close()
	_ = errW.Close()
	os.Stdout = oldOut
	os.Stderr = oldErr
	outBytes, err := io.ReadAll(outR)
	if err != nil {
		t.Fatal(err)
	}
	errBytes, err := io.ReadAll(errR)
	if err != nil {
		t.Fatal(err)
	}
	return string(outBytes), string(errBytes), code
}

func TestSplitArgs(t *testing.T) {
	pos, flags := splitArgs([]string{"main.go", "--offset", "4", "--limit", "3", "-"})
	if got, want := strings.Join(pos, ","), "main.go,-"; got != want {
		t.Fatalf("positionals = %q, want %q", got, want)
	}
	if got, want := strings.Join(flags, ","), "--offset,4,--limit,3"; got != want {
		t.Fatalf("flags = %q, want %q", got, want)
	}

	pos, flags = splitArgs([]string{"--after", "file.go", "1#AA", "-"})
	if got, want := strings.Join(pos, ","), "file.go,1#AA,-"; got != want {
		t.Fatalf("insert positionals = %q, want %q", got, want)
	}
	if got, want := strings.Join(flags, ","), "--after"; got != want {
		t.Fatalf("insert flags = %q, want %q", got, want)
	}

	pos, flags = splitArgs([]string{"-prefix", "file.go", "1#AA"})
	if got, want := strings.Join(pos, ","), "-prefix,file.go,1#AA"; got != want {
		t.Fatalf("dash-prefixed path positionals = %q, want %q", got, want)
	}
	if got := strings.Join(flags, ","); got != "" {
		t.Fatalf("dash-prefixed path flags = %q, want empty", got)
	}
}

func TestMainCapabilities(t *testing.T) {
	out := mainTestRunMain(t, "capabilities")
	var got CLICapabilities
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("capabilities output is not JSON: %q: %v", out, err)
	}
	if !got.OK || got.Version != version || !got.BatchInsertAfter || !got.BatchCheck || !got.BatchUpdatedAnchors || !got.BatchStaleContext || !got.ReadRangeMetadata {
		t.Fatalf("capabilities = %#v, want current batch and structured recovery capabilities", got)
	}
}

func TestMainHelp(t *testing.T) {
	out := mainTestRunMain(t, "help")
	if !strings.Contains(out, "hledit read <file>") || !strings.Contains(out, "Examples:") {
		t.Fatalf("help output missing expected text:\n%s", out)
	}

	stdout, stderr, code := mainTestRunForCode(t)
	if code != 0 || stderr != "" {
		t.Fatalf("run(no args) code/stderr = %d/%q, want 0/empty", code, stderr)
	}
	if !strings.Contains(stdout, "hledit read <file>") || !strings.Contains(stdout, "Examples:") {
		t.Fatalf("no-args help output missing expected text:\n%s", stdout)
	}
}

func TestMainReadAndReadRange(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "main.go")
	content := "package main\n\nfunc main() {}\n"
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}

	out := mainTestRunMain(t, "read", path)
	if !strings.Contains(out, "1#WV:package main") || !strings.Contains(out, "3#") {
		t.Fatalf("read output unexpected:\n%s", out)
	}

	out = mainTestRunMain(t, "read-range", path, "--offset", "3", "--limit", "1")
	if !strings.HasPrefix(out, "3#") || !strings.Contains(out, "func main() {}") {
		t.Fatalf("read-range output unexpected:\n%s", out)
	}

	out = mainTestRunMain(t, "read-range", "--offset", "3", "--limit", "1", path)
	if !strings.HasPrefix(out, "3#") || !strings.Contains(out, "func main() {}") {
		t.Fatalf("read-range flags-first output unexpected:\n%s", out)
	}
}

func TestMainWriteVerbs(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "main.go")
	if err := os.WriteFile(path, []byte("package main\n\nfunc main() {\n\tprintln(\"hi\")\n}\n"), 0644); err != nil {
		t.Fatal(err)
	}

	// replace line 4 using a content file.
	anchor4 := formatTag(4, "\tprintln(\"hi\")")
	repl := filepath.Join(dir, "replace.txt")
	if err := os.WriteFile(repl, []byte("\tprintln(\"bye\")\n"), 0644); err != nil {
		t.Fatal(err)
	}
	out := mainTestRunMain(t, "replace", path, anchor4, repl)
	if !strings.Contains(out, `"ok":true`) || !strings.Contains(out, `"firstChangedLine":4`) {
		t.Fatalf("replace result unexpected: %s", out)
	}

	// insert after line 1. Use flags after positionals to cover splitArgs path.
	anchor1 := formatTag(1, "package main")
	ins := filepath.Join(dir, "insert.txt")
	if err := os.WriteFile(ins, []byte("// generated\n"), 0644); err != nil {
		t.Fatal(err)
	}
	out = mainTestRunMain(t, "insert", path, anchor1, ins, "--after")
	if !strings.Contains(out, `"ok":true`) || !strings.Contains(out, `"firstChangedLine":2`) {
		t.Fatalf("insert result unexpected: %s", out)
	}

	// replace-range delete the now-empty line 3 through func line 4.
	current, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSuffix(string(current), "\n"), "\n")
	start := formatTag(3, lines[2])
	end := formatTag(4, lines[3])
	empty := filepath.Join(dir, "empty.txt")
	if err := os.WriteFile(empty, nil, 0644); err != nil {
		t.Fatal(err)
	}
	out = mainTestRunMain(t, "replace-range", path, start, end, empty)
	if !strings.Contains(out, `"ok":true`) || !strings.Contains(out, `"firstChangedLine":3`) {
		t.Fatalf("replace-range result unexpected: %s", out)
	}
}

func TestRunMisuseAndUnknownVerb(t *testing.T) {
	tests := [][]string{
		{"read"},
		{"read-range", "file.go", "extra.go"},
		{"replace", "file.go", "1#AA"},
		{"replace-range", "file.go", "1#AA", "2#BB"},
		{"insert", "--before", "--after", "file.go", "1#AA", "-"},
		{"bogus"},
	}
	for _, args := range tests {
		_, stderr, code := mainTestRunForCode(t, args...)
		if code != 2 {
			t.Fatalf("run(%v) code = %d, want 2", args, code)
		}
		if !strings.Contains(stderr, "hledit") {
			t.Fatalf("run(%v) stderr missing usage text: %q", args, stderr)
		}
	}
}

func TestMustRun(t *testing.T) {
	if code := mustRun(nil); code != 0 {
		t.Fatalf("mustRun(nil) = %d, want 0", code)
	}
	_, stderr, code := mainTestRunForCode(t, "help")
	if code != 0 || stderr != "" {
		t.Fatalf("run(help) code/stderr = %d/%q, want 0/empty", code, stderr)
	}
	stderr = mainTestCaptureStderr(t, func() {
		if code := mustRun(os.ErrPermission); code != 1 {
			t.Fatalf("mustRun(error) = %d, want 1", code)
		}
	})
	if !strings.Contains(stderr, os.ErrPermission.Error()) {
		t.Fatalf("mustRun(error) stderr = %q", stderr)
	}
}

func mainTestCaptureStderr(t *testing.T, fn func()) string {
	t.Helper()
	old := os.Stderr
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stderr = w
	fn()
	_ = w.Close()
	os.Stderr = old
	out, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}
	return string(out)
}

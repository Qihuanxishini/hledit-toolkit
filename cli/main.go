package main

import (
	"flag"
	"fmt"
	"io"
	"os"
)

const version = "3.2.0"

// splitArgs lets the small command parsers accept flags before or after
// positional arguments. A standard -- separator protects flag-like paths and
// search patterns; everything after it is positional.
func splitArgs(args []string) (positionals []string, flags []string) {
	valueFlags := map[string]bool{
		"-offset": true, "--offset": true,
		"-limit": true, "--limit": true,
		"-context": true, "--context": true,
	}
	boolFlags := map[string]bool{
		"--check": true, "-check": true,
		"--ignore-case": true, "-ignore-case": true,
		"--literal": true, "-literal": true,
	}
	positionalOnly := false
	for i := 0; i < len(args); i++ {
		a := args[i]
		if positionalOnly {
			positionals = append(positionals, a)
			continue
		}
		if a == "--" {
			positionalOnly = true
			continue
		}
		if a == "-" {
			positionals = append(positionals, a)
			continue
		}
		if valueFlags[a] {
			flags = append(flags, a)
			if i+1 < len(args) {
				flags = append(flags, args[i+1])
				i++
			}
			continue
		}
		if boolFlags[a] {
			flags = append(flags, a)
			continue
		}
		positionals = append(positionals, a)
	}
	return positionals, flags
}

func newFlagSet(name string) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	return fs
}

const usage = `hledit — hash-anchored line editor for AI coding agents

Usage:
  hledit --version
  hledit capabilities
  hledit read-range <file> [--offset N] [--limit M]
  hledit search <file> <pattern> [--offset N] [--limit M] [--literal] [--context N] [--ignore-case]
  hledit batch [--check] <file>

Arguments:
  <pattern>         RE2 regular expression used by search; --literal switches to exact text
  --offset          1-indexed physical line cursor (default: read 1, search 1)
  --limit           maximum lines returned (default: read 160, search 100)
  --literal         treat the search pattern as an exact literal substring
  --context         include N surrounding lines for each search match
  --ignore-case     match the search pattern case-insensitively

Batch input (JSON on stdin):
  {"edits": [
    {"op": "replace", "pos": "12#aB3", "lines": ["new line"]},
    {"op": "replace", "pos": "12#aB3", "end_pos": "18#xY7", "lines": ["new block"]},
    {"op": "delete", "pos": "5#nK2"},
    {"op": "insert", "pos": "8#Qw_", "after": true, "lines": ["inserted"]}
  ]}

Examples:
  hledit read-range main.go --offset 40 --limit 20
  hledit search main.go "Register[A-Za-z0-9_]+" --context 2
  echo '{"edits":[{"op":"replace","pos":"12#aB3","lines":["fixed"]}]}' | hledit batch main.go
  echo '{"edits":[{"op":"replace","pos":"12#aB3","lines":["fixed"]}]}' | hledit batch --check main.go

Notes:
  - read-range and search always emit structured JSON for the Pi extension.
  - A source line that cannot fit a complete JSON page is marked textTruncated and cannot establish proof.
  - batch validates all anchors before applying non-overlapping edits atomically.
  - Logical errors exit 0 and are reported as JSON on stdout; CLI misuse exits 2.
`

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(argv []string) int {
	if len(argv) < 1 {
		fmt.Print(usage)
		return 0
	}
	if argv[0] == "--version" || argv[0] == "-v" {
		fmt.Printf("hledit %s\n", version)
		return 0
	}

	verb := argv[0]
	args := argv[1:]
	switch verb {
	case "read-range":
		positionals, flagArgs := splitArgs(args)
		fs := newFlagSet("read-range")
		offset := fs.Int("offset", 1, "1-indexed starting line")
		limit := fs.Int("limit", 160, "max lines to return")
		if err := fs.Parse(flagArgs); err != nil || len(positionals) != 1 {
			fmt.Fprint(os.Stderr, usage)
			return 2
		}
		return mustRun(cmdReadRange(positionals[0], *offset, *limit))

	case "search":
		positionals, flagArgs := splitArgs(args)
		fs := newFlagSet("search")
		offset := fs.Int("offset", 1, "1-indexed starting line")
		limit := fs.Int("limit", 100, "max matching/context lines to return")
		literal := fs.Bool("literal", false, "treat the pattern as an exact literal string")
		contextN := fs.Int("context", 0, "include N surrounding lines for each match")
		ignoreCase := fs.Bool("ignore-case", false, "match the pattern case-insensitively")
		if err := fs.Parse(flagArgs); err != nil || len(positionals) != 2 {
			fmt.Fprint(os.Stderr, usage)
			return 2
		}
		return mustRun(cmdSearch(positionals[0], positionals[1], *offset, *limit, *literal, *contextN, *ignoreCase))

	case "batch":
		positionals, flagArgs := splitArgs(args)
		fs := newFlagSet("batch")
		check := fs.Bool("check", false, "validate only, do not write")
		if err := fs.Parse(flagArgs); err != nil || len(positionals) != 1 {
			fmt.Fprint(os.Stderr, usage)
			return 2
		}
		if *check {
			return mustRun(runBatchCheck(positionals[0]))
		}
		return mustRun(runBatchApply(positionals[0]))

	case "version":
		fmt.Printf("hledit %s\n", version)
		return 0

	case "capabilities":
		return mustRun(emitJSON(CLICapabilities{
			OK:                  true,
			Version:             version,
			AnchorProtocolV2:    true,
			BatchInsertAfter:    true,
			BatchCheck:          true,
			BatchUpdatedAnchors: true,
			BatchStaleContext:   true,
			ReadRangeMetadata:   true,
			BatchWireV3:         true,
			BatchReadProof:      true,
			BatchEditDeltas:     true,
			SearchIgnoreCase:    true,
			SearchRegex:         true,
			SearchLiteral:       true,
			Search:              true,
		}))

	case "-h", "--help", "help":
		fmt.Print(usage)
		return 0

	default:
		fmt.Fprintf(os.Stderr, "unknown verb %q\n\n%s", verb, usage)
		return 2
	}
}

// mustRun maps infrastructure failures to exit 1. Logical command errors emit
// their JSON response and return nil, so they intentionally keep exit 0.
func mustRun(err error) int {
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}

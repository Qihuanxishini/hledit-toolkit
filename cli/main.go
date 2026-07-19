package main

import (
	"flag"
	"fmt"
	"os"
)

const version = "1.4.0"

// splitArgs separates a command's args into flags and positionals so that
// flags may appear before OR after the positional file argument (e.g.
// "read-range main.go --offset 4" and "read-range --offset 4 main.go" both
// work). Go's flag package stops at the first non-flag arg, so we reorder.
// A bare "-" is treated as a positional (stdin content-source).
func splitArgs(args []string) (positionals []string, flags []string) {
	// Flags that take a value ("-x v" form) in our subcommands.
	valueFlags := map[string]bool{"-offset": true, "--offset": true, "-limit": true, "--limit": true, "-grep": true, "--grep": true, "-context": true, "--context": true}
	boolFlags := map[string]bool{"--before": true, "--after": true, "--json": true, "-json": true, "--pretty": true, "-pretty": true, "--check": true, "-check": true}
	for i := 0; i < len(args); i++ {
		a := args[i]
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
		if len(a) > 0 && a[0] == '-' {
			positionals = append(positionals, a)
			continue
		}
		positionals = append(positionals, a)
	}
	return positionals, flags
}

const usage = `hledit — hash-anchored line editor for AI coding agents

Usage:
  hledit --version
  hledit capabilities
  hledit read <file> [--grep <pattern>] [--context N] [--json] [--pretty]
  hledit read-range <file> [--offset N] [--limit M] [--grep <pattern>] [--context N] [--json] [--pretty]
  hledit anchors <file> [--offset N] [--limit M] [--grep <pattern>] [--context N] [--json] [--pretty]
  hledit replace <file> <anchor> <content-source>
  hledit replace-range <file> <anchor> <end-anchor> <content-source>
  hledit insert [--before|--after] <file> <anchor> <content-source>
  hledit batch [--check] <file>

Arguments:
  <anchor>          LN#HH from a prior read, e.g. 5#WS
  <content-source>  - for stdin, or a file path

Batch input (JSON on stdin):
  {"edits": [
    {"op": "replace", "pos": "12#NK", "lines": ["new line"]},
    {"op": "replace", "pos": "12#NK", "end_pos": "18#VR", "lines": ["new block"]},
    {"op": "delete", "pos": "5#TX", "lines": []},
    {"op": "insert", "pos": "8#VR", "after": true, "lines": ["inserted"]}
  ]}

Examples:
  hledit read main.go
  hledit read-range main.go --offset 40 --limit 20
  printf '  return nil\n' | hledit replace main.go 12#NK -
  hledit replace-range main.go 12#NK 18#VR /tmp/new-block.txt
  cat header.txt | hledit insert --before main.go 1#WV -
  printf '// done\n' | hledit insert --after main.go 99#TX -
  echo '{"edits":[{"op":"replace","pos":"12#NK","lines":["fixed"]}]}' | hledit batch main.go
  echo '{"edits":[{"op":"replace","pos":"12#NK","lines":["fixed"]}]}' | hledit batch --check main.go

Notes:
  - replace/replace-range with empty content deletes the target line/range.
  - batch applies multiple edits atomically: all anchors validated first,
    then the non-overlapping edits rebuild the file once before a single atomic write.
  - batch insert supports "after": true; omit it or set false to insert before the anchor.
  - batch --check validates all anchors and ops without writing; result includes checked:true.
  - All write verbs validate anchors before writing. If any anchor is stale,
    nothing is written and stdout contains JSON {"ok":false,"error":"stale",...}.
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

	// Handle --version globally
	if argv[0] == "--version" || argv[0] == "-v" {
		fmt.Printf("hledit %s\n", version)
		return 0
	}

	verb := argv[0]
	args := argv[1:]

	switch verb {
	case "read":
		positionals, flagArgs := splitArgs(args)
		fs := flag.NewFlagSet("read", flag.ExitOnError)
		grep := fs.String("grep", "", "filter lines by substring match")
		contextN := fs.Int("context", 0, "include N surrounding lines for each grep match")
		pretty := fs.Bool("pretty", false, "emit ANSI-styled text for human reading")
		jsonOut := fs.Bool("json", false, "emit structured JSON instead of annotated text")
		fs.Parse(flagArgs)
		if len(positionals) != 1 {
			fmt.Fprint(os.Stderr, usage)
			return 2
		}
		return mustRun(cmdReadPretty(positionals[0], *grep, *contextN, *jsonOut, *pretty))

	case "read-range":
		positionals, flagArgs := splitArgs(args)
		fs := flag.NewFlagSet("read-range", flag.ExitOnError)
		offset := fs.Int("offset", 1, "1-indexed starting line")
		limit := fs.Int("limit", 2000, "max lines to return")
		grep := fs.String("grep", "", "filter lines by substring match")
		contextN := fs.Int("context", 0, "include N surrounding lines for each grep match")
		pretty := fs.Bool("pretty", false, "emit ANSI-styled text for human reading")
		jsonOut := fs.Bool("json", false, "emit structured JSON instead of annotated text")
		fs.Parse(flagArgs)
		if len(positionals) != 1 {
			fmt.Fprint(os.Stderr, usage)
			return 2
		}
		return mustRun(cmdReadRangePretty(positionals[0], *offset, *limit, *grep, *contextN, *jsonOut, *pretty))

	case "anchors":
		positionals, flagArgs := splitArgs(args)
		fs := flag.NewFlagSet("anchors", flag.ExitOnError)
		offset := fs.Int("offset", 1, "1-indexed starting line")
		limit := fs.Int("limit", 2000, "max lines to return")
		grep := fs.String("grep", "", "filter lines by substring match")
		contextN := fs.Int("context", 0, "include N surrounding lines for each grep match")
		pretty := fs.Bool("pretty", false, "emit ANSI-styled text for human reading")
		jsonOut := fs.Bool("json", false, "emit structured JSON instead of annotated text")
		fs.Parse(flagArgs)
		if len(positionals) != 1 {
			fmt.Fprint(os.Stderr, usage)
			return 2
		}
		return mustRun(cmdAnchorsPretty(positionals[0], *offset, *limit, *grep, *contextN, *jsonOut, *pretty))

	case "replace":
		if len(args) != 3 {
			fmt.Fprint(os.Stderr, usage)
			return 2
		}
		return mustRun(cmdReplace(args[0], args[1], args[2]))

	case "replace-range":
		if len(args) != 4 {
			fmt.Fprint(os.Stderr, usage)
			return 2
		}
		return mustRun(cmdReplaceRange(args[0], args[1], args[2], args[3]))

	case "insert":
		positionals, flagArgs := splitArgs(args)
		fs := flag.NewFlagSet("insert", flag.ExitOnError)
		before := fs.Bool("before", false, "insert before the anchor (default)")
		after := fs.Bool("after", false, "insert after the anchor")
		fs.Parse(flagArgs)
		if len(positionals) != 3 || (*before && *after) {
			fmt.Fprint(os.Stderr, usage)
			return 2
		}
		return mustRun(cmdInsert(positionals[0], positionals[1], positionals[2], *after))

	case "batch":
		positionals, flagArgs := splitArgs(args)
		fs := flag.NewFlagSet("batch", flag.ExitOnError)
		check := fs.Bool("check", false, "validate only, do not write")
		fs.Parse(flagArgs)
		if len(positionals) != 1 {
			fmt.Fprint(os.Stderr, usage)
			return 2
		}
		return mustRun(cmdBatch(positionals[0], *check))

	case "version":
		fmt.Printf("hledit %s\n", version)
		return 0

	case "capabilities":
		return mustRun(emitJSON(CLICapabilities{
			OK:                  true,
			Version:             version,
			BatchInsertAfter:    true,
			BatchUpdatedAnchors: true,
			ReadRangeMetadata:   true,
		}))

	case "-h", "--help", "help":
		fmt.Print(usage)
		return 0

	default:
		fmt.Fprintf(os.Stderr, "unknown verb %q\n\n%s", verb, usage)
		return 2
	}
}

// mustRun handles the return value of a cmd* function. Per SPEC §9, cmd*
// functions return nil for all logical errors (they emit JSON themselves);
// a non-nil return indicates an unrecoverable infrastructure failure → exit 1.
func mustRun(err error) int {
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}

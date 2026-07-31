package main

import (
	"fmt"
	"os"
)

const version = "1.0.0"

const usage = `Snapline — snapshot-bound transactional text editing

Usage:
  snapline --version
  snapline capabilities
  snapline read       # JSON request on stdin; JSON result on stdout
  snapline apply      # JSON request on stdin; JSON result on stdout

Logical wire results, including safe rejections, use exit code 0.
Command misuse uses exit code 2. Infrastructure or uncertain failures use exit code 1.
`

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(argv []string) int {
	if len(argv) == 0 {
		fmt.Print(usage)
		return 0
	}
	if argv[0] == "--version" {
		if len(argv) != 1 {
			fmt.Fprint(os.Stderr, usage)
			return 2
		}
		fmt.Printf("Snapline %s\n", version)
		return 0
	}

	if len(argv) != 1 {
		fmt.Fprint(os.Stderr, usage)
		return 2
	}
	switch argv[0] {
	case "capabilities":
		return mustRun(emitWireJSON(SnaplineCapabilities{
			OK:                         true,
			Product:                    "snapline",
			Version:                    version,
			WireProtocol:               snaplineProtocolVersion,
			RawRevision:                "sha256",
			MultiWindowRead:            true,
			BoundedBinaryPreflight:     true,
			GroupedAtomicApply:         true,
			CompleteReadProof:          true,
			PreCommitRevisionCheck:     true,
			StructuredEditEffects:      true,
			StructuredRecoveryContexts: true,
		}))
	case "read":
		return mustRun(runSnaplineRead())
	case "apply":
		return mustRun(runSnaplineApply())
	case "-h", "--help", "help":
		fmt.Print(usage)
		return 0
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n%s", argv[0], usage)
		return 2
	}
}

func mustRun(err error) int {
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}

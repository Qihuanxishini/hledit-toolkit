package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"slices"
	"strings"
)

func readContentLines(contentSrc string) ([]string, error) {
	var raw []byte
	var err error
	if contentSrc == "-" {
		raw, err = io.ReadAll(os.Stdin)
	} else {
		raw, err = os.ReadFile(contentSrc)
	}
	if err != nil {
		return nil, err
	}

	s := strings.ReplaceAll(string(raw), "\r\n", "\n")
	s = strings.TrimRight(s, "\n")
	if s == "" {
		return []string{}, nil
	}
	return strings.Split(s, "\n"), nil
}

func contentSourceErrorMessage(contentSrc string, err error) string {
	if contentSrc == "" {
		return "content-source argument is empty; replace/replace-range/insert expect <content-source> to be '-' for stdin or a file path. To delete, pipe empty stdin and use '-' as the content-source, e.g. printf '' | hledit replace <file> <anchor> -"
	}
	return fmt.Sprintf("content-source argument %q could not be read: %v. If you intended literal replacement text, pipe it on stdin and use '-' as the content-source", contentSrc, err)
}

func targetFileErrorMessage(path string, err error) string {
	return fmt.Sprintf("file argument %q could not be read: %v", path, err)
}

func loadEditableFile(path string) (LoadedTextFile, error) {
	file, err := loadTextFile(path)
	if err == nil {
		return file, nil
	}
	if errors.Is(err, errBinaryFile) {
		emitError("binary", "file appears to be binary")
		return LoadedTextFile{}, err
	}
	if errors.Is(err, errInvalidUTF8) {
		emitError("encoding", "file is not valid UTF-8")
		return LoadedTextFile{}, err
	}
	emitError("io", targetFileErrorMessage(path, err))
	return LoadedTextFile{}, err
}

func emitJSON(v any) error {
	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	return enc.Encode(v)
}

func emitResult(firstChanged, lastChanged, linesAdded, linesDeleted int, contentChanged bool, warning string) error {
	result := EditResult{
		OK: true, FirstChangedLine: firstChanged, LastChangedLine: lastChanged,
		LinesAdded: linesAdded, LinesDeleted: linesDeleted, ContentChanged: contentChanged,
	}
	if warning != "" {
		result.Warnings = []string{warning}
	}
	return emitJSON(result)
}

func emitStaleError(remaps []Remap, msg string) error {
	return emitJSON(EditError{OK: false, Error: "stale", Remaps: remaps, Message: msg})
}

func emitInvalidError(msg string) error {
	return emitJSON(EditError{OK: false, Error: "invalid", Message: msg})
}

// editOp applies a validated edit operation to the file.
// It handles: loading, anchor validation, content reading, applying the edit,
// atomic write with trailing newline preservation, and result emission.
// apply is a callback that receives the current lines and new content lines,
// and returns the resulting lines plus edit metadata.
func editOp(
	path string,
	anchors []Anchor,
	contentSrc string,
	apply func(lines []string, newLines []string) (result []string, firstChanged int, lastChanged int, linesAdded int, linesDeleted int, err error),
) error {
	file, err := loadEditableFile(path)
	if err != nil {
		return nil
	}
	lines := file.Lines

	for _, a := range anchors {
		if a.Line < 1 || a.Line > len(lines) {
			emitStaleError([]Remap{}, fmt.Sprintf("anchor %d#%s: stale", a.Line, a.Hash))
			return nil
		}
	}

	remaps, firstBad := validateAnchors(lines, anchors)
	if firstBad >= 0 {
		emitStaleError(remaps, fmt.Sprintf("anchor %d#%s: stale", anchors[firstBad].Line, anchors[firstBad].Hash))
		return nil
	}

	newLines, cerr := readContentLines(contentSrc)
	if cerr != nil {
		emitError("io", contentSourceErrorMessage(contentSrc, cerr))
		return nil
	}

	result, firstChanged, lastChanged, linesAdded, linesDeleted, aerr := apply(lines, newLines)
	if aerr != nil {
		emitInvalidError(aerr.Error())
		return nil
	}

	contentChanged := !slices.Equal(lines, result)
	writeWarning := ""
	if contentChanged {
		joined := file.JoinLines(result)
		var werr error
		writeWarning, werr = atomicWrite(path, []byte(joined))
		if werr != nil {
			emitError("io", werr.Error())
			return nil
		}
	}

	emitResult(firstChanged, lastChanged, linesAdded, linesDeleted, contentChanged, writeWarning)
	return nil
}

func cmdReplace(path, anchorStr, contentSrc string) error {
	a, perr := parseAnchor(anchorStr)
	if perr != nil {
		emitInvalidError(perr.Error())
		return nil
	}

	return editOp(path, []Anchor{a}, contentSrc, func(lines, newLines []string) ([]string, int, int, int, int, error) {
		before := append([]string{}, lines[:a.Line-1]...)
		result := append(before, newLines...)
		result = append(result, lines[a.Line:]...)
		return result, a.Line, a.Line, len(newLines), 1, nil
	})
}

func cmdReplaceRange(path, anchorStr, endAnchorStr, contentSrc string) error {
	a, perr := parseAnchor(anchorStr)
	if perr != nil {
		emitInvalidError(perr.Error())
		return nil
	}
	e, perr2 := parseAnchor(endAnchorStr)
	if perr2 != nil {
		emitInvalidError(perr2.Error())
		return nil
	}
	if a.Line > e.Line {
		emitInvalidError(fmt.Sprintf("start line %d > end line %d", a.Line, e.Line))
		return nil
	}

	return editOp(path, []Anchor{a, e}, contentSrc, func(lines, newLines []string) ([]string, int, int, int, int, error) {
		before := lines[:a.Line-1]
		after := lines[e.Line:]
		result := append(append([]string{}, before...), newLines...)
		result = append(result, after...)
		return result, a.Line, e.Line, len(newLines), e.Line - a.Line + 1, nil
	})
}

func cmdInsert(path, anchorStr, contentSrc string, after bool) error {
	a, perr := parseAnchor(anchorStr)
	if perr != nil {
		emitInvalidError(perr.Error())
		return nil
	}

	return editOp(path, []Anchor{a}, contentSrc, func(lines, newLines []string) ([]string, int, int, int, int, error) {
		if len(newLines) == 0 {
			return nil, 0, 0, 0, 0, fmt.Errorf("insert requires non-empty content")
		}
		cutIdx := a.Line - 1
		firstChanged := a.Line
		if after {
			cutIdx = a.Line
			firstChanged = a.Line + 1
		}
		result := append([]string{}, lines[:cutIdx]...)
		result = append(result, newLines...)
		result = append(result, lines[cutIdx:]...)
		return result, firstChanged, firstChanged + len(newLines) - 1, len(newLines), 0, nil
	})
}

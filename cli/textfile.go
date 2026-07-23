package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"strings"
	"unicode/utf8"
)

var (
	errBinaryFile  = errors.New("file appears to be binary")
	errInvalidUTF8 = errors.New("file is not valid UTF-8")
)

const utf8BOM = "\xEF\xBB\xBF"

func rawFileRevision(content []byte) string {
	digest := sha256.Sum256(content)
	return "sha256:" + hex.EncodeToString(digest[:])
}

type LoadedTextFile struct {
	Lines              []string
	LineEnding         string
	HasTrailingNewline bool
	HasUTF8BOM         bool
	Revision           string
}

func loadTextFile(path string) (LoadedTextFile, error) {
	content, err := os.ReadFile(path)
	if err != nil {
		return LoadedTextFile{}, err
	}
	return parseTextFile(content)
}

func parseTextFile(content []byte) (LoadedTextFile, error) {
	searchLimit := len(content)
	if searchLimit > 8192 {
		searchLimit = 8192
	}
	if bytes.IndexByte(content[:searchLimit], 0x00) >= 0 {
		return LoadedTextFile{}, errBinaryFile
	}
	if !utf8.Valid(content) {
		return LoadedTextFile{}, errInvalidUTF8
	}
	revision := rawFileRevision(content)

	hasUTF8BOM := bytes.HasPrefix(content, []byte(utf8BOM))
	if hasUTF8BOM {
		content = content[len(utf8BOM):]
	}

	lineEnding := "\n"
	if bytes.Contains(content, []byte("\r\n")) {
		lineEnding = "\r\n"
	}

	text := string(content)
	hasTrailingNewline := strings.HasSuffix(text, "\n")
	lines := splitTextFile(text)
	return LoadedTextFile{
		Lines:              lines,
		LineEnding:         lineEnding,
		HasTrailingNewline: hasTrailingNewline,
		HasUTF8BOM:         hasUTF8BOM,
		Revision:           revision,
	}, nil
}

func splitTextFile(text string) []string {
	lines := strings.Split(text, "\n")
	if len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	for i := range lines {
		lines[i] = strings.TrimSuffix(lines[i], "\r")
	}
	return lines
}

func (f LoadedTextFile) JoinLines(lines []string) string {
	joined := strings.Join(lines, f.LineEnding)
	if f.HasTrailingNewline && len(lines) > 0 {
		joined += f.LineEnding
	}
	if f.HasUTF8BOM {
		joined = utf8BOM + joined
	}
	return joined
}

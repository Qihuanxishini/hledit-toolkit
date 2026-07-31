package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
)

const snaplineImageSniffBytes = 4100

type snaplineLoadedTarget struct {
	CanonicalPath string
	File          LoadedTextFile
	Info          os.FileInfo
	ParentInfo    os.FileInfo
}

func resolveExistingSnaplineTarget(path string) (string, os.FileInfo, *SnaplineLogicalFailure) {
	absolutePath, err := filepath.Abs(path)
	if err != nil {
		return "", nil, snaplineFailure("invalid_request", fmt.Sprintf("resolve target path: %v", err))
	}
	resolvedPath, err := filepath.EvalSymlinks(absolutePath)
	if err != nil {
		failure := classifySnaplinePathError(err, "resolve target")
		return "", nil, failure
	}
	resolvedPath, err = filepath.Abs(resolvedPath)
	if err != nil {
		return "", nil, snaplineFailure("invalid_request", fmt.Sprintf("resolve canonical target path: %v", err))
	}
	info, err := os.Lstat(resolvedPath)
	if err != nil {
		failure := classifySnaplinePathError(err, "inspect target")
		return "", nil, failure
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		failure := snaplineFailure("target_not_regular", "target is not a regular file")
		failure.Path = resolvedPath
		return "", nil, failure
	}
	return filepath.Clean(resolvedPath), info, nil
}

func classifySnaplinePathError(err error, action string) *SnaplineLogicalFailure {
	code := "write_failed_before_replace"
	switch {
	case errors.Is(err, fs.ErrNotExist):
		code = "target_not_found"
	case errors.Is(err, fs.ErrPermission):
		code = "permission_denied"
	}
	return snaplineFailure(code, fmt.Sprintf("%s: %v", action, err))
}

func readSnaplineTarget(path string) (snaplineLoadedTarget, *SnaplineLogicalFailure) {
	canonicalPath, expectedInfo, failure := resolveExistingSnaplineTarget(path)
	if failure != nil {
		return snaplineLoadedTarget{}, failure
	}
	parentPath := filepath.Dir(canonicalPath)
	expectedParentInfo, err := os.Lstat(parentPath)
	if err != nil || expectedParentInfo.Mode()&os.ModeSymlink != 0 || !expectedParentInfo.IsDir() {
		if err != nil {
			failure = classifySnaplinePathError(err, "inspect target parent")
		} else {
			failure = snaplineFailure("target_not_regular", "target parent is not a canonical directory")
		}
		failure.Path = canonicalPath
		return snaplineLoadedTarget{}, failure
	}
	file, err := os.Open(canonicalPath)
	if err != nil {
		failure = classifySnaplinePathError(err, "open target")
		failure.Path = canonicalPath
		return snaplineLoadedTarget{}, failure
	}
	defer file.Close()

	openedInfo, err := file.Stat()
	if err != nil {
		failure = classifySnaplinePathError(err, "inspect opened target")
		failure.Path = canonicalPath
		return snaplineLoadedTarget{}, failure
	}
	if !openedInfo.Mode().IsRegular() || !os.SameFile(expectedInfo, openedInfo) {
		failure = snaplineFailure("target_not_regular", "target identity changed while opening")
		failure.Path = canonicalPath
		return snaplineLoadedTarget{}, failure
	}

	prefix := make([]byte, snaplineImageSniffBytes)
	prefixLength, readErr := io.ReadFull(file, prefix)
	if readErr != nil && !errors.Is(readErr, io.EOF) && !errors.Is(readErr, io.ErrUnexpectedEOF) {
		failure = classifySnaplinePathError(readErr, "read target preflight")
		failure.Path = canonicalPath
		return snaplineLoadedTarget{}, failure
	}
	prefix = prefix[:prefixLength]
	if supportedSnaplineImageCandidate(prefix) {
		failure = snaplineFailure("image_candidate", "target matches a supported image signature")
		failure.Path = canonicalPath
		return snaplineLoadedTarget{}, failure
	}
	if bytes.IndexByte(prefix, 0) >= 0 {
		failure = snaplineFailure("unsupported_file", "target contains NUL bytes")
		failure.Path = canonicalPath
		return snaplineLoadedTarget{}, failure
	}

	remainder, err := io.ReadAll(file)
	if err != nil {
		failure = classifySnaplinePathError(err, "read target")
		failure.Path = canonicalPath
		return snaplineLoadedTarget{}, failure
	}
	content := make([]byte, 0, len(prefix)+len(remainder))
	content = append(content, prefix...)
	content = append(content, remainder...)
	loaded, err := parseTextFile(content)
	if err != nil {
		switch {
		case errors.Is(err, errBinaryFile):
			failure = snaplineFailure("unsupported_file", "target contains NUL bytes")
		case errors.Is(err, errInvalidUTF8):
			failure = snaplineFailure("invalid_utf8", "target is not valid UTF-8")
		default:
			failure = snaplineFailure("write_failed_before_replace", err.Error())
		}
		failure.Path = canonicalPath
		return snaplineLoadedTarget{}, failure
	}
	currentInfo, err := os.Lstat(canonicalPath)
	if err != nil || !currentInfo.Mode().IsRegular() || !os.SameFile(openedInfo, currentInfo) {
		if err != nil {
			failure = classifySnaplinePathError(err, "recheck target identity")
		} else {
			failure = snaplineFailure("snapshot_stale", "target identity changed while reading")
		}
		failure.Path = canonicalPath
		return snaplineLoadedTarget{}, failure
	}
	currentParentInfo, err := os.Lstat(parentPath)
	if err != nil || currentParentInfo.Mode()&os.ModeSymlink != 0 || !currentParentInfo.IsDir() || !os.SameFile(expectedParentInfo, currentParentInfo) {
		if err != nil {
			failure = classifySnaplinePathError(err, "recheck target parent identity")
		} else {
			failure = snaplineFailure("snapshot_stale", "target parent identity changed while reading")
		}
		failure.Path = canonicalPath
		return snaplineLoadedTarget{}, failure
	}
	return snaplineLoadedTarget{
		CanonicalPath: canonicalPath,
		File:          loaded,
		Info:          currentInfo,
		ParentInfo:    currentParentInfo,
	}, nil
}

func supportedSnaplineImageCandidate(content []byte) bool {
	if startsWithBytes(content, []byte{0xff, 0xd8, 0xff}) {
		return len(content) < 4 || content[3] != 0xf7
	}
	pngSignature := []byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a}
	if startsWithBytes(content, pngSignature) {
		return validStaticPNG(content)
	}
	if startsWithASCII(content, 0, "GIF") {
		return true
	}
	if startsWithASCII(content, 0, "RIFF") && startsWithASCII(content, 8, "WEBP") {
		return true
	}
	return startsWithASCII(content, 0, "BM") && validBMP(content)
}

func validStaticPNG(content []byte) bool {
	if len(content) < 16 || binary.BigEndian.Uint32(content[8:12]) != 13 || !startsWithASCII(content, 12, "IHDR") {
		return false
	}
	for offset := 8; offset+8 <= len(content); {
		chunkLength := int64(binary.BigEndian.Uint32(content[offset : offset+4]))
		chunkTypeOffset := offset + 4
		if startsWithASCII(content, chunkTypeOffset, "acTL") {
			return false
		}
		if startsWithASCII(content, chunkTypeOffset, "IDAT") {
			return true
		}
		nextOffset := int64(offset) + 8 + chunkLength + 4
		if nextOffset <= int64(offset) || nextOffset > int64(len(content)) {
			return true
		}
		offset = int(nextOffset)
	}
	return true
}

func validBMP(content []byte) bool {
	if len(content) < 26 {
		return false
	}
	declaredSize := binary.LittleEndian.Uint32(content[2:6])
	pixelOffset := binary.LittleEndian.Uint32(content[10:14])
	dibSize := binary.LittleEndian.Uint32(content[14:18])
	if declaredSize != 0 && declaredSize < 26 {
		return false
	}
	if uint64(pixelOffset) < uint64(14)+uint64(dibSize) {
		return false
	}
	if declaredSize != 0 && pixelOffset >= declaredSize {
		return false
	}
	var planes, bitsPerPixel uint16
	switch {
	case dibSize == 12:
		planes = binary.LittleEndian.Uint16(content[22:24])
		bitsPerPixel = binary.LittleEndian.Uint16(content[24:26])
	case dibSize >= 40 && dibSize <= 124:
		if len(content) < 30 {
			return false
		}
		planes = binary.LittleEndian.Uint16(content[26:28])
		bitsPerPixel = binary.LittleEndian.Uint16(content[28:30])
	default:
		return false
	}
	if planes != 1 {
		return false
	}
	switch bitsPerPixel {
	case 1, 4, 8, 16, 24, 32:
		return true
	default:
		return false
	}
}

func startsWithBytes(content, prefix []byte) bool {
	return len(content) >= len(prefix) && bytes.Equal(content[:len(prefix)], prefix)
}

func startsWithASCII(content []byte, offset int, text string) bool {
	if offset < 0 || len(content) < offset+len(text) {
		return false
	}
	for index := range text {
		if content[offset+index] != text[index] {
			return false
		}
	}
	return true
}

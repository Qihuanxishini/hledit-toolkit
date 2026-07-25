package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
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

// LineEnding 是单行的 terminator。孤立 \r 属于行文本，不是 terminator；
// NoLineEnding 只允许出现在无 trailing newline 文件的末行。
type LineEnding uint8

const (
	NoLineEnding LineEnding = iota
	LFLineEnding
	CRLFLineEnding
)

func (ending LineEnding) bytes() string {
	switch ending {
	case LFLineEnding:
		return "\n"
	case CRLFLineEnding:
		return "\r\n"
	}
	return ""
}

// LoadedTextFile 逐行保存 terminator，不变量 len(Lines) == len(LineEndings)。
// trailing newline 的存在性由末行 terminator 表达（NoLineEnding = 无）。
type LoadedTextFile struct {
	Lines       []string
	LineEndings []LineEnding
	HasUTF8BOM  bool
	Revision    string
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

	lines, endings := splitTextFile(string(content))
	return LoadedTextFile{
		Lines:       lines,
		LineEndings: endings,
		HasUTF8BOM:  hasUTF8BOM,
		Revision:    revision,
	}, nil
}

func splitTextFile(text string) ([]string, []LineEnding) {
	// 预分配到精确容量，避免大文件解析时的 append 增长复制。
	capacity := strings.Count(text, "\n")
	if len(text) > 0 && !strings.HasSuffix(text, "\n") {
		capacity++
	}
	lines := make([]string, 0, capacity)
	endings := make([]LineEnding, 0, capacity)
	start := 0
	for i := 0; i < len(text); i++ {
		if text[i] != '\n' {
			continue
		}
		if i > start && text[i-1] == '\r' {
			lines = append(lines, text[start:i-1])
			endings = append(endings, CRLFLineEnding)
		} else {
			lines = append(lines, text[start:i])
			endings = append(endings, LFLineEnding)
		}
		start = i + 1
	}
	if start < len(text) {
		lines = append(lines, text[start:])
		endings = append(endings, NoLineEnding)
	}
	return lines, endings
}

// EncodeContent 一次性构建最终文件字节：精确预估容量，BOM、行文本与逐行
// terminator 只 append 一次。revision 计算与原子写入直接消费同一份切片，
// 不得再做 string/[]byte 往返转换。调用方保证 len(lines) == len(endings)。
func (f LoadedTextFile) EncodeContent(lines []string, endings []LineEnding) []byte {
	size := 0
	if f.HasUTF8BOM {
		size += len(utf8BOM)
	}
	for i, line := range lines {
		size += len(line) + len(endings[i].bytes())
	}
	encoded := make([]byte, 0, size)
	if f.HasUTF8BOM {
		encoded = append(encoded, utf8BOM...)
	}
	for i, line := range lines {
		encoded = append(encoded, line...)
		encoded = append(encoded, endings[i].bytes()...)
	}
	return encoded
}

// rawFileRevisionFromPath 流式计算目标当前字节的 revision，供 pre-commit 复检
// 使用，避免为一次 hash 完整读入文件。
func rawFileRevisionFromPath(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	digest := sha256.New()
	if _, err := io.Copy(digest, file); err != nil {
		return "", err
	}
	return "sha256:" + hex.EncodeToString(digest.Sum(nil)), nil
}

// localLineEnding 返回 0-based index 附近的局部行尾风格：从 index 向前找第一个
// 真实 terminator，找不到再向后找；空文件或全部无 terminator 时退回 LF。
func localLineEnding(endings []LineEnding, index int) LineEnding {
	backward := index
	if backward > len(endings)-1 {
		backward = len(endings) - 1
	}
	for i := backward; i >= 0; i-- {
		if endings[i] != NoLineEnding {
			return endings[i]
		}
	}
	for i := index + 1; i < len(endings); i++ {
		if endings[i] != NoLineEnding {
			return endings[i]
		}
	}
	return LFLineEnding
}

// rebuiltLineEndings 按 Phase 3 规则为重建后的行分配 terminator：
//
//   - 未被任何 delta 消费的原始行保留自己的 terminator；
//   - 每个 delta 的新行使用消费区间附近的局部行尾，最后一行继承被替换区间
//     末行的 terminator（纯插入无消费区间，全部使用锚点附近的局部行尾）；
//   - 原 EOF 无 terminator 的行被平移到中间时补局部行尾；
//   - 原文件 trailing newline 的存在性保持。
//
// deltas 必须与 CLI editDeltas 相同：原始 1-based 行坐标、按物理输出顺序排列、
// 消费区间互不重叠（纯插入是 OldEnd == OldStart-1 的空区间）。
func rebuiltLineEndings(source LoadedTextFile, deltas []EditDelta, rebuiltCount int) []LineEnding {
	endings := source.LineEndings
	rebuilt := make([]LineEnding, 0, rebuiltCount)
	cursor := 1
	for _, delta := range deltas {
		rebuilt = append(rebuilt, endings[cursor-1:delta.OldStart-1]...)
		consumed := delta.OldEnd - delta.OldStart + 1
		produced := consumed + delta.Delta
		if produced > 0 {
			local := localLineEnding(endings, delta.OldEnd-1)
			for i := 0; i < produced-1; i++ {
				rebuilt = append(rebuilt, local)
			}
			if consumed > 0 {
				rebuilt = append(rebuilt, endings[delta.OldEnd-1])
			} else {
				rebuilt = append(rebuilt, local)
			}
		}
		cursor = delta.OldEnd + 1
	}
	rebuilt = append(rebuilt, endings[cursor-1:]...)

	if len(rebuilt) == 0 {
		return rebuilt
	}
	// 原 EOF 行获得后继内容时不再是末行，必须补上局部 terminator。
	for i := 0; i < len(rebuilt)-1; i++ {
		if rebuilt[i] == NoLineEnding {
			rebuilt[i] = localLineEnding(rebuilt, i)
		}
	}
	hadTrailingNewline := len(endings) > 0 && endings[len(endings)-1] != NoLineEnding
	last := len(rebuilt) - 1
	if hadTrailingNewline {
		if rebuilt[last] == NoLineEnding {
			rebuilt[last] = localLineEnding(rebuilt, last)
		}
	} else {
		rebuilt[last] = NoLineEnding
	}
	return rebuilt
}

package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"unicode/utf8"
)

const (
	snaplineProtocolVersion  = 1
	snaplineReadInputLimit   = 1 << 20
	snaplineApplyInputLimit  = 32 << 20
	snaplineMessageByteLimit = 4096
)

type SnaplineCapabilities struct {
	OK                         bool   `json:"ok"`
	Product                    string `json:"product"`
	Version                    string `json:"version"`
	WireProtocol               int    `json:"wireProtocol"`
	RawRevision                string `json:"rawRevision"`
	MultiWindowRead            bool   `json:"multiWindowRead"`
	BoundedBinaryPreflight     bool   `json:"boundedBinaryPreflight"`
	GroupedAtomicApply         bool   `json:"groupedAtomicApply"`
	CompleteReadProof          bool   `json:"completeReadProof"`
	PreCommitRevisionCheck     bool   `json:"preCommitRevisionCheck"`
	StructuredEditEffects      bool   `json:"structuredEditEffects"`
	StructuredRecoveryContexts bool   `json:"structuredRecoveryContexts"`
}

type SnaplineReadWindow struct {
	Offset int `json:"offset"`
	Limit  int `json:"limit"`
}

type SnaplineReadRequest struct {
	ProtocolVersion int                  `json:"protocolVersion"`
	Path            string               `json:"path"`
	Windows         []SnaplineReadWindow `json:"windows"`
}

type SnaplineTruncatedLine struct {
	Line              int    `json:"line"`
	Prefix            string `json:"prefix"`
	OriginalUTF8Bytes int    `json:"originalUtf8Bytes"`
}

type SnaplineReadContext struct {
	Offset        int                    `json:"offset"`
	Limit         int                    `json:"limit"`
	Start         int                    `json:"start"`
	End           int                    `json:"end"`
	Complete      bool                   `json:"complete"`
	NextOffset    int                    `json:"nextOffset"`
	Lines         []string               `json:"lines"`
	TruncatedLine *SnaplineTruncatedLine `json:"truncatedLine,omitempty"`
	Approximate   bool                   `json:"approximate,omitempty"`
}

type SnaplineOmittedRange struct {
	Start       int    `json:"start"`
	End         int    `json:"end"`
	Reason      string `json:"reason"`
	Approximate bool   `json:"approximate,omitempty"`
}

type SnaplineReadResult struct {
	OK              bool                   `json:"ok"`
	ProtocolVersion int                    `json:"protocolVersion"`
	Path            string                 `json:"path"`
	Revision        string                 `json:"revision"`
	TotalLines      int                    `json:"totalLines"`
	BOM             bool                   `json:"bom"`
	Contexts        []SnaplineReadContext  `json:"contexts"`
	OmittedRanges   []SnaplineOmittedRange `json:"omittedRanges"`
}

type SnaplineProofRange struct {
	Start int      `json:"start"`
	Lines []string `json:"lines"`
}

type SnaplineReplacement struct {
	Start int    `json:"start"`
	End   int    `json:"end"`
	Text  string `json:"text"`
}

type SnaplineDeletion struct {
	Start int `json:"start"`
	End   int `json:"end"`
}

type SnaplineInsertion struct {
	Line int    `json:"line"`
	Text string `json:"text"`
}

type SnaplineApplyRequest struct {
	ProtocolVersion  int                   `json:"protocolVersion"`
	Path             string                `json:"path"`
	ExpectedRevision string                `json:"expectedRevision"`
	Proof            []SnaplineProofRange  `json:"proof"`
	Replacements     []SnaplineReplacement `json:"replacements"`
	Deletions        []SnaplineDeletion    `json:"deletions"`
	InsertionsBefore []SnaplineInsertion   `json:"insertionsBefore"`
	InsertionsAfter  []SnaplineInsertion   `json:"insertionsAfter"`
}

type SnaplineEditEffect struct {
	Group        string `json:"group"`
	GroupIndex   int    `json:"groupIndex"`
	Changed      bool   `json:"changed"`
	OldStart     int    `json:"oldStart"`
	OldEnd       int    `json:"oldEnd"`
	NewLineCount int    `json:"newLineCount"`
	LineDelta    int    `json:"lineDelta"`
	NewStart     int    `json:"newStart"`
	NewEnd       int    `json:"newEnd"`
}

type SnaplineApplyStats struct {
	RequestedChanges int `json:"requestedChanges"`
	EffectiveChanges int `json:"effectiveChanges"`
	OldLineCount     int `json:"oldLineCount"`
	NewLineCount     int `json:"newLineCount"`
	InsertedLines    int `json:"insertedLines"`
	DeletedLines     int `json:"deletedLines"`
}

type SnaplineWarning struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type SnaplineApplyResult struct {
	OK              bool                 `json:"ok"`
	ProtocolVersion int                  `json:"protocolVersion"`
	Path            string               `json:"path"`
	Outcome         string               `json:"outcome"`
	SourceRevision  string               `json:"sourceRevision"`
	NewRevision     string               `json:"newRevision"`
	ContentChanged  bool                 `json:"contentChanged"`
	Stats           SnaplineApplyStats   `json:"stats"`
	Effects         []SnaplineEditEffect `json:"effects"`
	Warnings        []SnaplineWarning    `json:"warnings"`
}

type SnaplineSourceRange struct {
	Start int `json:"start"`
	End   int `json:"end"`
}

type SnaplineConflictReference struct {
	Group      string `json:"group"`
	GroupIndex int    `json:"groupIndex"`
}

type SnaplineLogicalFailure struct {
	OK              bool                       `json:"ok"`
	ProtocolVersion int                        `json:"protocolVersion"`
	Path            string                     `json:"path,omitempty"`
	Code            string                     `json:"code"`
	Message         string                     `json:"message"`
	TargetCommitted bool                       `json:"targetCommitted"`
	CurrentRevision string                     `json:"currentRevision,omitempty"`
	RequiredRanges  []SnaplineSourceRange      `json:"requiredRanges,omitempty"`
	Contexts        []SnaplineReadContext      `json:"contexts,omitempty"`
	OmittedRanges   []SnaplineOmittedRange     `json:"omittedRanges,omitempty"`
	Group           string                     `json:"group,omitempty"`
	GroupIndex      *int                       `json:"groupIndex,omitempty"`
	ConflictsWith   *SnaplineConflictReference `json:"conflictsWith,omitempty"`
}

func boundedSnaplineMessage(message string) string {
	if len(message) <= snaplineMessageByteLimit {
		return message
	}
	const suffix = "…"
	prefix := message[:snaplineMessageByteLimit-len(suffix)]
	for !utf8.ValidString(prefix) {
		prefix = prefix[:len(prefix)-1]
	}
	return prefix + suffix
}
func snaplineFailure(code, message string) *SnaplineLogicalFailure {
	return &SnaplineLogicalFailure{
		OK:              false,
		ProtocolVersion: snaplineProtocolVersion,
		Code:            code,
		Message:         boundedSnaplineMessage(message),
		TargetCommitted: false,
	}
}

func snaplineChangeFailure(code, message, group string, groupIndex int) *SnaplineLogicalFailure {
	failure := snaplineFailure(code, message)
	failure.Group = group
	failure.GroupIndex = new(int)
	*failure.GroupIndex = groupIndex
	return failure
}

func emitWireJSON(value any) error {
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)
	return encoder.Encode(value)
}

func readBoundedStdin(limit int) ([]byte, *SnaplineLogicalFailure, error) {
	content, err := io.ReadAll(io.LimitReader(os.Stdin, int64(limit)+1))
	if err != nil {
		return nil, nil, err
	}
	if len(content) > limit {
		return nil, snaplineFailure("size_limit", fmt.Sprintf("request exceeds %d-byte stdin limit", limit)), nil
	}
	if !utf8.Valid(content) {
		return nil, snaplineFailure("invalid_request", "request is not valid UTF-8"), nil
	}
	return content, nil, nil
}

func strictJSONObject(raw []byte, allowed, required []string, context string) (map[string]json.RawMessage, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	openingToken, err := decoder.Token()
	if err != nil {
		return nil, fmt.Errorf("%s must be a JSON object: %w", context, err)
	}
	opening, ok := openingToken.(json.Delim)
	if !ok || opening != '{' {
		return nil, fmt.Errorf("%s must be a JSON object", context)
	}

	allowedSet := make(map[string]struct{}, len(allowed))
	for _, key := range allowed {
		allowedSet[key] = struct{}{}
	}
	object := make(map[string]json.RawMessage, len(allowed))
	for decoder.More() {
		keyToken, tokenErr := decoder.Token()
		if tokenErr != nil {
			return nil, fmt.Errorf("decode %s field: %w", context, tokenErr)
		}
		key, ok := keyToken.(string)
		if !ok {
			return nil, fmt.Errorf("%s field name must be a string", context)
		}
		if _, duplicate := object[key]; duplicate {
			return nil, fmt.Errorf("%s contains duplicate field %q", context, key)
		}
		if _, allowed := allowedSet[key]; !allowed {
			return nil, fmt.Errorf("%s contains unknown field %q", context, key)
		}
		var value json.RawMessage
		if decodeErr := decoder.Decode(&value); decodeErr != nil {
			return nil, fmt.Errorf("decode %s field %q: %w", context, key, decodeErr)
		}
		object[key] = value
	}
	closingToken, err := decoder.Token()
	if err != nil {
		return nil, fmt.Errorf("decode %s closing delimiter: %w", context, err)
	}
	closing, ok := closingToken.(json.Delim)
	if !ok || closing != '}' {
		return nil, fmt.Errorf("%s must be a JSON object", context)
	}
	var trailing json.RawMessage
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return nil, fmt.Errorf("%s must contain exactly one JSON value", context)
		}
		return nil, fmt.Errorf("decode trailing %s data: %w", context, err)
	}
	for _, key := range required {
		if _, ok := object[key]; !ok {
			return nil, fmt.Errorf("%s field %q is required", context, key)
		}
	}
	return object, nil
}

func rawIsNull(raw json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}

func requiredString(object map[string]json.RawMessage, key, context string) (string, error) {
	raw := object[key]
	if rawIsNull(raw) {
		return "", fmt.Errorf("%s field %q must be a string", context, key)
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", fmt.Errorf("%s field %q must be a string", context, key)
	}
	return value, nil
}

func requiredInt(object map[string]json.RawMessage, key, context string) (int, error) {
	raw := object[key]
	if rawIsNull(raw) {
		return 0, fmt.Errorf("%s field %q must be an integer", context, key)
	}
	var value int
	if err := json.Unmarshal(raw, &value); err != nil {
		return 0, fmt.Errorf("%s field %q must be an integer", context, key)
	}
	return value, nil
}

func requiredArray(object map[string]json.RawMessage, key, context string) ([]json.RawMessage, error) {
	raw := object[key]
	if rawIsNull(raw) {
		return nil, fmt.Errorf("%s field %q must be an array", context, key)
	}
	var values []json.RawMessage
	if err := json.Unmarshal(raw, &values); err != nil {
		return nil, fmt.Errorf("%s field %q must be an array", context, key)
	}
	if values == nil {
		values = []json.RawMessage{}
	}
	return values, nil
}

func parseStringArray(raw json.RawMessage, context string) ([]string, error) {
	if rawIsNull(raw) {
		return nil, fmt.Errorf("%s must be an array of strings", context)
	}
	var values []json.RawMessage
	if err := json.Unmarshal(raw, &values); err != nil {
		return nil, fmt.Errorf("%s must be an array of strings", context)
	}
	result := make([]string, len(values))
	for index, valueRaw := range values {
		if rawIsNull(valueRaw) || json.Unmarshal(valueRaw, &result[index]) != nil {
			return nil, fmt.Errorf("%s item %d must be a string", context, index)
		}
	}
	return result, nil
}

func parseSnaplineReadRequest(raw []byte) (SnaplineReadRequest, *SnaplineLogicalFailure) {
	var request SnaplineReadRequest
	object, err := strictJSONObject(raw,
		[]string{"protocolVersion", "path", "windows"},
		[]string{"protocolVersion", "path", "windows"},
		"read request",
	)
	if err != nil {
		return request, snaplineFailure("invalid_request", err.Error())
	}
	request.ProtocolVersion, err = requiredInt(object, "protocolVersion", "read request")
	if err != nil || request.ProtocolVersion != snaplineProtocolVersion {
		if err == nil {
			err = fmt.Errorf("read request protocolVersion must be %d", snaplineProtocolVersion)
		}
		return request, snaplineFailure("invalid_request", err.Error())
	}
	request.Path, err = requiredString(object, "path", "read request")
	if err != nil || request.Path == "" || strings.ContainsRune(request.Path, '\x00') {
		if err == nil {
			err = errors.New("read request path must not be empty or contain NUL bytes")
		}
		return request, snaplineFailure("invalid_request", err.Error())
	}
	windowValues, err := requiredArray(object, "windows", "read request")
	if err != nil {
		return request, snaplineFailure("invalid_request", err.Error())
	}
	if len(windowValues) == 0 || len(windowValues) > 64 {
		return request, snaplineFailure("invalid_request", "read request windows must contain between 1 and 64 items")
	}
	request.Windows = make([]SnaplineReadWindow, len(windowValues))
	for index, windowRaw := range windowValues {
		context := fmt.Sprintf("read request window %d", index)
		windowObject, objectErr := strictJSONObject(windowRaw, []string{"offset", "limit"}, []string{"offset", "limit"}, context)
		if objectErr != nil {
			return request, snaplineFailure("invalid_request", objectErr.Error())
		}
		request.Windows[index].Offset, objectErr = requiredInt(windowObject, "offset", context)
		if objectErr == nil {
			request.Windows[index].Limit, objectErr = requiredInt(windowObject, "limit", context)
		}
		if objectErr != nil || request.Windows[index].Offset < 1 || request.Windows[index].Limit < 1 {
			if objectErr == nil {
				objectErr = fmt.Errorf("%s offset and limit must be positive integers", context)
			}
			return request, snaplineFailure("invalid_request", objectErr.Error())
		}
	}
	return request, nil
}

func parseSnaplineApplyRequest(raw []byte) (SnaplineApplyRequest, *SnaplineLogicalFailure) {
	var request SnaplineApplyRequest
	keys := []string{
		"protocolVersion", "path", "expectedRevision", "proof",
		"replacements", "deletions", "insertionsBefore", "insertionsAfter",
	}
	object, err := strictJSONObject(raw, keys, keys, "apply request")
	if err != nil {
		return request, snaplineFailure("invalid_request", err.Error())
	}
	request.ProtocolVersion, err = requiredInt(object, "protocolVersion", "apply request")
	if err != nil || request.ProtocolVersion != snaplineProtocolVersion {
		if err == nil {
			err = fmt.Errorf("apply request protocolVersion must be %d", snaplineProtocolVersion)
		}
		return request, snaplineFailure("invalid_request", err.Error())
	}
	request.Path, err = requiredString(object, "path", "apply request")
	if err != nil || request.Path == "" || strings.ContainsRune(request.Path, '\x00') {
		if err == nil {
			err = errors.New("apply request path must not be empty or contain NUL bytes")
		}
		return request, snaplineFailure("invalid_request", err.Error())
	}
	request.ExpectedRevision, err = requiredString(object, "expectedRevision", "apply request")
	if err != nil {
		return request, snaplineFailure("invalid_request", err.Error())
	}

	proofValues, err := requiredArray(object, "proof", "apply request")
	if err != nil {
		return request, snaplineFailure("invalid_request", err.Error())
	}
	request.Proof = make([]SnaplineProofRange, len(proofValues))
	for index, proofRaw := range proofValues {
		context := fmt.Sprintf("apply proof %d", index)
		proofObject, objectErr := strictJSONObject(proofRaw, []string{"start", "lines"}, []string{"start", "lines"}, context)
		if objectErr != nil {
			return request, snaplineFailure("invalid_request", objectErr.Error())
		}
		request.Proof[index].Start, objectErr = requiredInt(proofObject, "start", context)
		if objectErr == nil {
			request.Proof[index].Lines, objectErr = parseStringArray(proofObject["lines"], context+" lines")
		}
		if objectErr != nil || request.Proof[index].Start < 1 || len(request.Proof[index].Lines) == 0 {
			if objectErr == nil {
				objectErr = fmt.Errorf("%s start must be positive and lines must not be empty", context)
			}
			return request, snaplineFailure("invalid_request", objectErr.Error())
		}
	}

	if request.Replacements, err = parseSnaplineReplacements(object["replacements"]); err != nil {
		return request, snaplineFailure("invalid_request", err.Error())
	}
	if request.Deletions, err = parseSnaplineDeletions(object["deletions"]); err != nil {
		return request, snaplineFailure("invalid_request", err.Error())
	}
	if request.InsertionsBefore, err = parseSnaplineInsertions(object["insertionsBefore"], "insertionsBefore"); err != nil {
		return request, snaplineFailure("invalid_request", err.Error())
	}
	if request.InsertionsAfter, err = parseSnaplineInsertions(object["insertionsAfter"], "insertionsAfter"); err != nil {
		return request, snaplineFailure("invalid_request", err.Error())
	}
	return request, nil
}

func parseSnaplineReplacements(raw json.RawMessage) ([]SnaplineReplacement, error) {
	var result []SnaplineReplacement
	values, err := decodeRawArray(raw, "apply replacements")
	if err != nil {
		return nil, err
	}
	result = make([]SnaplineReplacement, len(values))
	for index, valueRaw := range values {
		context := fmt.Sprintf("replacement %d", index)
		object, objectErr := strictJSONObject(valueRaw, []string{"start", "end", "text"}, []string{"start", "end", "text"}, context)
		if objectErr != nil {
			return nil, objectErr
		}
		result[index].Start, objectErr = requiredInt(object, "start", context)
		if objectErr == nil {
			result[index].End, objectErr = requiredInt(object, "end", context)
		}
		if objectErr == nil {
			result[index].Text, objectErr = requiredString(object, "text", context)
		}
		if objectErr != nil {
			return nil, objectErr
		}
	}
	return result, nil
}

func parseSnaplineDeletions(raw json.RawMessage) ([]SnaplineDeletion, error) {
	values, err := decodeRawArray(raw, "apply deletions")
	if err != nil {
		return nil, err
	}
	result := make([]SnaplineDeletion, len(values))
	for index, valueRaw := range values {
		context := fmt.Sprintf("deletion %d", index)
		object, objectErr := strictJSONObject(valueRaw, []string{"start", "end"}, []string{"start", "end"}, context)
		if objectErr != nil {
			return nil, objectErr
		}
		result[index].Start, objectErr = requiredInt(object, "start", context)
		if objectErr == nil {
			result[index].End, objectErr = requiredInt(object, "end", context)
		}
		if objectErr != nil {
			return nil, objectErr
		}
	}
	return result, nil
}

func parseSnaplineInsertions(raw json.RawMessage, group string) ([]SnaplineInsertion, error) {
	values, err := decodeRawArray(raw, "apply "+group)
	if err != nil {
		return nil, err
	}
	result := make([]SnaplineInsertion, len(values))
	for index, valueRaw := range values {
		context := fmt.Sprintf("%s item %d", group, index)
		object, objectErr := strictJSONObject(valueRaw, []string{"line", "text"}, []string{"line", "text"}, context)
		if objectErr != nil {
			return nil, objectErr
		}
		result[index].Line, objectErr = requiredInt(object, "line", context)
		if objectErr == nil {
			result[index].Text, objectErr = requiredString(object, "text", context)
		}
		if objectErr != nil {
			return nil, objectErr
		}
	}
	return result, nil
}

func decodeRawArray(raw json.RawMessage, context string) ([]json.RawMessage, error) {
	if rawIsNull(raw) {
		return nil, fmt.Errorf("%s must be an array", context)
	}
	var values []json.RawMessage
	if err := json.Unmarshal(raw, &values); err != nil {
		return nil, fmt.Errorf("%s must be an array", context)
	}
	if len(values) > 100 {
		return nil, fmt.Errorf("%s exceeds 100-item limit", context)
	}
	if values == nil {
		values = []json.RawMessage{}
	}
	return values, nil
}

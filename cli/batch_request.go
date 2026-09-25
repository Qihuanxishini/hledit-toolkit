package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"slices"
)

const (
	maxBatchRequestBytes     = 8 * 1024 * 1024
	maxBatchEditCount        = 200
	maxBatchReplacementBytes = 1024 * 1024
	maxBatchOutputLines      = 20_000
)

// BatchEditOp 是 batch wire v3 中的一项编辑；私有 presence 字段区分缺失与显式零值。
type BatchEditOp struct {
	OP            string   `json:"op"`
	Pos           string   `json:"pos"`
	EndPos        string   `json:"end_pos"`
	After         bool     `json:"after"`
	Lines         []string `json:"lines"`
	endPosPresent bool
	afterPresent  bool
	linesPresent  bool
}

// decodeObjectFields 把一个 JSON 对象拆成原始字段值：字段名区分大小写，
// 不允许重复或 allowed 之外的字段。encoding/json 默认的大小写折叠与“后者覆盖”
// 会让同一请求出现多种拼写，与 wire v3 的唯一规范形状冲突。
func decodeObjectFields(data []byte, object string, allowed ...string) (map[string]json.RawMessage, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	if token, err := decoder.Token(); err != nil {
		return nil, err
	} else if token != json.Delim('{') {
		return nil, fmt.Errorf("%s must be a JSON object", object)
	}
	fields := make(map[string]json.RawMessage, len(allowed))
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		key := token.(string)
		if !slices.Contains(allowed, key) {
			return nil, fmt.Errorf("json: unknown field %q", key)
		}
		if _, duplicate := fields[key]; duplicate {
			return nil, fmt.Errorf("%s contains duplicate field %q", object, key)
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, err
		}
		fields[key] = value
	}
	return fields, nil
}

func isJSONNull(raw json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}

func decodeString(raw json.RawMessage, field string) (string, error) {
	var value string
	if isJSONNull(raw) || json.Unmarshal(raw, &value) != nil {
		return "", fmt.Errorf("%s must be a string", field)
	}
	return value, nil
}

func decodeStringArray(raw json.RawMessage, field string) ([]string, error) {
	var elements []json.RawMessage
	if isJSONNull(raw) || json.Unmarshal(raw, &elements) != nil {
		return nil, fmt.Errorf("%s must be an array of strings", field)
	}
	values := make([]string, len(elements))
	for i, element := range elements {
		if isJSONNull(element) || json.Unmarshal(element, &values[i]) != nil {
			return nil, fmt.Errorf("%s[%d] must be a string", field, i)
		}
	}
	return values, nil
}

func (edit *BatchEditOp) UnmarshalJSON(data []byte) error {
	fields, err := decodeObjectFields(data, "batch edit", "op", "pos", "end_pos", "after", "lines")
	if err != nil {
		return err
	}
	*edit = BatchEditOp{}
	if raw, ok := fields["op"]; ok {
		if edit.OP, err = decodeString(raw, "op"); err != nil {
			return err
		}
	}
	if raw, ok := fields["pos"]; ok {
		if edit.Pos, err = decodeString(raw, "pos"); err != nil {
			return err
		}
	}
	if raw, ok := fields["end_pos"]; ok {
		edit.endPosPresent = true
		if edit.EndPos, err = decodeString(raw, "end_pos"); err != nil {
			return err
		}
	}
	if raw, ok := fields["after"]; ok {
		edit.afterPresent = true
		if isJSONNull(raw) || json.Unmarshal(raw, &edit.After) != nil {
			return errors.New("after must be a boolean")
		}
	}
	if raw, ok := fields["lines"]; ok {
		edit.linesPresent = true
		if edit.Lines, err = decodeStringArray(raw, "lines"); err != nil {
			return err
		}
	}
	return nil
}

// BatchReadProof identifies the exact raw-byte revision and anchors observed by a prior read.
type BatchReadProof struct {
	Revision string   `json:"revision"`
	Anchors  []string `json:"anchors"`
}

func (proof *BatchReadProof) UnmarshalJSON(data []byte) error {
	fields, err := decodeObjectFields(data, "proof", "revision", "anchors")
	if err != nil {
		return err
	}
	rawRevision, ok := fields["revision"]
	if !ok {
		return errors.New("proof revision is required")
	}
	if proof.Revision, err = decodeString(rawRevision, "proof revision"); err != nil {
		return err
	}
	rawAnchors, ok := fields["anchors"]
	if !ok {
		return errors.New("proof anchors are required")
	}
	proof.Anchors, err = decodeStringArray(rawAnchors, "proof anchors")
	return err
}

// BatchEditRequest 是 hledit batch 从 stdin 接受的唯一顶层文档。
type BatchEditRequest struct {
	Edits []BatchEditOp   `json:"edits"`
	Proof *BatchReadProof `json:"proof,omitempty"`
}

func (request *BatchEditRequest) UnmarshalJSON(data []byte) error {
	fields, err := decodeObjectFields(data, "batch request", "edits", "proof")
	if err != nil {
		return err
	}
	*request = BatchEditRequest{}
	if raw, ok := fields["edits"]; ok {
		if err := json.Unmarshal(raw, &request.Edits); err != nil {
			return err
		}
	}
	if raw, ok := fields["proof"]; ok {
		if isJSONNull(raw) {
			return errors.New("proof must be an object")
		}
		request.Proof = &BatchReadProof{}
		if err := json.Unmarshal(raw, request.Proof); err != nil {
			return err
		}
	}
	return nil
}

func validateBatchRequestCapacity(request BatchEditRequest) error {
	if len(request.Edits) > maxBatchEditCount {
		return fmt.Errorf("batch request contains %d edits; maximum is %d", len(request.Edits), maxBatchEditCount)
	}
	replacementBytes := 0
	outputLines := 0
	for _, edit := range request.Edits {
		if !edit.linesPresent {
			continue
		}
		for index, line := range edit.Lines {
			replacementBytes += len(line)
			if index > 0 {
				replacementBytes++
			}
			if replacementBytes > maxBatchReplacementBytes {
				return fmt.Errorf("batch replacement text exceeds %d-byte canonical UTF-8 limit", maxBatchReplacementBytes)
			}
		}
		outputLines += len(edit.Lines)
		if outputLines > maxBatchOutputLines {
			return fmt.Errorf("batch replacement output exceeds %d lines", maxBatchOutputLines)
		}
	}
	return nil
}

// parseBatchRequest 只接受一个字段闭合的 JSON 对象，协议拼写错误不得降级为其他编辑。
func parseBatchRequest() (BatchEditRequest, error) {
	var request BatchEditRequest
	data, err := io.ReadAll(io.LimitReader(os.Stdin, maxBatchRequestBytes+1))
	if err != nil {
		return request, err
	}
	if len(data) > maxBatchRequestBytes {
		return request, fmt.Errorf("batch request exceeds %d-byte limit", maxBatchRequestBytes)
	}

	decoder := json.NewDecoder(bytes.NewReader(data))
	if err := decoder.Decode(&request); err != nil {
		return request, err
	}
	var trailing json.RawMessage
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return request, errors.New("batch request must contain exactly one JSON object")
		}
		return request, err
	}
	if err := validateBatchRequestCapacity(request); err != nil {
		return request, err
	}
	return request, nil
}

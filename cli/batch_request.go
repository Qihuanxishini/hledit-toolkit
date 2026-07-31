package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
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

type batchEditOpWire struct {
	OP     string          `json:"op"`
	Pos    string          `json:"pos"`
	EndPos json.RawMessage `json:"end_pos"`
	After  json.RawMessage `json:"after"`
	Lines  json.RawMessage `json:"lines"`
}

func (edit *BatchEditOp) UnmarshalJSON(data []byte) error {
	var wire batchEditOpWire
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&wire); err != nil {
		return err
	}
	var trailing json.RawMessage
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("batch edit must contain exactly one JSON object")
		}
		return err
	}

	edit.OP = wire.OP
	edit.Pos = wire.Pos
	edit.EndPos = ""
	edit.After = false
	edit.Lines = nil
	edit.endPosPresent = len(wire.EndPos) > 0
	edit.afterPresent = len(wire.After) > 0
	edit.linesPresent = len(wire.Lines) > 0
	if edit.endPosPresent {
		if bytes.Equal(bytes.TrimSpace(wire.EndPos), []byte("null")) || json.Unmarshal(wire.EndPos, &edit.EndPos) != nil {
			return errors.New("end_pos must be a string")
		}
	}
	if edit.afterPresent {
		if bytes.Equal(bytes.TrimSpace(wire.After), []byte("null")) || json.Unmarshal(wire.After, &edit.After) != nil {
			return errors.New("after must be a boolean")
		}
	}
	if edit.linesPresent {
		if bytes.Equal(bytes.TrimSpace(wire.Lines), []byte("null")) || json.Unmarshal(wire.Lines, &edit.Lines) != nil {
			return errors.New("lines must be an array of strings")
		}
	}
	return nil
}

func (edit BatchEditOp) MarshalJSON() ([]byte, error) {
	type batchEditOpJSON struct {
		OP     string    `json:"op"`
		Pos    string    `json:"pos"`
		EndPos string    `json:"end_pos,omitempty"`
		After  bool      `json:"after,omitempty"`
		Lines  *[]string `json:"lines,omitempty"`
	}
	encoded := batchEditOpJSON{OP: edit.OP, Pos: edit.Pos, EndPos: edit.EndPos}
	if edit.OP != "delete" {
		lines := edit.Lines
		if lines == nil {
			lines = []string{}
		}
		encoded.Lines = &lines
	}
	if edit.OP == "insert" && edit.After {
		encoded.After = true
	}
	return json.Marshal(encoded)
}

// BatchReadProof identifies the exact raw-byte revision and anchors observed by a prior read.
type BatchReadProof struct {
	Revision string   `json:"revision"`
	Anchors  []string `json:"anchors"`
}

type batchReadProofWire struct {
	Revision json.RawMessage `json:"revision"`
	Anchors  json.RawMessage `json:"anchors"`
}

func (proof *BatchReadProof) UnmarshalJSON(data []byte) error {
	var wire batchReadProofWire
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&wire); err != nil {
		return err
	}
	var trailing json.RawMessage
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("proof must contain exactly one JSON object")
		}
		return err
	}

	if len(wire.Revision) == 0 {
		return errors.New("proof revision is required")
	}
	if bytes.Equal(bytes.TrimSpace(wire.Revision), []byte("null")) || json.Unmarshal(wire.Revision, &proof.Revision) != nil {
		return errors.New("proof revision must be a string")
	}
	if len(wire.Anchors) == 0 {
		return errors.New("proof anchors are required")
	}
	if bytes.Equal(bytes.TrimSpace(wire.Anchors), []byte("null")) || json.Unmarshal(wire.Anchors, &proof.Anchors) != nil {
		return errors.New("proof anchors must be an array of strings")
	}
	return nil
}

// BatchEditRequest 是 hledit batch 从 stdin 接受的唯一顶层文档。
type BatchEditRequest struct {
	Edits []BatchEditOp   `json:"edits"`
	Proof *BatchReadProof `json:"proof,omitempty"`
}

func (request *BatchEditRequest) UnmarshalJSON(data []byte) error {
	type batchEditRequestWire struct {
		Edits []BatchEditOp   `json:"edits"`
		Proof json.RawMessage `json:"proof"`
	}
	var wire batchEditRequestWire
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&wire); err != nil {
		return err
	}
	var trailing json.RawMessage
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("batch request must contain exactly one JSON object")
		}
		return err
	}
	request.Edits = wire.Edits
	request.Proof = nil
	if len(wire.Proof) > 0 {
		if bytes.Equal(bytes.TrimSpace(wire.Proof), []byte("null")) {
			return errors.New("proof must be an object")
		}
		var proof BatchReadProof
		proofDecoder := json.NewDecoder(bytes.NewReader(wire.Proof))
		proofDecoder.DisallowUnknownFields()
		if err := proofDecoder.Decode(&proof); err != nil {
			return err
		}
		if err := proofDecoder.Decode(&trailing); !errors.Is(err, io.EOF) {
			if err == nil {
				return errors.New("proof must contain exactly one JSON object")
			}
			return err
		}
		request.Proof = &proof
	}
	return nil
}

// parseBatchRequest 只接受一个字段闭合的 JSON 对象，协议拼写错误不得降级为其他编辑。
func parseBatchRequest() (BatchEditRequest, error) {
	var request BatchEditRequest
	data, err := io.ReadAll(os.Stdin)
	if err != nil {
		return request, err
	}

	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
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
	return request, nil
}

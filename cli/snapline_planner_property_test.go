package main

import (
	"encoding/binary"
	"fmt"
	"math/rand"
	"reflect"
	"sort"
	"strings"
	"testing"
)

type referenceSnaplineChange struct {
	group      string
	groupIndex int
	oldStart   int
	oldEnd     int
	boundary   int
	produced   []string
	changed    bool
}

type referenceSnaplineLine struct {
	text       string
	sourceLine int
}

func referenceChangeKey(change referenceSnaplineChange) string {
	return fmt.Sprintf("%s:%d", change.group, change.groupIndex)
}

func encodeReferenceSnaplineText(lines []string) string {
	text := strings.Join(lines, "\n")
	if len(lines) > 0 && lines[len(lines)-1] == "" {
		text += "\n"
	}
	return text
}

func randomReferenceLine(random *rand.Rand) string {
	values := []string{"", "same", "alpha", "beta", "界", "🙂"}
	return values[random.Intn(len(values))]
}

func buildRandomSnaplineCase(seed int64) (LoadedTextFile, SnaplineApplyRequest, []referenceSnaplineChange) {
	random := rand.New(rand.NewSource(seed))
	lineCount := 1 + random.Intn(12)
	source := make([]string, lineCount)
	for index := range source {
		source[index] = randomReferenceLine(random)
	}
	file := LoadedTextFile{Lines: source, LineEndings: make([]LineEnding, lineCount)}
	for index := range file.LineEndings {
		file.LineEndings[index] = LFLineEnding
	}
	request := SnaplineApplyRequest{
		Replacements:     []SnaplineReplacement{},
		Deletions:        []SnaplineDeletion{},
		InsertionsBefore: []SnaplineInsertion{},
		InsertionsAfter:  []SnaplineInsertion{},
	}
	changes := make([]referenceSnaplineChange, 0, 8)
	occupiedLines := make([]bool, lineCount+1)
	usedBoundaries := make(map[int]bool)

	consumerAllowed := func(start, end int) bool {
		for line := start; line <= end; line++ {
			if occupiedLines[line] {
				return false
			}
		}
		for boundary := start; boundary < end; boundary++ {
			if usedBoundaries[boundary] {
				return false
			}
		}
		return true
	}
	insertionAllowed := func(boundary int) bool {
		if usedBoundaries[boundary] {
			return false
		}
		for _, change := range changes {
			if change.oldEnd >= change.oldStart && boundary >= change.oldStart && boundary < change.oldEnd {
				return false
			}
		}
		return true
	}

	attempts := 4 + random.Intn(16)
	for attempt := 0; attempt < attempts && len(changes) < 8; attempt++ {
		kind := random.Intn(4)
		if kind < 2 {
			start := 1 + random.Intn(lineCount)
			end := start + random.Intn(lineCount-start+1)
			if !consumerAllowed(start, end) {
				continue
			}
			for line := start; line <= end; line++ {
				occupiedLines[line] = true
			}
			if kind == 0 {
				produced := make([]string, 1+random.Intn(3))
				if random.Intn(5) == 0 {
					produced = append([]string(nil), source[start-1:end]...)
				} else {
					for index := range produced {
						produced[index] = fmt.Sprintf("r%d-%d-%d", seed, attempt, index)
					}
				}
				if start == end && len(produced) > 1 && produced[0] == source[start-1] {
					produced[0] += "-changed"
				}
				index := len(request.Replacements)
				request.Replacements = append(request.Replacements, SnaplineReplacement{
					Start: start,
					End:   end,
					Text:  encodeReferenceSnaplineText(produced),
				})
				changes = append(changes, referenceSnaplineChange{
					group: "replacement", groupIndex: index, oldStart: start, oldEnd: end,
					boundary: start - 1, produced: produced,
					changed: !equalSnaplineLines(source[start-1:end], produced),
				})
			} else {
				index := len(request.Deletions)
				request.Deletions = append(request.Deletions, SnaplineDeletion{Start: start, End: end})
				changes = append(changes, referenceSnaplineChange{
					group: "deletion", groupIndex: index, oldStart: start, oldEnd: end,
					boundary: start - 1, produced: []string{}, changed: true,
				})
			}
			continue
		}

		boundary := random.Intn(lineCount + 1)
		if !insertionAllowed(boundary) {
			continue
		}
		usedBoundaries[boundary] = true
		produced := make([]string, 1+random.Intn(3))
		for index := range produced {
			produced[index] = fmt.Sprintf("i%d-%d-%d", seed, attempt, index)
		}
		text := encodeReferenceSnaplineText(produced)
		useBefore := boundary == 0 || (boundary < lineCount && random.Intn(2) == 0)
		if useBefore {
			index := len(request.InsertionsBefore)
			request.InsertionsBefore = append(request.InsertionsBefore, SnaplineInsertion{Line: boundary + 1, Text: text})
			changes = append(changes, referenceSnaplineChange{
				group: "insertion_before", groupIndex: index,
				oldStart: boundary + 1, oldEnd: boundary, boundary: boundary,
				produced: produced, changed: true,
			})
		} else {
			index := len(request.InsertionsAfter)
			request.InsertionsAfter = append(request.InsertionsAfter, SnaplineInsertion{Line: boundary, Text: text})
			changes = append(changes, referenceSnaplineChange{
				group: "insertion_after", groupIndex: index,
				oldStart: boundary + 1, oldEnd: boundary, boundary: boundary,
				produced: produced, changed: true,
			})
		}
	}

	if len(changes) == 0 {
		request.Replacements = append(request.Replacements, SnaplineReplacement{Start: 1, End: 1, Text: "fallback"})
		changes = append(changes, referenceSnaplineChange{
			group: "replacement", groupIndex: 0, oldStart: 1, oldEnd: 1,
			boundary: 0, produced: []string{"fallback"}, changed: source[0] != "fallback",
		})
	}
	return file, request, changes
}

func projectReferenceSnapline(source []string, changes []referenceSnaplineChange) ([]string, map[string]int, map[int]int) {
	insertions := make(map[int]referenceSnaplineChange)
	consumers := make(map[int]referenceSnaplineChange)
	for _, change := range changes {
		if !change.changed {
			continue
		}
		if change.oldEnd < change.oldStart {
			insertions[change.boundary] = change
		} else {
			consumers[change.oldStart] = change
		}
	}
	projected := make([]referenceSnaplineLine, 0, len(source)+len(changes)*2)
	effectStarts := make(map[string]int)
	sourcePositions := make(map[int]int)
	cursor := 1
	for boundary := 0; boundary <= len(source); boundary++ {
		if insertion, ok := insertions[boundary]; ok {
			effectStarts[referenceChangeKey(insertion)] = len(projected) + 1
			for _, text := range insertion.produced {
				projected = append(projected, referenceSnaplineLine{text: text})
			}
		}
		if cursor != boundary+1 || cursor > len(source) {
			continue
		}
		if consumer, ok := consumers[cursor]; ok {
			effectStarts[referenceChangeKey(consumer)] = len(projected) + 1
			for _, text := range consumer.produced {
				projected = append(projected, referenceSnaplineLine{text: text})
			}
			cursor = consumer.oldEnd + 1
			continue
		}
		sourcePositions[cursor] = len(projected) + 1
		projected = append(projected, referenceSnaplineLine{text: source[cursor-1], sourceLine: cursor})
		cursor++
	}
	lines := make([]string, len(projected))
	for index := range projected {
		lines[index] = projected[index].text
	}
	return lines, effectStarts, sourcePositions
}

func assertSnaplinePlannerMatchesReference(t testing.TB, seed int64) {
	t.Helper()
	file, request, referenceChanges := buildRandomSnaplineCase(seed)
	planned, failure := planSnaplineChanges(request, file)
	if failure != nil {
		t.Fatalf("seed %d generated rejected request: %#v", seed, failure)
	}
	sort.Slice(referenceChanges, func(i, j int) bool {
		if referenceChanges[i].group != referenceChanges[j].group {
			return snaplineGroupOrder(referenceChanges[i].group) < snaplineGroupOrder(referenceChanges[j].group)
		}
		return referenceChanges[i].groupIndex < referenceChanges[j].groupIndex
	})
	if len(planned) != len(referenceChanges) {
		t.Fatalf("seed %d planned count = %d; want %d", seed, len(planned), len(referenceChanges))
	}
	for index := range planned {
		got := planned[index]
		want := referenceChanges[index]
		if got.group != want.group || got.groupIndex != want.groupIndex || got.oldStart != want.oldStart || got.oldEnd != want.oldEnd || got.boundary != want.boundary || got.changed != want.changed || !reflect.DeepEqual(got.produced, want.produced) {
			t.Fatalf("seed %d planned %d = %#v; want %#v", seed, index, got, want)
		}
	}

	wantLines, effectStarts, sourcePositions := projectReferenceSnapline(file.Lines, referenceChanges)
	effective := effectiveSnaplineChanges(planned)
	stats := buildSnaplineStats(planned, effective, len(file.Lines))
	gotLines := rebuildSnaplineLines(file.Lines, effective, stats.NewLineCount)
	if !reflect.DeepEqual(gotLines, wantLines) {
		t.Fatalf("seed %d projected lines = %#v; want %#v", seed, gotLines, wantLines)
	}

	wantInserted, wantDeleted, wantEffective := 0, 0, 0
	for _, change := range referenceChanges {
		if !change.changed {
			continue
		}
		wantEffective++
		wantInserted += len(change.produced)
		if change.oldEnd >= change.oldStart {
			wantDeleted += change.oldEnd - change.oldStart + 1
		}
	}
	if stats.RequestedChanges != len(referenceChanges) || stats.EffectiveChanges != wantEffective || stats.InsertedLines != wantInserted || stats.DeletedLines != wantDeleted || stats.NewLineCount != len(wantLines) {
		t.Fatalf("seed %d stats = %#v", seed, stats)
	}

	effects := buildSnaplineEffects(planned, effective)
	for index, effect := range effects {
		change := referenceChanges[index]
		wantStart := effectStarts[referenceChangeKey(change)]
		if !change.changed {
			wantStart = sourcePositions[change.oldStart]
		}
		wantEnd := wantStart + len(change.produced) - 1
		wantDelta := 0
		if change.changed {
			consumed := 0
			if change.oldEnd >= change.oldStart {
				consumed = change.oldEnd - change.oldStart + 1
			}
			wantDelta = len(change.produced) - consumed
		}
		if effect.Group != change.group || effect.GroupIndex != change.groupIndex || effect.Changed != change.changed || effect.NewStart != wantStart || effect.NewEnd != wantEnd || effect.NewLineCount != len(change.produced) || effect.LineDelta != wantDelta {
			t.Fatalf("seed %d effect %d = %#v; want start=%d end=%d delta=%d for %#v", seed, index, effect, wantStart, wantEnd, wantDelta, change)
		}
	}
}

func TestSnaplinePlannerMatchesProjectedDocumentReference(t *testing.T) {
	for seed := int64(0); seed < 2000; seed++ {
		assertSnaplinePlannerMatchesReference(t, seed)
	}
}

func FuzzSnaplinePlannerMatchesProjectedDocumentReference(f *testing.F) {
	for _, seed := range []uint64{0, 1, 2, 7, 42, 99, 1<<63 - 1, ^uint64(0)} {
		buffer := make([]byte, 8)
		binary.LittleEndian.PutUint64(buffer, seed)
		f.Add(buffer)
	}
	f.Fuzz(func(t *testing.T, input []byte) {
		var buffer [8]byte
		copy(buffer[:], input)
		assertSnaplinePlannerMatchesReference(t, int64(binary.LittleEndian.Uint64(buffer[:])))
	})
}

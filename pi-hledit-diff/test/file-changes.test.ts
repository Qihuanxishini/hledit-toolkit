import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFileChangeCheckRequest,
  buildFileChangeRequest,
  fileChangeLineRanges,
  findSingleLineRangeExpansionIssue,
  formatSingleLineRangeExpansionIssue,
  lineFromAnchor,
} from "../src/file-changes.ts";
import type { FileChangeParams } from "../src/schema.ts";

function verifiedIssue(issue: ReturnType<typeof findSingleLineRangeExpansionIssue>) {
  assert.ok(issue);
  return { ...issue, anchorsVerified: true as const };
}

test("buildFileChangeRequest translates every supported change", () => {
  const params: FileChangeParams = {
    path: "src/a.ts",
    changes: [
      { operation: "replace_range", start_anchor: "1#BHJ", end_anchor: "2#BBK", lines: ["next"] },
      { operation: "delete_range", start_anchor: "4#JKL", end_anchor: "4#JKL" },
      { operation: "insert_after", anchor: "6#MNP", lines: ["one", "two"] },
    ],
  };

  assert.deepEqual(buildFileChangeRequest(params), {
    args: ["batch", "src/a.ts"],
    stdin: JSON.stringify({
      edits: [
        { op: "replace", pos: "1#BHJ", end_pos: "2#BBK", lines: ["next"] },
        { op: "delete", pos: "4#JKL", end_pos: "4#JKL", lines: [] },
        { op: "insert", pos: "6#MNP", after: true, lines: ["one", "two"] },
      ],
    }),
  });
});

test("buildFileChangeCheckRequest adds validate-only mode", () => {
  const request = buildFileChangeCheckRequest({
    path: "src/a.ts",
    changes: [{ operation: "replace_range", start_anchor: "1#BHJ", end_anchor: "1#BHJ", lines: ["next"] }],
  });

  assert.deepEqual(request.args, ["batch", "--check", "src/a.ts"]);
  assert.equal(request.stdin, '{"edits":[{"op":"replace","pos":"1#BHJ","end_pos":"1#BHJ","lines":["next"]}]}');
});

test("buildFileChangeRequest omits after for before inserts", () => {
  const request = buildFileChangeRequest({
    path: "src/a.ts",
    changes: [{ operation: "insert_before", anchor: "6#MNP", lines: ["one"] }],
  });

  assert.equal(request.stdin, '{"edits":[{"op":"insert","pos":"6#MNP","lines":["one"]}]}');
});

test("findSingleLineRangeExpansionIssue returns actionable structured guidance", () => {
  const issue = findSingleLineRangeExpansionIssue(
    {
      path: "src/a.ts",
      changes: [{ operation: "replace_range", start_anchor: "2#BHJ", end_anchor: "2#BHJ", lines: ["two", "inserted"] }],
    },
    "one\ntwo\nthree\n",
  );

  assert.deepEqual(issue, {
    code: "single_line_range_expansion",
    changeNumber: 1,
    anchor: "2#BHJ",
    outputLineCount: 2,
    replacementLines: ["two", "inserted"],
    insertLines: ["inserted"],
  });
  const text = formatSingleLineRangeExpansionIssue(verifiedIssue(issue));
  assert.match(text, /实际收到：[\s\S]*end_anchor: 2#BHJ/);
  assert.match(text, /禁止使用相同参数重试/);
  assert.match(text, /当前没有可安全使用的结束锚点/);
  assert.doesNotMatch(text, /<从最新 hledit_read_anchors/);
  assert.match(text, /"operation": "insert_after"[\s\S]*"lines": [\s\S]*"inserted"/);
});

test("findSingleLineRangeExpansionIssue points out a nearby delete range", () => {
  const issue = findSingleLineRangeExpansionIssue(
    {
      path: "src/a.ts",
      changes: [
        { operation: "replace_range", start_anchor: "2#BHJ", end_anchor: "2#BHJ", lines: ["two", "replacement"] },
        { operation: "delete_range", start_anchor: "4#JKL", end_anchor: "6#MNP" },
      ],
    },
    "one\ntwo\nthree\nfour\nfive\nsix\n",
  );

  assert.deepEqual(issue?.nearbyDeleteRange, {
    changeNumber: 2,
    startAnchor: "4#JKL",
    endAnchor: "6#MNP",
  });
  const text = formatSingleLineRangeExpansionIssue(verifiedIssue(issue));
  assert.match(text, /第 2 项 delete_range 覆盖 4#JKL 到 6#MNP/);
  assert.match(text, /"end_anchor": "6#MNP"/);
  assert.match(text, /移除原 delete_range/);
});

test("findSingleLineRangeExpansionIssue does not guess between multiple nearby delete ranges", () => {
  const issue = findSingleLineRangeExpansionIssue(
    {
      path: "src/a.ts",
      changes: [
        { operation: "replace_range", start_anchor: "2#BHJ", end_anchor: "2#BHJ", lines: ["two", "replacement"] },
        { operation: "delete_range", start_anchor: "4#JKL", end_anchor: "4#JKL" },
        { operation: "delete_range", start_anchor: "4#JKL", end_anchor: "5#KMN" },
      ],
    },
    "one\ntwo\nthree\nfour\nfive\n",
  );

  assert.equal(issue?.nearbyDeleteRange, undefined);
  assert.doesNotMatch(formatSingleLineRangeExpansionIssue(verifiedIssue(issue)), /检测到同批次/);
});

test("findSingleLineRangeExpansionIssue allows explicit ranges, rewrites, and adjacent deletes", () => {
  assert.equal(
    findSingleLineRangeExpansionIssue(
      {
        path: "src/a.ts",
        changes: [{ operation: "replace_range", start_anchor: "2#BHJ", end_anchor: "3#BBK", lines: ["two", "inserted"] }],
      },
      "one\ntwo\nthree\n",
    ),
    undefined,
  );
  assert.equal(
    findSingleLineRangeExpansionIssue(
      {
        path: "src/a.ts",
        changes: [{ operation: "replace_range", start_anchor: "2#BHJ", end_anchor: "2#BHJ", lines: ["TWO", "inserted"] }],
      },
      "one\ntwo\nthree\n",
    ),
    undefined,
  );
  assert.equal(
    findSingleLineRangeExpansionIssue(
      {
        path: "src/a.ts",
        changes: [
          { operation: "replace_range", start_anchor: "2#BHJ", end_anchor: "2#BHJ", lines: ["two", "replacement"] },
          { operation: "delete_range", start_anchor: "3#BBK", end_anchor: "3#BBK" },
        ],
      },
      "one\ntwo\nthree\n",
    ),
    undefined,
  );
});

test("fileChangeLineRanges preserves each operation range", () => {
  assert.equal(
    fileChangeLineRanges([
      { operation: "replace_range", start_anchor: "10#BHJ", end_anchor: "12#BBK" },
      { operation: "insert_after", anchor: "4#JKL" },
    ]),
    "10-12,4",
  );
  assert.equal(fileChangeLineRanges([{ operation: "delete_range", start_anchor: "4#JKL", end_anchor: "4#JKL" }]), "4");
  assert.equal(fileChangeLineRanges([]), undefined);
});

test("lineFromAnchor reads only valid line prefixes", () => {
  assert.equal(lineFromAnchor("12#Ab9"), 12);
  assert.equal(lineFromAnchor("12"), undefined);
  assert.equal(lineFromAnchor(undefined), undefined);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFileChangeCheckRequest,
  buildFileChangeRequest,
  fileChangeLineRanges,
  findChangeShapeIssue,
  findSingleLineRangeExpansionIssue,
  formatChangeShapeIssue,
  formatSingleLineRangeExpansionIssue,
  lineFromAnchor,
} from "../src/file-changes.ts";
import type { FileChangeParams } from "../src/schema.ts";

function verifiedIssue(issue: ReturnType<typeof findSingleLineRangeExpansionIssue>) {
  assert.ok(issue);
  return { ...issue, anchorsVerified: true as const };
}

// 护栏自 Phase 4 起消费同 revision 的消费行证据，而不是完整文件字符串。
function consumedTestLines(content: string): Map<number, { text: string }> {
  return new Map(content.split(/\r\n|\r|\n/).map((text, index) => [index + 1, { text }]));
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
    args: ["batch", "--", "src/a.ts"],
    stdin: JSON.stringify({
      edits: [
        { op: "replace", pos: "1#BHJ", end_pos: "2#BBK", lines: ["next"] },
        { op: "delete", pos: "4#JKL", end_pos: "4#JKL" },
        { op: "insert", pos: "6#MNP", after: true, lines: ["one", "two"] },
      ],
    }),
  });
});


test("buildFileChangeCheckRequest adds validate-only mode", () => {
  const request = buildFileChangeCheckRequest({
    path: "--check",
    changes: [{ operation: "replace_range", start_anchor: "1#BHJ", end_anchor: "1#BHJ", lines: ["next"] }],
  });

  assert.deepEqual(request.args, ["batch", "--check", "--", "--check"]);
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
    consumedTestLines("one\ntwo\nthree\n"),
  );

  assert.deepEqual(issue, {
    code: "single_line_range_expansion",
    changeNumber: 1,
    anchor: "2#BHJ",
    outputLineCount: 2,
  });
  const text = formatSingleLineRangeExpansionIssue(verifiedIssue(issue));
  assert.equal(text, [
    "Change 1 was rejected.",
    "Received: replace_range 2#BHJ through 2#BHJ; 2 output lines.",
    "This range covers one source line and repeats it as the first output line, which could leave old code behind.",
    "Do not retry with the same parameters.",
    "To replace a larger block:",
    "- call hledit_read_anchors for the true block-end anchor",
    "- set change 1 end_anchor to that verified anchor",
    "- keep change 1 lines unchanged",
    "No safe placeholder end anchor is available.",
    "To keep 2#BHJ and append the remaining 1 line:",
    "- change operation to insert_after",
    "- replace start_anchor/end_anchor with anchor: 2#BHJ",
    "- remove the first line from lines; keep the remaining 1 line unchanged",
  ].join("\n"));
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
    consumedTestLines("one\ntwo\nthree\nfour\nfive\nsix\n"),
  );

  assert.deepEqual(issue?.nearbyDeleteRange, {
    changeNumber: 2,
    startAnchor: "4#JKL",
    endAnchor: "6#MNP",
  });
  const text = formatSingleLineRangeExpansionIssue(verifiedIssue(issue));
  assert.match(text, /Change 2 is a delete_range from 4#JKL through 6#MNP/);
  assert.match(text, /set change 1 end_anchor to 6#MNP/);
  assert.match(text, /remove change 2/);
  assert.match(text, /keep change 1 lines unchanged/);
  assert.doesNotMatch(text, /"lines"/);
});

test("single-line range guidance does not echo a large replacement payload", () => {
  const payloadLines = ["two", ...Array.from({ length: 200 }, (_, index) => `payload-${index}-${"x".repeat(80)}`)];
  const issue = findSingleLineRangeExpansionIssue(
    {
      path: "src/a.ts",
      changes: [{ operation: "replace_range", start_anchor: "2#BHJ", end_anchor: "2#BHJ", lines: payloadLines }],
    },
    consumedTestLines("one\ntwo\nthree\n"),
  );

  const text = formatSingleLineRangeExpansionIssue(verifiedIssue(issue));
  assert.ok(text.length < 1000);
  assert.doesNotMatch(text, /payload-199/);
  assert.match(text, /keep change 1 lines unchanged/);
  assert.match(text, /keep the remaining 200 lines unchanged/);
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
    consumedTestLines("one\ntwo\nthree\nfour\nfive\n"),
  );

  assert.equal(issue?.nearbyDeleteRange, undefined);
  assert.doesNotMatch(formatSingleLineRangeExpansionIssue(verifiedIssue(issue)), /Change 2 is a delete_range/);
});

test("findSingleLineRangeExpansionIssue allows explicit ranges, rewrites, and adjacent deletes", () => {
  assert.equal(
    findSingleLineRangeExpansionIssue(
      {
        path: "src/a.ts",
        changes: [{ operation: "replace_range", start_anchor: "2#BHJ", end_anchor: "3#BBK", lines: ["two", "inserted"] }],
      },
      consumedTestLines("one\ntwo\nthree\n"),
    ),
    undefined,
  );
  assert.equal(
    findSingleLineRangeExpansionIssue(
      {
        path: "src/a.ts",
        changes: [{ operation: "replace_range", start_anchor: "2#BHJ", end_anchor: "2#BHJ", lines: ["TWO", "inserted"] }],
      },
      consumedTestLines("one\ntwo\nthree\n"),
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
      consumedTestLines("one\ntwo\nthree\n"),
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
  assert.equal(lineFromAnchor("0#Ab9"), undefined);
  assert.equal(lineFromAnchor("9007199254740992#Ab9"), undefined);
  assert.equal(lineFromAnchor(`${"9".repeat(400)}#Ab9`), undefined);
});

function shapeParams(changes: FileChangeParams["changes"]): FileChangeParams {
  return { path: "src/a.ts", changes };
}

test("findChangeShapeIssue reports a reversed range for both range operations", () => {
  assert.deepEqual(
    findChangeShapeIssue(shapeParams([{ operation: "replace_range", start_anchor: "9#Ab9", end_anchor: "3#Cd1", lines: ["merged"] }])),
    { code: "reversed_anchor_range", changeNumber: 1, operation: "replace_range", startAnchor: "9#Ab9", endAnchor: "3#Cd1" },
  );
  assert.deepEqual(
    findChangeShapeIssue(shapeParams([{ operation: "delete_range", start_anchor: "9#Ab9", end_anchor: "3#Cd1" }])),
    { code: "reversed_anchor_range", changeNumber: 1, operation: "delete_range", startAnchor: "9#Ab9", endAnchor: "3#Cd1" },
  );
});

test("findChangeShapeIssue accepts a single-line range and a well-ordered range", () => {
  assert.equal(findChangeShapeIssue(shapeParams([{ operation: "replace_range", start_anchor: "3#Cd1", end_anchor: "3#Cd1", lines: ["one"] }])), undefined);
  assert.equal(findChangeShapeIssue(shapeParams([{ operation: "delete_range", start_anchor: "3#Cd1", end_anchor: "9#Ab9" }])), undefined);
});

test("findChangeShapeIssue reports an anchor token pasted into any lines-bearing operation", () => {
  assert.deepEqual(
    findChangeShapeIssue(shapeParams([{ operation: "replace_range", start_anchor: "3#Cd1", end_anchor: "3#Cd1", lines: ["3#Cd1:const b = 20;"] }])),
    { code: "anchor_token_in_lines", changeNumber: 1, replacementLineNumber: 1, anchorToken: "3#Cd1" },
  );
  assert.deepEqual(
    findChangeShapeIssue(shapeParams([{ operation: "insert_after", anchor: "7#Ef2", lines: ["clean", "7#Ef2:pasted"] }])),
    { code: "anchor_token_in_lines", changeNumber: 1, replacementLineNumber: 2, anchorToken: "7#Ef2" },
  );
});

test("findChangeShapeIssue matches a token submitted by any change in the batch", () => {
  assert.deepEqual(
    findChangeShapeIssue(shapeParams([
      { operation: "insert_before", anchor: "3#Cd1", lines: ["clean"] },
      { operation: "insert_after", anchor: "9#Ab9", lines: ["3#Cd1:copied from another change"] },
    ])),
    { code: "anchor_token_in_lines", changeNumber: 2, replacementLineNumber: 1, anchorToken: "3#Cd1" },
  );
});

test("findChangeShapeIssue leaves anchor-shaped content alone unless the token was submitted", () => {
  // 真实文件里可能出现锚点形状的行首（例如记录 hledit 输出的文档）；
  // 只有当它恰好等于本次提交的 anchor 时才能断定为误贴。
  assert.equal(
    findChangeShapeIssue(shapeParams([{ operation: "replace_range", start_anchor: "3#Cd1", end_anchor: "3#Cd1", lines: ["120#-Sf:sample output"] }])),
    undefined,
  );
  assert.equal(
    findChangeShapeIssue(shapeParams([{ operation: "insert_after", anchor: "7#Ef2", lines: ["7#Ef2 without a colon", "  7#Ef2:indented"] }])),
    undefined,
  );
});

test("formatChangeShapeIssue tells the model to fix parameters instead of rereading", () => {
  const reversed = formatChangeShapeIssue({
    code: "reversed_anchor_range",
    changeNumber: 1,
    operation: "replace_range",
    startAnchor: "9#Ab9",
    endAnchor: "3#Cd1",
  });
  assert.match(reversed, /Swap them: set start_anchor to 3#Cd1 and end_anchor to 9#Ab9\./);
  assert.match(reversed, /Rereading the file cannot resolve this/);

  const pasted = formatChangeShapeIssue({
    code: "anchor_token_in_lines",
    changeNumber: 2,
    replacementLineNumber: 3,
    anchorToken: "7#Ef2",
  });
  assert.match(pasted, /Line 3 of lines begins with 7#Ef2:/);
  assert.match(pasted, /lines carries file content only/);
  assert.match(pasted, /Rereading the file cannot resolve this/);
});

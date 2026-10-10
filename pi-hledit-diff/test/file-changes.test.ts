import assert from "node:assert/strict";
import test from "node:test";

import {
  buildFileChangeRequest,
  fileChangeLineRanges,
  findChangeShapeIssue,
  formatChangeShapeIssue,
} from "../src/file-changes.ts";
import { lineFromAnchor } from "../src/anchor.ts";
import type { FileChangeParams } from "../src/schema.ts";

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

test("buildFileChangeRequest omits after for before inserts", () => {
  const request = buildFileChangeRequest({
    path: "src/a.ts",
    changes: [{ operation: "insert_before", anchor: "6#MNP", lines: ["one"] }],
  });

  assert.equal(request.stdin, '{"edits":[{"op":"insert","pos":"6#MNP","lines":["one"]}]}');
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
  // 只有当它恰好等于本次提交或当前证据里的 anchor 时才能断定为误贴。
  assert.equal(
    findChangeShapeIssue(shapeParams([{ operation: "replace_range", start_anchor: "3#Cd1", end_anchor: "3#Cd1", lines: ["120#-Sf:sample output"] }])),
    undefined,
  );
  assert.equal(
    findChangeShapeIssue(shapeParams([{ operation: "insert_after", anchor: "7#Ef2", lines: ["7#Ef2 without a colon", "  7#Ef2:indented"] }])),
    undefined,
  );
});

test("findChangeShapeIssue also matches anchors known from the file's current evidence", () => {
  // 把 read 输出整段贴进 insert：行首 token 是依附行之后的行，不在提交锚点里。
  const params = shapeParams([{ operation: "insert_after", anchor: "7#Ef2", lines: ["8#Gh3:next line", "9#Ij4:another"] }]);
  assert.equal(findChangeShapeIssue(params), undefined);
  assert.deepEqual(
    findChangeShapeIssue(params, new Set(["7#Ef2", "8#Gh3", "9#Ij4"])),
    { code: "anchor_token_in_lines", changeNumber: 1, replacementLineNumber: 1, anchorToken: "8#Gh3" },
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

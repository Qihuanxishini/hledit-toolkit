import assert from "node:assert/strict";
import test from "node:test";

import {
	SNAPLINE_APPLY_DESCRIPTION,
	SNAPLINE_APPLY_PARAMS_SCHEMA,
	SNAPLINE_APPLY_TOOL,
	SNAPLINE_READ_DESCRIPTION,
	SNAPLINE_READ_PARAMS_SCHEMA,
	SNAPLINE_READ_TOOL,
} from "../src/schema.ts";

test("public tool names and schemas are frozen", () => {
	assert.equal(SNAPLINE_READ_TOOL, "snapline_read_file");
	assert.equal(SNAPLINE_APPLY_TOOL, "snapline_apply_changes");
	assert.deepEqual(SNAPLINE_READ_PARAMS_SCHEMA.required, ["path"]);
	assert.deepEqual(SNAPLINE_APPLY_PARAMS_SCHEMA.required, ["path", "snapshot"]);
	assert.equal((SNAPLINE_READ_PARAMS_SCHEMA as unknown as Record<string, unknown>).additionalProperties, false);
	assert.equal((SNAPLINE_APPLY_PARAMS_SCHEMA as unknown as Record<string, unknown>).additionalProperties, false);
});

test("resident public protocol remains below the 3000-character budget", () => {
	const readCharacters = SNAPLINE_READ_DESCRIPTION.length + JSON.stringify(SNAPLINE_READ_PARAMS_SCHEMA).length;
	const applyCharacters = SNAPLINE_APPLY_DESCRIPTION.length + JSON.stringify(SNAPLINE_APPLY_PARAMS_SCHEMA).length;
	assert.ok(readCharacters <= 600, `read schema cost ${readCharacters}`);
	assert.ok(applyCharacters <= 2400, `apply schema cost ${applyCharacters}`);
	assert.ok(readCharacters + applyCharacters <= 3000, `combined schema cost ${readCharacters + applyCharacters}`);
});

test("apply groups are bounded and use string-only replacement text", () => {
	const properties = SNAPLINE_APPLY_PARAMS_SCHEMA.properties as unknown as Record<string, Record<string, unknown>>;
	for (const group of ["replacements", "deletions", "insertions_before", "insertions_after"]) {
		assert.equal(properties[group]?.maxItems, 100);
	}
	const replacements = properties.replacements?.items as { properties: Record<string, unknown> };
	assert.ok(replacements.properties.text);
	assert.equal("lines" in replacements.properties, false);
});

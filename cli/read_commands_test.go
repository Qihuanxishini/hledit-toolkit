package main

func cmdRead(path, grep string, contextN int, jsonOut bool) error {
	return cmdReadPretty(path, grep, contextN, jsonOut, false)
}

func cmdAnchors(path string, offset, limit int, grep string, contextN int, jsonOut bool) error {
	return cmdAnchorsPretty(path, offset, limit, grep, contextN, jsonOut, false)
}

func cmdReadRange(path string, offset, limit int, grep string, contextN int, jsonOut bool) error {
	return cmdReadRangePretty(path, offset, limit, grep, contextN, jsonOut, false)
}

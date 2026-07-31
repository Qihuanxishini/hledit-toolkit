# Unicode Markdown Fixture

Intro paragraph with café, naïve, jalapeño, 漢字, русский текст, and emoji 😀.

> Quote with multilingual text and punctuation — keep it readable.

## Overview

This fixture mixes:

- nested headings
- tables
- fenced code blocks
- list items with Unicode ✓
- paragraphs that wrap across multiple lines

```json
{
  "status": "ok",
  "message": "こんにちは世界",
  "tags": ["alpha", "βeta", "γamma"]
}
```

### Deep Dive

The parser should keep anchors stable when content is edited around code fences.

| Column | Value |
| ------ | -----:|
| name   | résumé |
| emoji  | 😀     |
| script | العربية |

## Data Model

### Entities

- `document`: top-level metadata
- `section`: heading-bound content block
- `note`: inline commentary with accents and emoji ✨

```yaml
kind: document
locale: ja-JP
owner: "María"
```

### Constraints

1. Headings must stay line-aligned.
2. Code fences must remain balanced.
3. Unicode should round-trip without mojibake.

## Appendix

Closing note with mixed scripts: English, Español, Deutsch, 中文, 한국어.

### References

- https://example.com/docs
- https://example.com/guide
- Internal note: preserve the file as valid UTF-8.

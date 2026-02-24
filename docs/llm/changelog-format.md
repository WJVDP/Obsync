# API Changelog Format (LLM-Diff Friendly)

Use this exact structure for every API or schema change:

```markdown
## <ISO_DATE> <VERSION>

### Added
- Endpoint: `METHOD /path`
- Schema: `SchemaName.field` (type, required/optional)

### Changed
- Endpoint: `METHOD /path`
- Detail: old -> new
- Compatibility: backward-compatible | breaking

### Deprecated
- Endpoint/Schema field and removal target version

### Removed
- Endpoint/Schema field and migration instructions

### Error Codes
- Added: `CODE`
- Changed: `CODE` behavior
```

Rules:

1. One endpoint/field per bullet.
2. Include compatibility marker for every changed item.
3. Include migration guidance for all breaking changes.

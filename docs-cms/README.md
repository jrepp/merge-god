# Documentation CMS

This directory contains structured technical documentation using the docs-cms pattern.

## Directory Structure

```
docs-cms/
├── docs-project.yaml      # Project configuration
├── adr/                   # Architecture Decision Records
│   └── adr-NNN-short-description.md
├── rfcs/                  # Request for Comments
│   └── rfc-NNN-short-description.md
├── memos/                 # Technical Memos
│   └── memo-NNN-short-description.md
├── prd/                   # Product Requirements Documents
│   └── prd-NNN-short-description.md
└── templates/             # Document templates
```

## Document Types

### ADR (Architecture Decision Records)
Architecture decisions that have been made or are being considered. Use these to document significant architectural choices and their rationale.

**Filename format**: `adr-NNN-short-description.md` (lowercase, dashes)

### RFC (Request for Comments)
Proposals for new features, changes, or processes that need team review and discussion.

**Filename format**: `rfc-NNN-short-description.md` (lowercase, dashes)

### Memos
Technical notes, findings, research, or informal documentation that doesn't fit the ADR/RFC structure.

**Filename format**: `memo-NNN-short-description.md` (lowercase, dashes)

### PRD (Product Requirements Documents)
Product requirements and feature specifications.

**Filename format**: `prd-NNN-short-description.md` (lowercase, dashes)

## Publishing Boundary

`docs-cms` is the source of truth for publishable project documentation. Root-level markdown is reserved for operational guides such as the README, installation, testing, and changelog. The `docs/` directory is for historical or vendored reference material unless explicitly promoted into `docs-cms`.

## Getting Started

1. **Copy a template** from the `templates/` folder
2. **Rename the file** with the next available number and a descriptive slug
3. **Update the frontmatter** with project-specific information
4. **Write your content** following the template structure

## Validation

Run validation to check your documents:

```bash
# Validate all documents
docuchango validate

# Validate with verbose output
docuchango validate --verbose

# Auto-fix common issues
docuchango validate --fix
```

## Configuration

Edit `docs-project.yaml` to customize:
- Project metadata
- Folder names
- Which folders to scan
- Maintainer information

## Best Practices

- Use meaningful, descriptive slugs in filenames
- Keep frontmatter fields up to date
- Use lowercase with dashes for IDs and filenames
- Update the `updated` field when making changes
- Use appropriate tags for categorization
- Link to related documents using relative paths
- Put new PRDs, ADRs, RFCs, and memos under `docs-cms` so CI and publishing tools can index them

## Need Help?

```bash
# Display bootstrap guide
docuchango bootstrap

# Display agent guide
docuchango bootstrap --guide agent

# Display best practices
docuchango bootstrap --guide best-practices
```

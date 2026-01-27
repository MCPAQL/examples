# Pending Work: Infrastructure Setup

## Summary

Infrastructure setup for the examples repository - a collection of example MCP-AQL adapter implementations demonstrating various patterns and use cases.

## Current State

- Repository exists with basic structure
- No CI/CD workflows
- No branch protection or git flow
- Issues #1-5 created to track infrastructure work

## Work To Complete

### 1. Git Flow Setup (Issue #1)

**Purpose**: Establish consistent branching strategy

Tasks:
- Create `develop` branch from `main`
- Configure branch protection
- Document branching strategy

### 2. Example Validation Workflow (Issue #2)

**Purpose**: Ensure all examples are correct and runnable

Tasks:
- Create `.github/workflows/validate.yml`
- For each example directory:
  - Install dependencies
  - TypeScript compilation
  - Lint check
  - Run unit tests (if present)
  - Verify example runs without runtime errors
- Use matrix strategy to test all examples
- Test on Node 18.x, 20.x

Example matrix structure:
```yaml
strategy:
  matrix:
    example: [basic-adapter, crud-api, workflow-engine, ...]
    node-version: [18.x, 20.x]
```

### 3. Spec Version Sync Check (Issue #3)

**Purpose**: Verify examples match current MCP-AQL spec version

Tasks:
- Create `.github/workflows/sync-check.yml`
- Run weekly scheduled check
- Compare examples against latest spec version
- Flag outdated examples
- Options:
  - Manual version file per example (`spec-version.json`)
  - Automated check against MCPAQL/spec releases

### 4. Issue and PR Templates (Issue #4)

**Purpose**: Standardize contributions

Tasks:
- Bug report template (example doesn't work)
- Example request template (suggest new example)
- PR template with validation checklist

### 5. CODEOWNERS (Issue #5)

**Purpose**: Automatic review assignment

Tasks:
- Create `.github/CODEOWNERS`
- Note: Requires GitHub teams

## Prerequisites

- GitHub teams for CODEOWNERS
- Branch protection requires GitHub Pro for private repos

## Recommended Order

1. Example validation workflow (#2) - Core functionality
2. Spec sync check (#3) - Ensures currency
3. Git flow (#1) - Can require validation in protection
4. Templates (#4) and CODEOWNERS (#5)

## Example Structure Considerations

Each example should ideally have:
- `README.md` explaining the pattern demonstrated
- `package.json` with dependencies
- `src/` with implementation
- `spec-version.json` indicating which spec version it targets

## Reference

See `MCPAQL/spec` repository for examples of completed infrastructure.

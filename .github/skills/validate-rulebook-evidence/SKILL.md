---
name: validate-rulebook-evidence
description: Analyze code changes and produce rulebook compliance evidence from git diff
---

# Validate Rulebook Evidence

Analyze the git diff and produce rulebook compliance evidence showing which rules were implemented.

## User Input

- baseline-commit-sha (Mandatory): The baseline commit SHA to diff from. Use `unknown` when unavailable.
- rulebook-file-list (Mandatory when attachments are present): Comma-separated list of rulebook file names
- evidence-output-path (Mandatory): Path to write the evidence markdown summary

## Workflow

1. This is a **best-effort** validation step and must not fail the caller.
2. If `${baseline-commit-sha}` is `unknown`, write a short markdown report to `${evidence-output-path}` explaining that diff-based rulebook evidence cannot be generated because baseline commit SHA is unavailable, then stop.
3. Otherwise, analyze the git diff from baseline commit `${baseline-commit-sha}` to `HEAD`.
4. Use the attached rulebook files listed in `${rulebook-file-list}` to map changes to rulebook rules.
5. Write a markdown summary to `${evidence-output-path}` with the following format:

## Rulebook Code Evidence (from diff)

### [policies.md]
**Rule: brief rule summary**
```diff
+ filepath:line  added code
- filepath:line  removed code
```

Focus on the 2-5 most impactful rules. Each diff line starts with '+' or '-' and includes file:line prefix.
6. If evidence generation fails for any reason, still write a short failure report to `${evidence-output-path}` including a brief reason.
Only write the markdown file, do not modify any other files.

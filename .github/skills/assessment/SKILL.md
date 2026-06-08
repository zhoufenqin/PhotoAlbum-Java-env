---
name: assessment
description: Run application assessment for a single repository
---

# Application Assessment

This skill performs application assessment for a single repository. It supports Java, .NET, and JavaScript/TypeScript projects.

## Input Parameters

- `workspace-path` (optional): Path to the project to assess. Defaults to the current directory (repository root) when not specified. All assessment outputs are written relative to this path (e.g. `{workspace-path}/.github/modernize/assessment/reports/report-{reportId}/report.json`). For a repository with multiple sub-projects, pass the sub-project directory path so that each sub-project's outputs are isolated.

## When to Use This Skill

Use this skill when you need to:

- Assess a Java or .NET application for cloud readiness and migration issues
- Assess a JavaScript/TypeScript project for outdated dependencies and available updates
- Generate detailed assessment reports with issue analysis and recommendations
- Understand application dependencies, frameworks, and potential migration blockers

## What This Skill Does

This skill performs a simplified assessment workflow:

1. **Check Project Type and Prerequisites**:
   - **For Java projects**: Ensure Node.js is available (`node --version`) — it runs the bundled `run-java-appcat.js` script. Node.js is normally already present; if missing, install it (`apt-get`/`brew`/`winget`), or pre-install it via `copilot-setup-steps.yml` on custom runners.
     - No MCP tools required for Java assessment. Even if an MCP server exposing an AppCAT install/assessment tool is configured, do **not** call it — acquire AppCAT as described below (download from the manifest URL) and run the bundled `run-java-appcat.js`, which must be the only path used.
   - **For .NET projects**: Check if .NET SDK is available
     - No MCP tools required for .NET assessment
   - **For JavaScript/TypeScript projects**: Check if Node.js and npm are available
     - No MCP tools required for JS/TS assessment

2. **Run Assessment**:
   - **For Java projects**: Acquiring AppCAT (Step 1) is a precondition for running the assessment (Step 2). Step 2 only works once an `appcat` launcher exists under `~/.appcat`, so always complete Step 1 first.
     - **Step 1 — Acquire AppCAT into `~/.appcat` (always do this first):**
       1. Detect the platform key as `{os}-{arch}` (`os`: `linux`/`macos`/`windows`, `arch`: `amd64`/`arm64`, e.g. `linux-amd64`) to pick the right download.
       2. Read `version` and `platforms[{platform-key}].url` from `<skill-dir>/appcat-java-manifest.json`.
       3. If `~/.appcat/appcat` (or `~/.appcat/appcat.exe` on Windows) already exists, it is cached — skip the download and go to Step 2.
       4. Otherwise download and extract, **stripping the archive's single top-level folder** so the self-contained native launcher lands directly at `~/.appcat/appcat` (or `~/.appcat/appcat.exe`):
          - `mkdir -p ~/.appcat`
          - `curl -L -o <archive> <url>`
          - `.tar.gz`: `tar -xzf <archive> --strip-components=1 -C ~/.appcat`
          - `.zip`: `tar -xf <archive> --strip-components=1 -C ~/.appcat`
       5. Confirm `~/.appcat/appcat` (or `~/.appcat/appcat.exe`) now exists. Proceed to Step 2 only once it does.
     - **Step 2 — Run the bundled script** (only after Step 1; it finds AppCAT under `~/.appcat` automatically):
       - `node <skill-dir>/run-java-appcat.js --workspace-path {workspace-path}`
       - It runs `appcat analyze` and prints the absolute path of the generated versioned `report.json`.
       - Do **not** pre-edit `assessment-config.yaml` to drop the `security` domain — the script reads the config (or built-in defaults) and handles `security` itself (excluded from analysis, kept in report metadata).
   - **For .NET projects**: Install and run AppCAT directly
     - Install: `dotnet tool update dotnet-appcat`
     - Find all .csproj files under `{workspace-path}`
     - Join project paths with semicolons: `projectPaths="project1.csproj;project2.csproj"`
     - Run: `appcat analyze $projectPaths --source Solution --target Any --serializer APPMODJSON --code --privacyMode Restricted --non-interactive --report {workspace-path}\.github\modernize\appcat\result\report.json`
   - **For JavaScript/TypeScript projects**: Install and run npm-check-updates
     - Install: `npm install -g npm-check-updates@19.6.3 --prefix {tool-install-dir}`
     - Run: `ncu --format group --packageFile {workspace-path}/package.json`
     - Generate the `reportId` as a UTC timestamp formatted as `yyyyMMddHHmmss` (e.g. `2024-06-15T14:30:52Z` becomes `20240615143052`)
     - Create the versioned directory: `mkdir -p {workspace-path}/.github/modernize/assessment/reports/report-{reportId}`
     - Save the output to `{workspace-path}/.github/modernize/assessment/reports/report-{reportId}/js-assessment-report.md`
     - Do NOT save a copy to the top-level assessment directory
   - Analyzes code for cloud migration issues or dependency updates
   - Generates structured assessment data

3. **Save Report to Versioned Directory (All languages)**:
   - **For Java projects**: The `run-java-appcat.js` script automatically writes the report to `{workspace-path}/.github/modernize/assessment/reports/report-{reportId}/report.json` (deriving `reportId` from `metadata.analysisStartTime`) — no manual saving needed.
   - **For .NET projects**:
     1. Find `report.json` at `{workspace-path}/.github/modernize/appcat/result/report.json`
     2. Read the report and extract `metadata.analysisStartTime`
     3. Format the timestamp as `yyyyMMddHHmmss` to produce the `reportId` (e.g. `2024-06-15T14:30:52Z` becomes `20240615143052`)
     4. Create the versioned directory: `mkdir -p {workspace-path}/.github/modernize/assessment/reports/report-{reportId}`
     5. Move the report to `{workspace-path}/.github/modernize/assessment/reports/report-{reportId}/report.json`
   - This versioned report should be included in the pull request

## How to Use

Express the intent to assess the application — for example *"Assess the application"* or *"Run assessment for this project"*. The skill detects the project language within `{workspace-path}` and runs the matching workflow from [What This Skill Does](#what-this-skill-does), then saves the versioned report (see [Report Output Location](#report-output-location)) to be included in the pull request.

## Report Output Location

Report location depends on project type:

**For Java projects** (direct execution via `run-java-appcat.js`):
- Saved to versioned directory: `{workspace-path}/.github/modernize/assessment/reports/report-{reportId}/report.json`

**For .NET projects** (direct execution):
- Initially generated at: `{workspace-path}/.github/modernize/appcat/result/report.json`
- Moved to versioned directory: `{workspace-path}/.github/modernize/assessment/reports/report-{reportId}/report.json`

**For JavaScript/TypeScript projects** (direct execution):
- Saved to versioned directory: `{workspace-path}/.github/modernize/assessment/reports/report-{reportId}/js-assessment-report.md`

## Success Criteria

Assessment is complete when:
- ✅ **For Java**: Node.js is available and `run-java-appcat.js` runs successfully (or clear instructions provided if Node.js is missing)
- ✅ **For .NET**: .NET SDK is available and dotnet-appcat tool is installed
- ✅ **For JavaScript/TypeScript**: Node.js and npm are available and npm-check-updates is installed
- ✅ AppCAT analysis executes without errors (Java/.NET) or ncu analysis executes without errors (JS/TS)
- ✅ **For Java and .NET**: Report generated at `{workspace-path}/.github/modernize/assessment/reports/report-{reportId}/report.json`
- ✅ **For JavaScript/TypeScript**: Report generated at `{workspace-path}/.github/modernize/assessment/reports/report-{reportId}/js-assessment-report.md`
- ✅ Report metadata includes assessment tool version, timestamp, and configuration

## Troubleshooting

**Prerequisites Not Met**:
- **For Java**: Verify Node.js is installed (`node --version`); install it if missing (`apt-get`/`brew`/`winget`)
- **For .NET**: Verify .NET SDK is installed
  - Check with `dotnet --version` command
  - Provide installation instructions if .NET SDK is missing
- **For JavaScript/TypeScript**: Verify Node.js and npm are installed
  - Check with `npm --version` command
  - Provide installation instructions if npm is missing

**Assessment Failures**:
- Unsupported project type (only Java, .NET, and JavaScript/TypeScript supported)
- **For Java**:
  - Node.js not available to run `run-java-appcat.js`
  - AppCAT download or extraction failure
  - `appcat analyze` execution errors (e.g., unreadable project, unsupported build system)
- **For .NET**:
  - dotnet-appcat tool installation failure
  - appcat command execution errors
- **For JavaScript/TypeScript**:
  - npm-check-updates installation failure
  - ncu command execution errors
  - No package.json found at `{workspace-path}/package.json`
- Invalid project structure or build configuration

**Report Generation Issues**:
- **For Java**: No report.json found under `{workspace-path}/.github/modernize/assessment/reports/report-*/report.json` after running `run-java-appcat.js`
- **For .NET**: Report not generated at `{workspace-path}/.github/modernize/appcat/result/report.json`, or `metadata.analysisStartTime` missing from report
- **For JavaScript/TypeScript**: Report not generated at `{workspace-path}/.github/modernize/assessment/reports/report-{reportId}/js-assessment-report.md`
- Report file is corrupted or invalid JSON (Java/.NET only)

For any failure, provide clear error messages and troubleshooting steps.

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
   - **For Java projects**: Ensure Python 3 is available — it runs the bundled `run-java-appcat.py` script. Python 3 is normally already present; if missing, install it (`apt-get`/`brew`/`winget`).
     - No MCP tools required for Java assessment. Even if an MCP server exposing an AppCAT install/assessment tool is configured, do **not** call it — run the bundled `run-java-appcat.py`, which acquires AppCAT itself and must be the only path used.
   - **For .NET projects**: Check if .NET SDK is available
     - No MCP tools required for .NET assessment
   - **For JavaScript/TypeScript projects**: Check if Node.js and npm are available
     - No MCP tools required for JS/TS assessment

2. **Run Assessment**:
   - **For Java projects**: Run the bundled script — it handles everything (acquiring AppCAT and running the analysis) in a single step. The script is the **only** supported way to produce the Java `report.json`. Do **not** hand-write, fabricate, or otherwise synthesize a `report.json`, and do **not** download or extract AppCAT manually; the script does it deterministically. If the script fails, fix the cause and re-run it — there is no manual fallback.
     - Run the script with whichever Python 3 launcher exists on the machine (`python3`, `python`, or `py -3`): `python3 <skill-dir>/run-java-appcat.py --workspace-path {workspace-path}`
     - The script reads `<skill-dir>/appcat-java-manifest.json`, downloads + sha256-verifies + extracts the platform-appropriate AppCAT into `~/.appcat` (reusing the cached binary when the manifest version is unchanged), runs `appcat analyze`, and prints the absolute path of the generated versioned `report.json`.
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
   - **For Java projects**: The `run-java-appcat.py` script automatically writes the report to `{workspace-path}/.github/modernize/assessment/reports/report-{reportId}/report.json` (deriving `reportId` from `metadata.analysisStartTime`) — no manual saving needed.
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

**For Java projects** (direct execution via `run-java-appcat.py`):
- Saved to versioned directory: `{workspace-path}/.github/modernize/assessment/reports/report-{reportId}/report.json`

**For .NET projects** (direct execution):
- Initially generated at: `{workspace-path}/.github/modernize/appcat/result/report.json`
- Moved to versioned directory: `{workspace-path}/.github/modernize/assessment/reports/report-{reportId}/report.json`

**For JavaScript/TypeScript projects** (direct execution):
- Saved to versioned directory: `{workspace-path}/.github/modernize/assessment/reports/report-{reportId}/js-assessment-report.md`

## Success Criteria

Assessment is complete when:
- ✅ **For Java**: Python 3 is available and `run-java-appcat.py` runs successfully (or clear instructions provided if Python 3 is missing)
- ✅ **For .NET**: .NET SDK is available and dotnet-appcat tool is installed
- ✅ **For JavaScript/TypeScript**: Node.js and npm are available and npm-check-updates is installed
- ✅ AppCAT analysis executes without errors (Java/.NET) or ncu analysis executes without errors (JS/TS)
- ✅ **For Java and .NET**: Report generated at `{workspace-path}/.github/modernize/assessment/reports/report-{reportId}/report.json`
- ✅ **For JavaScript/TypeScript**: Report generated at `{workspace-path}/.github/modernize/assessment/reports/report-{reportId}/js-assessment-report.md`
- ✅ Report metadata includes assessment tool version, timestamp, and configuration

## Troubleshooting

**Prerequisites Not Met**:
- **For Java**: Verify Python 3 is installed (`python3 --version` or `python --version`); install it if missing (`apt-get`/`brew`/`winget`)
- **For .NET**: Verify .NET SDK is installed
  - Check with `dotnet --version` command
  - Provide installation instructions if .NET SDK is missing
- **For JavaScript/TypeScript**: Verify Node.js and npm are installed
  - Check with `npm --version` command
  - Provide installation instructions if npm is missing

**Assessment Failures**:
- Unsupported project type (only Java, .NET, and JavaScript/TypeScript supported)
- **For Java**:
  - Python 3 not available to run `run-java-appcat.py`
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
- **For Java**: No report.json found under `{workspace-path}/.github/modernize/assessment/reports/report-*/report.json` after running `run-java-appcat.py`
- **For .NET**: Report not generated at `{workspace-path}/.github/modernize/appcat/result/report.json`, or `metadata.analysisStartTime` missing from report
- **For JavaScript/TypeScript**: Report not generated at `{workspace-path}/.github/modernize/assessment/reports/report-{reportId}/js-assessment-report.md`
- Report file is corrupted or invalid JSON (Java/.NET only)

For any failure, provide clear error messages and troubleshooting steps.

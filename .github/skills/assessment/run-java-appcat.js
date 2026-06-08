#!/usr/bin/env node
// @ts-nocheck
/*
 * run-java-appcat.js — Cross-platform Java AppCAT assessment runner.
 *
 * This script is shipped inside the assessment skill and runs in the coding agent's
 * workspace. It runs `appcat analyze` parameterized from the assessment config and injects
 * assessment metadata into the resulting report.json — using only Node.js built-in modules
 * (no npm install).
 *
 * Acquiring AppCAT is NOT this script's job: the skill downloads and extracts the
 * appcat-for-java CLI into ~/.appcat first. The CLI is self-contained (it bundles its own
 * Java runtime, so no JDK is needed on the machine).
 *
 * It runs on Linux, macOS and Windows (amd64 / arm64).
 *
 * Usage:
 *   node run-java-appcat.js [--workspace-path PATH] [--config FILE] [--reports-dir DIR]
 *
 * Defaults:
 *   --workspace-path : current working directory
 *   --config         : {workspace}/.github/modernize/assessment/reports/assessment-config.yaml
 *   --reports-dir    : {workspace}/.github/modernize/assessment/reports
 *
 * AppCAT must already be present under ~/.appcat; the skill downloads + extracts it
 * beforehand. This script only locates the launcher and runs the analysis.
 *
 * On success the script prints the absolute path of the versioned report.json and exits 0.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseArgs } = require('node:util');
const { randomUUID } = require('node:crypto');

// ----------------------------------------------------------------------------
// Constants.
// ----------------------------------------------------------------------------

// Caller identifier reported to appcat for telemetry.
const CALLER_ID = 'GitHub-Copilot-Modernize-CLI';

// Default assessment configuration used when no assessment-config.yaml is present.
const DEFAULT_CONFIG = {
  assessmentDomains: ['cloud-readiness', 'java-upgrade'],
  analysisCoverage: 'issue-only',
  targetRuntime: 'openjdk25',
  targetComputeServices: ['azure-appservice', 'azure-aks', 'azure-container-apps'],
  targetOS: ['linux', 'windows'],
  enableContainerization: false,
  minimumCveSeverity: 'high',
};

// Default runtime when the java-upgrade domain has no targetRuntime.
const DEFAULT_JAVA_RUNTIME = 'openjdk25';

// Default minimum CVE severity.
const DEFAULT_MINIMUM_CVE_SEVERITY = 'high';

// Capabilities recognized for the metadata 'capabilities' field.
const KNOWN_CAPABILITIES = new Set([
  'openjdk11', 'openjdk17', 'openjdk21', 'openjdk25', 'containerization',
]);

// Target id -> display name (lookup is case-insensitive).
const TARGET_ID_TO_DISPLAY_NAME = {
  'azure-appservice': 'Azure App Service',
  'azure-aks': 'Azure Kubernetes Service',
  'azure-container-apps': 'Azure Container Apps',
};

function log(message) {
  process.stderr.write(`[run-java-appcat] ${message}\n`);
}

function fail(message, code = 1) {
  log(`ERROR: ${message}`);
  process.exit(code);
}

// ----------------------------------------------------------------------------
// Minimal YAML loading for assessment-config.yaml.
// A small indentation-based parser that supports the known config shape
// (nested maps + sequences of scalars). No external dependency.
// ----------------------------------------------------------------------------

function scalar(token) {
  let t = token.trim();
  if (t.length >= 2 && t[0] === t[t.length - 1] && (t[0] === "'" || t[0] === '"')) {
    return t.slice(1, -1);
  }
  const low = t.toLowerCase();
  if (low === 'true' || low === 'yes') return true;
  if (low === 'false' || low === 'no') return false;
  if (low === 'null' || low === '~' || low === '') return null;
  return t;
}

function tokenizeYaml(text) {
  const tokens = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const stripped = raw.trim();
    if (stripped.startsWith('#')) continue;
    const indent = raw.length - raw.replace(/^ +/, '').length;
    tokens.push({ indent, content: stripped });
  }
  return tokens;
}

function parseYaml(tokens, pos, indent) {
  if (pos >= tokens.length) return { node: null, pos };

  if (tokens[pos].content.startsWith('- ')) {
    const items = [];
    while (pos < tokens.length) {
      const { indent: ind, content } = tokens[pos];
      if (ind !== indent || !content.startsWith('- ')) break;
      items.push(scalar(content.slice(2)));
      pos += 1;
    }
    return { node: items, pos };
  }

  const mapping = {};
  while (pos < tokens.length) {
    const { indent: ind, content } = tokens[pos];
    if (ind !== indent || !content.includes(':')) break;
    const idx = content.indexOf(':');
    const key = content.slice(0, idx).trim();
    const val = content.slice(idx + 1).trim();
    if (val) {
      mapping[key] = scalar(val);
      pos += 1;
      continue;
    }
    pos += 1;
    if (pos < tokens.length) {
      const { indent: nind, content: ncontent } = tokens[pos];
      if (ncontent.startsWith('- ') && nind >= indent) {
        const res = parseYaml(tokens, pos, nind);
        mapping[key] = res.node;
        pos = res.pos;
      } else if (nind > indent) {
        const res = parseYaml(tokens, pos, nind);
        mapping[key] = res.node;
        pos = res.pos;
      } else {
        mapping[key] = null;
      }
    } else {
      mapping[key] = null;
    }
  }
  return { node: mapping, pos };
}

function loadYaml(text) {
  const tokens = tokenizeYaml(text);
  const startIndent = tokens.length ? tokens[0].indent : 0;
  const { node } = parseYaml(tokens, 0, startIndent);
  return node || {};
}

function asStrList(value) {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.filter((v) => v !== null && v !== undefined).map((v) => String(v));
  return [String(value)];
}

function loadConfig(configPath) {
  if (!configPath || !isFile(configPath)) {
    log(`No assessment config at '${configPath}'; using default Java config.`);
    return { ...DEFAULT_CONFIG };
  }

  let root;
  try {
    root = loadYaml(fs.readFileSync(configPath, 'utf8'));
  } catch (exc) {
    log(`Failed to read config '${configPath}' (${exc}); using default Java config.`);
    return { ...DEFAULT_CONFIG };
  }

  const isObj = root && typeof root === 'object' && !Array.isArray(root);
  // Top-level analysisCoverage applies to all languages and overrides the
  // language-specific value when present (mirrors the C# BaseAssessmentExecutor).
  const rootCoverage = isObj && root.analysisCoverage ? root.analysisCoverage : null;

  const java = isObj ? root.java : null;
  if (!java || typeof java !== 'object' || Array.isArray(java)) {
    log("Config has no 'java' section; using default Java config.");
    return { ...DEFAULT_CONFIG, analysisCoverage: rootCoverage || DEFAULT_CONFIG.analysisCoverage };
  }

  return {
    assessmentDomains: asStrList(java.assessmentDomains),
    analysisCoverage: rootCoverage || java.analysisCoverage || 'issue-only',
    targetRuntime: java.targetRuntime ?? null,
    targetComputeServices: asStrList(java.targetComputeServices),
    targetOS: asStrList(java.targetOS),
    enableContainerization: Boolean(java.enableContainerization || false),
    minimumCveSeverity: java.minimumCveSeverity || DEFAULT_MINIMUM_CVE_SEVERITY,
  };
}

// ----------------------------------------------------------------------------
// Label selector construction.
// ----------------------------------------------------------------------------

function appcatDomains(config) {
  // Domains excluding 'security'.
  return config.assessmentDomains.filter((d) => d.toLowerCase() !== 'security');
}

function isSecurityDomainOnly(config) {
  const domains = config.assessmentDomains;
  return domains.length > 0 && domains.every((d) => d.toLowerCase() === 'security');
}

function buildCloudReadinessSelector(config) {
  const parts = ['domain=cloud-readiness'];

  const services = config.targetComputeServices;
  if (services.length) {
    const targets = services.map((t) => `target=${t}`).join(' || ');
    parts.push(services.length === 1 ? targets : `(${targets})`);
  }

  const oses = config.targetOS;
  if (oses.length) {
    const osList = oses.map((o) => `os=${o}`).join(' || ');
    parts.push(oses.length === 1 ? osList : `(${osList})`);
  }

  if (config.enableContainerization) {
    parts.push('capability=containerization');
  }

  return `(${parts.join(' && ')})`;
}

function buildJavaUpgradeSelector(config) {
  const runtime = config.targetRuntime || DEFAULT_JAVA_RUNTIME;
  return `(domain=java-upgrade && (capability=${runtime} || !capability=${runtime}))`;
}

function buildLabelSelector(config) {
  // Returns null when no AppCAT domains are configured.
  const domains = appcatDomains(config);
  if (!domains.length) return null;

  const selectors = [];
  for (const domain of domains) {
    const key = domain.toLowerCase();
    if (key === 'cloud-readiness') {
      selectors.push(buildCloudReadinessSelector(config));
    } else if (key === 'java-upgrade') {
      selectors.push(buildJavaUpgradeSelector(config));
    }
  }

  if (!selectors.length) return null;
  return selectors.join(' || ');
}

// ----------------------------------------------------------------------------
// Analyze arguments.
// ----------------------------------------------------------------------------

function buildAnalyzeArguments(config, inputPath, outputDir, correlationId, sessionId) {
  const labelSelector = buildLabelSelector(config);

  const args = [
    'analyze',
    '--input', inputPath,
    '--output', outputDir,
    '--mode', 'issue-only',
    '--correlation-id', correlationId,
  ];

  if (isSecurityDomainOnly(config)) {
    // Security-only mode: collect app info without running assessment rulesets.
    args.push('--enable-default-rulesets=false');
  }

  if (labelSelector !== null) {
    args.push('--label-selector', labelSelector);
  } else {
    args.push('--target', 'azure-aks,azure-appservice,azure-container-apps');
  }

  args.push(
    '--overwrite',
    '--output-format', 'json',
    '--skip-static-report',
    '--code-snips-number', '-1',
    '--caller-id', CALLER_ID,
    '--session-id', sessionId,
    '--disable-telemetry',
  );

  return args;
}

// ----------------------------------------------------------------------------
// Metadata injection.
// ----------------------------------------------------------------------------

function capabilitiesFromConfig(config) {
  // Derive the metadata 'capabilities' list from the assessment config.
  const result = [];
  const runtime = config.targetRuntime;
  if (runtime && KNOWN_CAPABILITIES.has(runtime.toLowerCase())) {
    result.push(runtime);
  }
  if (config.enableContainerization) {
    result.push('containerization');
  }
  return result;
}

function targetIdToDisplayName(targetId) {
  return TARGET_ID_TO_DISPLAY_NAME[targetId.toLowerCase()] || targetId;
}

function injectMetadata(reportPath, config) {
  // Best-effort metadata injection; failures are logged but non-fatal.
  try {
    const root = JSON.parse(fs.readFileSync(reportPath, 'utf8'));

    if (!root || typeof root !== 'object' || Array.isArray(root)) {
      log('Report JSON root is not an object; skipping metadata injection.');
      return;
    }

    let metadata = root.metadata;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      metadata = {};
      root.metadata = metadata;
    }

    metadata.capabilities = capabilitiesFromConfig(config);
    metadata.os = [...config.targetOS];
    metadata.domains = [...config.assessmentDomains];
    metadata.mode = config.analysisCoverage;
    metadata.minimumCveSeverity = config.minimumCveSeverity;

    const existingTargets = metadata.targetIds;
    if (!(Array.isArray(existingTargets) && existingTargets.length > 0)) {
      metadata.targetIds = [...config.targetComputeServices];
      metadata.targetDisplayNames = config.targetComputeServices.map((t) => targetIdToDisplayName(t));
    }

    fs.writeFileSync(reportPath, JSON.stringify(root, null, 2));
  } catch (exc) {
    log(`Failed to inject assessment metadata into report (${exc}); continuing.`);
  }
}

// ----------------------------------------------------------------------------
// AppCAT discovery — the skill downloads + extracts the self-contained native
// appcat launcher directly into ~/.appcat (appcat.exe on Windows, appcat
// elsewhere); this script only locates it.
// ----------------------------------------------------------------------------

function findAppcatExecutable(rootDir) {
  // appcat is a self-contained native binary: appcat.exe on Windows, appcat otherwise.
  for (const name of ['appcat.exe', 'appcat']) {
    const candidate = path.join(rootDir, name);
    if (isFile(candidate)) return candidate;
  }
  return null;
}

function runAppcat(executable, args) {
  log(`Running: appcat ${args.join(' ')}`);
  // appcat streams its own per-rule progress to the console (stdio: 'inherit'),
  // so the analysis phase is self-evidently alive without extra heartbeat logging.
  const completed = spawnSync(executable, args, { stdio: 'inherit' });
  if (completed.error) {
    return 1;
  }
  return completed.status === null ? 1 : completed.status;
}

// ----------------------------------------------------------------------------
// Report id derivation from the report's analysis start time.
// ----------------------------------------------------------------------------

function utcNowStamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  );
}

function deriveReportId(reportPath) {
  // reportId = metadata.analysisStartTime formatted as yyyyMMddHHmmss; UTC now as fallback.
  try {
    const data = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    const start = data && data.metadata ? data.metadata.analysisStartTime : null;
    if (typeof start === 'string' && start.trim()) {
      const m = start.match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
      if (m) {
        return `${m[1]}${m[2]}${m[3]}${m[4]}${m[5]}${m[6]}`;
      }
      const digits = (start.match(/\d+/g) || []).join('');
      if (digits.length >= 14) {
        return digits.slice(0, 14);
      }
    }
  } catch (exc) {
    log(`Could not derive reportId from analysisStartTime (${exc}); using current UTC time.`);
  }

  return utcNowStamp();
}

// ----------------------------------------------------------------------------
// Helpers.
// ----------------------------------------------------------------------------

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------

async function main() {
  const { values } = parseArgs({
    options: {
      'workspace-path': { type: 'string' },
      config: { type: 'string' },
      'reports-dir': { type: 'string' },
    },
    strict: true,
  });

  const appcatHome = path.join(os.homedir(), '.appcat');

  const workspace = path.resolve(values['workspace-path'] || process.cwd());
  if (!isDir(workspace)) {
    fail(`Workspace path does not exist: ${workspace}`);
  }

  const configPath = values.config
    || path.join(workspace, '.github', 'modernize', 'assessment', 'reports', 'assessment-config.yaml');
  const reportsDir = values['reports-dir']
    || path.join(workspace, '.github', 'modernize', 'assessment', 'reports');

  const config = loadConfig(configPath);
  log(
    `Resolved config: domains=${JSON.stringify(config.assessmentDomains)} `
    + `runtime=${config.targetRuntime} services=${JSON.stringify(config.targetComputeServices)} `
    + `os=${JSON.stringify(config.targetOS)} containerization=${config.enableContainerization}`,
  );

  const executable = findAppcatExecutable(appcatHome);
  if (!executable) {
    fail(`No AppCAT executable found under ${appcatHome}. The skill must download and extract AppCAT there first.`);
  }
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(executable, 0o755);
    } catch {
      /* best-effort */
    }
  }
  log(`Using AppCAT at ${executable}`);

  const correlationId = randomUUID();
  const sessionId = randomUUID();

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'appcat-out-'));
  let finalReport;
  try {
    const analyzeArgs = buildAnalyzeArguments(config, workspace, outDir, correlationId, sessionId);
    const exitCode = runAppcat(executable, analyzeArgs);

    const producedReport = path.join(outDir, 'report.json');
    if (exitCode !== 0 && !isFile(producedReport)) {
      fail(`AppCAT analyze failed with exit code ${exitCode}.`, exitCode || 1);
    }
    if (!isFile(producedReport)) {
      fail('AppCAT completed but no report.json was produced.');
    }

    injectMetadata(producedReport, config);

    const reportId = deriveReportId(producedReport);
    const versionedDir = path.join(reportsDir, `report-${reportId}`);
    fs.mkdirSync(versionedDir, { recursive: true });
    finalReport = path.join(versionedDir, 'report.json');
    fs.copyFileSync(producedReport, finalReport);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }

  log(`Assessment report written to: ${finalReport}`);
  process.stdout.write(`${finalReport}\n`);
}

if (require.main === module) {
  main()
    .then(() => {
      // Force a deterministic exit once stdout is flushed. appcat finishes and the
      // report is written, but a lingering keep-alive socket (Node's default HTTP
      // agent) or timer could otherwise keep the event loop alive and make the
      // process appear hung after its work is done.
      const exitNow = () => process.exit(0);
      if (process.stdout.writableLength === 0) {
        exitNow();
      } else {
        process.stdout.once('drain', exitNow);
      }
    })
    .catch((exc) => {
      fail(`Unexpected error: ${exc && exc.stack ? exc.stack : exc}`);
    });
}

module.exports = {
  loadYaml,
  asStrList,
  appcatDomains,
  isSecurityDomainOnly,
  buildLabelSelector,
  buildAnalyzeArguments,
  capabilitiesFromConfig,
  targetIdToDisplayName,
  deriveReportId,
  DEFAULT_CONFIG,
};

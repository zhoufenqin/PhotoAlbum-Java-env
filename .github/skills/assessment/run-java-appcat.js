#!/usr/bin/env node
// @ts-nocheck
/*
 * run-java-appcat.js — Cross-platform Java AppCAT assessment runner.
 *
 * This script is shipped inside the assessment skill and runs in the coding agent's
 * workspace. It downloads the Azure Migrate appcat-for-java CLI from a bundled manifest
 * (verifying sha256), runs `appcat analyze` parameterized from the assessment config, and
 * injects assessment metadata into the resulting report.json — using only Node.js built-in
 * modules (no npm install).
 *
 * The appcat-for-java CLI is self-contained: it bundles its own Java runtime, so no JDK
 * needs to be installed on the machine. Archive extraction shells out to the system `tar`
 * (present on Linux, macOS and Windows 10+), with a PowerShell fallback for zip on Windows.
 *
 * It runs on Linux, macOS and Windows (amd64 / arm64).
 *
 * Usage:
 *   node run-java-appcat.js [--workspace-path PATH] [--config FILE] [--reports-dir DIR]
 *                           [--appcat-home DIR] [--manifest FILE]
 *
 * Defaults:
 *   --workspace-path : current working directory
 *   --config         : {workspace}/.github/modernize/assessment/reports/assessment-config.yaml
 *   --reports-dir    : {workspace}/.github/modernize/assessment/reports
 *   --manifest       : appcat-java-manifest.json next to this script
 *
 * On success the script prints the absolute path of the versioned report.json and exits 0.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');
const { spawn, spawnSync } = require('node:child_process');
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ----------------------------------------------------------------------------
// Platform detection.
// ----------------------------------------------------------------------------

function detectPlatformKey() {
  const platform = process.platform;
  let osName;
  let ext;
  if (platform === 'win32') {
    osName = 'windows';
    ext = 'zip';
  } else if (platform === 'darwin') {
    osName = 'macos';
    ext = 'tar.gz';
  } else {
    osName = 'linux';
    ext = 'tar.gz';
  }

  const machine = process.arch.toLowerCase();
  let arch;
  if (machine === 'x64' || machine === 'amd64') {
    arch = 'amd64';
  } else if (machine === 'arm64' || machine === 'aarch64') {
    arch = 'arm64';
  } else {
    fail(`Unsupported architecture: ${process.arch}`);
  }

  return { platformKey: `${osName}-${arch}`, osName, ext };
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
// AppCAT acquisition — download + verify + extract from the bundled manifest.
// ----------------------------------------------------------------------------

function loadManifest(manifestPath) {
  if (!isFile(manifestPath)) {
    fail(`AppCAT manifest not found: ${manifestPath}`);
  }
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

function sha256Of(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function normalizeCandidateUrls(entry) {
  // Accept either a single `url` string or a `urls` array of mirrors. De-dupes
  // while preserving order (array mirrors first, then the legacy single url).
  const urls = [];
  if (Array.isArray(entry.urls)) {
    for (const candidate of entry.urls) {
      if (typeof candidate === 'string' && candidate.trim()) {
        urls.push(candidate.trim());
      }
    }
  }
  if (typeof entry.url === 'string' && entry.url.trim()) {
    urls.push(entry.url.trim());
  }
  return [...new Set(urls)];
}

function probeUrl(url, timeoutMs = 8_000, redirectsLeft = 5) {
  // Lightweight HEAD probe used to rank mirrors by reachability + latency.
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const req = https.request(url, { method: 'HEAD' }, (res) => {
      const status = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status) && redirectsLeft > 0 && res.headers.location) {
        const location = new URL(res.headers.location, url).toString();
        res.resume();
        resolve(probeUrl(location, timeoutMs, redirectsLeft - 1));
        return;
      }
      res.resume();
      resolve({ url, ok: status > 0 && status < 500, latencyMs: Date.now() - startedAt, status });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`probe timeout after ${timeoutMs}ms`));
    });
    req.on('error', (err) => resolve({
      url,
      ok: false,
      latencyMs: Number.POSITIVE_INFINITY,
      status: 0,
      error: err.message || String(err),
    }));
    req.end();
  });
}

async function orderCandidateUrls(urls) {
  // With a single source there is nothing to rank — skip the probe round-trip so we
  // don't add latency to the common case.
  if (urls.length <= 1) return [...urls];

  const probes = await Promise.all(urls.map((url) => probeUrl(url)));
  const sorted = [...probes].sort((a, b) => {
    if (a.ok !== b.ok) return a.ok ? -1 : 1;
    return a.latencyMs - b.latencyMs;
  });
  const details = sorted
    .map((item) => `${item.url} [${item.ok ? 'ok' : 'fail'}${Number.isFinite(item.latencyMs) ? `, ${item.latencyMs}ms` : ''}]`)
    .join(', ');
  log(`Download source probe: ${details}`);
  return sorted.map((item) => item.url);
}

function waitWithJitter(attempt) {
  // Exponential backoff capped at 8s, plus jitter, to avoid hammering a flaky source.
  const base = Math.min(8_000, 500 * (2 ** Math.max(0, attempt - 1)));
  const jitter = Math.floor(Math.random() * 300);
  return sleep(base + jitter);
}

function httpGet(url, dest, options = {}) {
  // Time allowed to establish the connection / receive the first response. A stalled
  // *connect* should fail fast; a slow-but-progressing download should not.
  const CONNECT_TIMEOUT_MS = options.connectTimeoutMs || 30_000;
  // Idle read timeout: abort only if no bytes arrive for this long, so a slow but
  // live transfer keeps going instead of being killed at a fixed deadline.
  const READ_TIMEOUT_MS = options.readTimeoutMs || 300_000;
  // Emit a liveness line on this cadence so a slow sandbox download is not mistaken
  // for a hung process.
  const HEARTBEAT_MS = options.heartbeatMs || 5_000;
  // Resume offset: when > 0 we ask the server to continue from this byte (HTTP Range).
  const resumeFrom = Math.max(0, Number(options.resumeFrom || 0));
  const redirectsLeft = Number.isInteger(options.redirectsLeft) ? options.redirectsLeft : 5;

  return new Promise((resolve, reject) => {
    let connectTimer = null;
    let heartbeat = null;
    let file = null;
    let settled = false;
    let phase = 'connecting';
    let effectiveStart = resumeFrom;
    let totalBytes = 0;
    let received = 0;
    const startedAt = Date.now();

    const stopHeartbeat = () => {
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
    };
    const clearConnectTimer = () => {
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
    };
    const closeFile = (cb) => {
      if (!file) {
        cb();
        return;
      }
      const current = file;
      file = null;
      current.close(() => cb());
    };
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      stopHeartbeat();
      clearConnectTimer();
      // Leave the partial file in place on failure so a later attempt can resume it.
      closeFile(fn);
    };
    const cleanupAndReject = (err) => {
      finish(() => reject(err));
    };

    heartbeat = setInterval(() => {
      const secs = Math.round((Date.now() - startedAt) / 1000);
      if (phase === 'connecting') {
        log(`Connecting to download source... ${secs}s elapsed`);
        return;
      }
      const downloadedMb = ((effectiveStart + received) / 1048576).toFixed(1);
      const totalMb = totalBytes ? (totalBytes / 1048576).toFixed(1) : '?';
      const pct = totalBytes ? ` (${Math.floor(((effectiveStart + received) / totalBytes) * 100)}%)` : '';
      log(`Downloading AppCAT: ${downloadedMb}/${totalMb} MB${pct} — ${secs}s elapsed`);
    }, HEARTBEAT_MS);
    if (typeof heartbeat.unref === 'function') {
      heartbeat.unref();
    }

    const headers = resumeFrom > 0 ? { Range: `bytes=${resumeFrom}-` } : {};
    const req = https.get(url, { headers }, (res) => {
      clearConnectTimer();
      const status = res.statusCode || 0;

      if ([301, 302, 303, 307, 308].includes(status)) {
        res.resume();
        if (redirectsLeft <= 0) {
          cleanupAndReject(new Error('Too many redirects'));
          return;
        }
        const location = res.headers.location;
        if (!location) {
          cleanupAndReject(new Error(`Redirect (${status}) without Location header`));
          return;
        }
        const redirected = new URL(location, url).toString();
        finish(() => {
          resolve(httpGet(redirected, dest, {
            ...options,
            redirectsLeft: redirectsLeft - 1,
            resumeFrom,
          }));
        });
        return;
      }

      // Range satisfied as "already complete" — the partial file is the whole file.
      if (resumeFrom > 0 && status === 416) {
        res.resume();
        finish(() => resolve());
        return;
      }

      if (status !== 200 && status !== 206) {
        res.resume();
        cleanupAndReject(new Error(`HTTP ${status}`));
        return;
      }

      if (resumeFrom > 0 && status === 200) {
        // Server ignored the Range request; restart from byte 0 (truncate the file).
        log('Server did not honor range request; restarting full download from byte 0.');
        effectiveStart = 0;
      } else if (resumeFrom > 0 && status === 206) {
        effectiveStart = resumeFrom;
      }

      phase = 'downloading';
      const length = Number(res.headers['content-length']) || 0;
      totalBytes = length ? length + effectiveStart : 0;

      file = fs.createWriteStream(dest, { flags: effectiveStart > 0 ? 'a' : 'w' });
      file.on('error', cleanupAndReject);
      res.on('error', cleanupAndReject);
      res.setTimeout(READ_TIMEOUT_MS, () => {
        req.destroy(new Error(`Read stalled (no data for ${READ_TIMEOUT_MS / 1000}s)`));
      });
      res.on('data', (chunk) => {
        received += chunk.length;
      });
      res.pipe(file);
      file.on('finish', () => {
        finish(() => resolve());
      });
    });

    connectTimer = setTimeout(() => {
      req.destroy(new Error(`Connection timeout after ${CONNECT_TIMEOUT_MS / 1000}s`));
    }, CONNECT_TIMEOUT_MS);
    if (typeof connectTimer.unref === 'function') {
      connectTimer.unref();
    }
    req.on('error', cleanupAndReject);
  });
}

let _curlAvailable;

function curlAvailable() {
  // `curl` ships natively on Linux, macOS and Windows 10+ (as curl.exe). Detect once.
  if (_curlAvailable !== undefined) return _curlAvailable;
  try {
    const res = spawnSync('curl', ['--version'], { stdio: 'ignore' });
    _curlAvailable = !res.error && res.status === 0;
  } catch {
    _curlAvailable = false;
  }
  return _curlAvailable;
}

function downloadWithCurl(url, part) {
  // Use the OS-native curl transport — it goes through the platform network stack
  // (typically faster and more robust than Node's https in sandboxed/proxied CI) and
  // has built-in redirect following (-L), retries (--retry) and resume (-C -). Resolves
  // to true on success; on any failure we fall back to the Node https implementation.
  //
  // IMPORTANT: curl's progress meter writes to stderr on a tight cadence. When this
  // process runs inside a harness that captures (pipes) stderr and drains it slowly,
  // those progress writes block on pipe backpressure and throttle the transfer to a
  // crawl — which is why "the same curl" feels fast in a terminal but slow from the
  // script. We therefore disable the progress meter (--no-progress-meter) and emit our
  // own low-frequency heartbeat by polling the .part file size, so the download runs at
  // full speed while still proving liveness.
  return new Promise((resolve) => {
    const args = [
      '-L', // follow redirects
      '--fail', // non-zero exit on HTTP >= 400
      '--no-progress-meter', // no chatty stderr → no pipe backpressure throttling
      '--retry', '5',
      '--retry-delay', '2',
      '--connect-timeout', '30',
      '-C', '-', // resume the .part file when it already has bytes
      '-o', part,
      url,
    ];
    log('Using native curl transport.');
    const startedAt = Date.now();
    let child;
    try {
      // stdin/stdout ignored; stderr piped and drained here so curl never blocks on it.
      child = spawn('curl', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch {
      resolve(false);
      return;
    }

    let stderrTail = '';
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-2000);
      });
    }

    const heartbeat = setInterval(() => {
      const secs = Math.round((Date.now() - startedAt) / 1000);
      const mb = isFile(part) ? (fs.statSync(part).size / 1048576).toFixed(1) : '0.0';
      log(`Downloading AppCAT via curl: ${mb} MB — ${secs}s elapsed`);
    }, 5_000);
    if (typeof heartbeat.unref === 'function') {
      heartbeat.unref();
    }

    child.on('error', () => {
      clearInterval(heartbeat);
      resolve(false);
    });
    child.on('close', (code) => {
      clearInterval(heartbeat);
      if (code !== 0) {
        const lastLine = stderrTail.trim().split(/\r?\n/).pop();
        if (lastLine) {
          log(`curl exited ${code}: ${lastLine}`);
        }
      }
      resolve(code === 0);
    });
  });
}

async function downloadFile(urls, dest, maxRetries = 5) {
  const ordered = await orderCandidateUrls(urls);
  if (ordered.length === 0) {
    fail('No download URL available for AppCAT.');
  }
  // Resume against a sibling `.part` file. Because `dest` lives in the persistent cache,
  // the `.part` survives a killed process and a later run continues where it left off.
  const part = `${dest}.part`;
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    for (const [sourceIndex, url] of ordered.entries()) {
      try {
        const existingBytes = isFile(part) ? fs.statSync(part).size : 0;
        const existingMb = (existingBytes / 1048576).toFixed(1);
        log(
          `Downloading AppCAT (attempt ${attempt}/${maxRetries}, source ${sourceIndex + 1}/${ordered.length}); `
          + `resuming at ${existingMb} MB...`,
        );
        // Prefer the native curl transport for speed; fall back to Node https when curl is
        // unavailable or returns an error (e.g. a server that ignores Range requests).
        let done = false;
        if (curlAvailable()) {
          done = await downloadWithCurl(url, part);
          if (!done) {
            log('curl transfer did not complete; falling back to Node https.');
          }
        }
        if (!done) {
          const bytesNow = isFile(part) ? fs.statSync(part).size : 0;
          await httpGet(url, part, {
            resumeFrom: bytesNow,
            connectTimeoutMs: 30_000,
            readTimeoutMs: 300_000,
            heartbeatMs: 5_000,
          });
        }
        fs.renameSync(part, dest);
        log(`Download complete from ${url}.`);
        return;
      } catch (exc) {
        lastError = exc;
        log(`Download failed from ${url}: ${exc.message || exc}`);
      }
    }
    if (attempt < maxRetries) {
      await waitWithJitter(attempt);
    }
  }
  fail(`Failed to download AppCAT after ${maxRetries} attempts: ${lastError}`);
}

function extractArchive(archivePath, ext, destDir) {
  fs.mkdirSync(destDir, { recursive: true });

  // System `tar` (bsdtar on Windows 10+, GNU tar / bsdtar on Linux/macOS) handles
  // both .tar.gz (-xzf) and .zip (-xf) archives. Any wrapper directory in the archive
  // is fine — findAppcatExecutable locates the launcher recursively.
  const args = ext === 'zip'
    ? ['-xf', archivePath, '-C', destDir]
    : ['-xzf', archivePath, '-C', destDir];
  const res = spawnSync('tar', args, { stdio: 'inherit' });
  if (!res.error && res.status === 0) {
    return;
  }

  // Fallback for zip on Windows when a zip-capable tar is unavailable.
  if (ext === 'zip') {
    const ps = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${destDir}' -Force`,
      ],
      { stdio: 'inherit' },
    );
    if (!ps.error && ps.status === 0) {
      return;
    }
  }

  fail(`Failed to extract archive: ${archivePath}`);
}

function walkFiles(rootDir) {
  const results = [];
  const stack = [rootDir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        results.push(full);
      }
    }
  }
  return results;
}

function findAppcatExecutable(rootDir, osName) {
  // Locate the appcat launcher anywhere under rootDir (robust to archive nesting).
  const preferred = osName === 'windows'
    ? ['appcat.exe', 'appcat.bat', 'appcat.cmd', 'appcat']
    : ['appcat', 'appcat.sh'];

  if (!isDir(rootDir)) return null;

  const found = {};
  for (const file of walkFiles(rootDir)) {
    const name = path.basename(file).toLowerCase();
    if (preferred.includes(name) && !(name in found)) {
      found[name] = file;
    }
  }

  for (const name of preferred) {
    if (name in found) return found[name];
  }
  return null;
}

async function ensureAppcat(manifest, platformKey, osName, ext, cacheRoot) {
  const entry = (manifest.platforms || {})[platformKey];
  if (!entry) {
    fail(`Manifest has no entry for platform '${platformKey}'.`);
  }

  const candidateUrls = normalizeCandidateUrls(entry);
  if (candidateUrls.length === 0) {
    fail(`Manifest platform '${platformKey}' has no downloadable URL.`);
  }

  const version = manifest.version || 'unknown';
  const installDir = path.join(cacheRoot, version, platformKey);

  const cached = isDir(installDir) ? findAppcatExecutable(installDir, osName) : null;
  if (cached) {
    log(`Reusing cached AppCAT at ${cached}`);
    return cached;
  }

  // Download into a persistent cache area (not an os.tmpdir() folder) so a partially
  // downloaded archive can be resumed even if a previous run's process was killed —
  // e.g. when the surrounding harness times out and terminates this script mid-download.
  const downloadsDir = path.join(cacheRoot, 'downloads');
  fs.mkdirSync(downloadsDir, { recursive: true });
  const archivePath = path.join(downloadsDir, `${platformKey}-${version}.${ext}`);

  const downloadStart = Date.now();
  await downloadFile(candidateUrls, archivePath);
  log(`Download phase finished in ${((Date.now() - downloadStart) / 1000).toFixed(1)}s.`);

  const expected = (entry.sha256 || '').toLowerCase();
  if (!expected) {
    fail(`Manifest entry for '${platformKey}' is missing a sha256 checksum; refusing to use an unverified archive.`);
  }
  const sha256Start = Date.now();
  const actual = (await sha256Of(archivePath)).toLowerCase();
  if (actual !== expected) {
    // Drop the corrupt artifacts so the next run starts clean instead of resuming
    // onto bad bytes and failing the checksum on every attempt.
    fs.rmSync(archivePath, { force: true });
    fs.rmSync(`${archivePath}.part`, { force: true });
    fail(`sha256 mismatch for ${platformKey}: expected ${expected}, got ${actual}`);
  }
  log(`sha256 verified in ${((Date.now() - sha256Start) / 1000).toFixed(1)}s.`);

  if (isDir(installDir)) {
    fs.rmSync(installDir, { recursive: true, force: true });
  }
  const extractStart = Date.now();
  extractArchive(archivePath, ext, installDir);
  log(`Extracted in ${((Date.now() - extractStart) / 1000).toFixed(1)}s.`);

  // Archive verified and extracted; remove it to keep the cache small.
  fs.rmSync(archivePath, { force: true });

  const executable = findAppcatExecutable(installDir, osName);
  if (!executable) {
    fail(`AppCAT executable not found after extracting to ${installDir}`);
  }

  if (osName !== 'windows') {
    try {
      fs.chmodSync(executable, 0o755);
    } catch {
      /* best-effort */
    }
  }

  log(`AppCAT ready at ${executable}`);
  return executable;
}

function runAppcat(executable, args, osName) {
  const lower = executable.toLowerCase();
  let command;
  let commandArgs;
  if (osName === 'windows' && (lower.endsWith('.bat') || lower.endsWith('.cmd'))) {
    command = 'cmd';
    commandArgs = ['/c', executable, ...args];
  } else {
    command = executable;
    commandArgs = args;
  }

  log(`Running: appcat ${args.join(' ')}`);
  // appcat streams its own per-rule progress to the console (stdio: 'inherit'),
  // so the analysis phase is self-evidently alive without extra heartbeat logging.
  const completed = spawnSync(command, commandArgs, { stdio: 'inherit' });
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
  const scriptDir = __dirname;

  const { values } = parseArgs({
    options: {
      'workspace-path': { type: 'string' },
      config: { type: 'string' },
      'reports-dir': { type: 'string' },
      manifest: { type: 'string' },
      'appcat-home': { type: 'string' },
    },
    strict: true,
  });

  const workspace = path.resolve(values['workspace-path'] || process.cwd());
  if (!isDir(workspace)) {
    fail(`Workspace path does not exist: ${workspace}`);
  }

  const manifestPath = values.manifest || path.join(scriptDir, 'appcat-java-manifest.json');
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

  const { platformKey, osName, ext } = detectPlatformKey();
  log(`Detected platform: ${platformKey}`);

  let executable;
  if (values['appcat-home']) {
    executable = findAppcatExecutable(values['appcat-home'], osName);
    if (!executable) {
      fail(`No AppCAT executable found under --appcat-home: ${values['appcat-home']}`);
    }
  } else {
    const manifest = loadManifest(manifestPath);
    const cacheRoot = path.join(os.homedir(), '.appcat-cca');
    executable = await ensureAppcat(manifest, platformKey, osName, ext, cacheRoot);
  }

  const correlationId = randomUUID();
  const sessionId = randomUUID();

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'appcat-out-'));
  let finalReport;
  try {
    const analyzeArgs = buildAnalyzeArguments(config, workspace, outDir, correlationId, sessionId);
    const exitCode = runAppcat(executable, analyzeArgs, osName);

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
  detectPlatformKey,
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

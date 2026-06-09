#!/usr/bin/env python3
"""run-java-appcat.py — Cross-platform Java AppCAT assessment runner.

This script is shipped inside the assessment skill and runs in the coding agent's
workspace. It acquires the appcat-for-java CLI (download + sha256 verify + extract
into ~/.appcat, with version-aware caching), runs ``appcat analyze`` parameterized
from the assessment config, and injects assessment metadata into the resulting
report.json — using only the Python standard library (no pip install).

The appcat CLI is self-contained (it bundles its own Java runtime, so no JDK is
needed on the machine). Acquisition is driven by appcat-java-manifest.json, which
ships next to this script.

It runs on Linux, macOS and Windows (amd64 / arm64).

Usage:
    python run-java-appcat.py [--workspace-path PATH] [--config FILE] [--reports-dir DIR]
                              [--manifest FILE]

Defaults:
    --workspace-path : current working directory
    --config         : {workspace}/.github/modernize/assessment/reports/assessment-config.yaml
    --reports-dir    : {workspace}/.github/modernize/assessment/reports
    --manifest       : {script-dir}/appcat-java-manifest.json

The script downloads + extracts AppCAT into ~/.appcat on first use and reuses the
cached binary on subsequent runs (re-downloading only when the manifest version
changes). On success it prints the absolute path of the versioned report.json and
exits 0.
"""

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import urllib.request
import uuid
import zipfile
from datetime import datetime, timezone

# ----------------------------------------------------------------------------
# Constants.
# ----------------------------------------------------------------------------

# Caller identifier reported to appcat for telemetry.
CALLER_ID = "GitHub-Copilot-Modernize-CLI"

# Default assessment configuration used when no assessment-config.yaml is present.
DEFAULT_CONFIG = {
    "assessmentDomains": ["cloud-readiness", "java-upgrade"],
    "analysisCoverage": "issue-only",
    "targetRuntime": "openjdk25",
    "targetComputeServices": ["azure-appservice", "azure-aks", "azure-container-apps"],
    "targetOS": ["linux", "windows"],
    "enableContainerization": False,
    "minimumCveSeverity": "high",
}

# Default runtime when the java-upgrade domain has no targetRuntime.
DEFAULT_JAVA_RUNTIME = "openjdk25"

# Default minimum CVE severity.
DEFAULT_MINIMUM_CVE_SEVERITY = "high"

# Capabilities recognized for the metadata 'capabilities' field.
KNOWN_CAPABILITIES = {
    "openjdk11", "openjdk17", "openjdk21", "openjdk25", "containerization",
}

# Target id -> display name (lookup is case-insensitive).
TARGET_ID_TO_DISPLAY_NAME = {
    "azure-appservice": "Azure App Service",
    "azure-aks": "Azure Kubernetes Service",
    "azure-container-apps": "Azure Container Apps",
}


def log(message):
    sys.stderr.write(f"[run-java-appcat] {message}\n")
    sys.stderr.flush()


def fail(message, code=1):
    log(f"ERROR: {message}")
    sys.exit(code)


# ----------------------------------------------------------------------------
# Minimal YAML loading for assessment-config.yaml.
# A small indentation-based parser that supports the known config shape
# (nested maps + sequences of scalars). No external dependency.
# ----------------------------------------------------------------------------

def _scalar(token):
    t = token.strip()
    if len(t) >= 2 and t[0] == t[-1] and t[0] in ("'", '"'):
        return t[1:-1]
    low = t.lower()
    if low in ("true", "yes"):
        return True
    if low in ("false", "no"):
        return False
    if low in ("null", "~", ""):
        return None
    return t


def _tokenize_yaml(text):
    tokens = []
    for raw in text.splitlines():
        if not raw.strip():
            continue
        stripped = raw.strip()
        if stripped.startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip(" "))
        tokens.append({"indent": indent, "content": stripped})
    return tokens


def _parse_yaml(tokens, pos, indent):
    if pos >= len(tokens):
        return None, pos

    if tokens[pos]["content"].startswith("- "):
        items = []
        while pos < len(tokens):
            ind = tokens[pos]["indent"]
            content = tokens[pos]["content"]
            if ind != indent or not content.startswith("- "):
                break
            items.append(_scalar(content[2:]))
            pos += 1
        return items, pos

    mapping = {}
    while pos < len(tokens):
        ind = tokens[pos]["indent"]
        content = tokens[pos]["content"]
        if ind != indent or ":" not in content:
            break
        idx = content.index(":")
        key = content[:idx].strip()
        val = content[idx + 1:].strip()
        if val:
            mapping[key] = _scalar(val)
            pos += 1
            continue
        pos += 1
        if pos < len(tokens):
            nind = tokens[pos]["indent"]
            ncontent = tokens[pos]["content"]
            if ncontent.startswith("- ") and nind >= indent:
                node, pos = _parse_yaml(tokens, pos, nind)
                mapping[key] = node
            elif nind > indent:
                node, pos = _parse_yaml(tokens, pos, nind)
                mapping[key] = node
            else:
                mapping[key] = None
        else:
            mapping[key] = None
    return mapping, pos


def load_yaml(text):
    tokens = _tokenize_yaml(text)
    start_indent = tokens[0]["indent"] if tokens else 0
    node, _ = _parse_yaml(tokens, 0, start_indent)
    return node or {}


def as_str_list(value):
    if value is None:
        return []
    if isinstance(value, list):
        return [str(v) for v in value if v is not None]
    return [str(value)]


def load_config(config_path):
    if not config_path or not _is_file(config_path):
        log(f"No assessment config at '{config_path}'; using default Java config.")
        return dict(DEFAULT_CONFIG)

    try:
        with open(config_path, "r", encoding="utf-8") as fh:
            root = load_yaml(fh.read())
    except Exception as exc:  # noqa: BLE001
        log(f"Failed to read config '{config_path}' ({exc}); using default Java config.")
        return dict(DEFAULT_CONFIG)

    is_obj = isinstance(root, dict)
    # Top-level analysisCoverage applies to all languages and overrides the
    # language-specific value when present (mirrors the C# BaseAssessmentExecutor).
    root_coverage = root.get("analysisCoverage") if is_obj else None

    java = root.get("java") if is_obj else None
    if not isinstance(java, dict):
        log("Config has no 'java' section; using default Java config.")
        cfg = dict(DEFAULT_CONFIG)
        cfg["analysisCoverage"] = root_coverage or DEFAULT_CONFIG["analysisCoverage"]
        return cfg

    return {
        "assessmentDomains": as_str_list(java.get("assessmentDomains")),
        "analysisCoverage": root_coverage or java.get("analysisCoverage") or "issue-only",
        "targetRuntime": java.get("targetRuntime"),
        "targetComputeServices": as_str_list(java.get("targetComputeServices")),
        "targetOS": as_str_list(java.get("targetOS")),
        "enableContainerization": bool(java.get("enableContainerization") or False),
        "minimumCveSeverity": java.get("minimumCveSeverity") or DEFAULT_MINIMUM_CVE_SEVERITY,
    }


# ----------------------------------------------------------------------------
# Label selector construction.
# ----------------------------------------------------------------------------

def appcat_domains(config):
    # Domains excluding 'security'.
    return [d for d in config["assessmentDomains"] if d.lower() != "security"]


def is_security_domain_only(config):
    domains = config["assessmentDomains"]
    return len(domains) > 0 and all(d.lower() == "security" for d in domains)


def _build_cloud_readiness_selector(config):
    parts = ["domain=cloud-readiness"]

    services = config["targetComputeServices"]
    if services:
        targets = " || ".join(f"target={t}" for t in services)
        parts.append(targets if len(services) == 1 else f"({targets})")

    oses = config["targetOS"]
    if oses:
        os_list = " || ".join(f"os={o}" for o in oses)
        parts.append(os_list if len(oses) == 1 else f"({os_list})")

    if config["enableContainerization"]:
        parts.append("capability=containerization")

    return f"({' && '.join(parts)})"


def _build_java_upgrade_selector(config):
    runtime = config["targetRuntime"] or DEFAULT_JAVA_RUNTIME
    return f"(domain=java-upgrade && (capability={runtime} || !capability={runtime}))"


def build_label_selector(config):
    # Returns None when no AppCAT domains are configured.
    domains = appcat_domains(config)
    if not domains:
        return None

    selectors = []
    for domain in domains:
        key = domain.lower()
        if key == "cloud-readiness":
            selectors.append(_build_cloud_readiness_selector(config))
        elif key == "java-upgrade":
            selectors.append(_build_java_upgrade_selector(config))

    if not selectors:
        return None
    return " || ".join(selectors)


# ----------------------------------------------------------------------------
# Analyze arguments.
# ----------------------------------------------------------------------------

def build_analyze_arguments(config, input_path, output_dir, correlation_id, session_id):
    label_selector = build_label_selector(config)

    args = [
        "analyze",
        "--input", input_path,
        "--output", output_dir,
        "--mode", "issue-only",
        "--correlation-id", correlation_id,
    ]

    if is_security_domain_only(config):
        # Security-only mode: collect app info without running assessment rulesets.
        args.append("--enable-default-rulesets=false")

    if label_selector is not None:
        args.extend(["--label-selector", label_selector])
    else:
        args.extend(["--target", "azure-aks,azure-appservice,azure-container-apps"])

    args.extend([
        "--overwrite",
        "--output-format", "json",
        "--skip-static-report",
        "--code-snips-number", "-1",
        "--caller-id", CALLER_ID,
        "--session-id", session_id,
        "--disable-telemetry",
    ])

    return args


# ----------------------------------------------------------------------------
# Metadata injection.
# ----------------------------------------------------------------------------

def capabilities_from_config(config):
    # Derive the metadata 'capabilities' list from the assessment config.
    result = []
    runtime = config["targetRuntime"]
    if runtime and runtime.lower() in KNOWN_CAPABILITIES:
        result.append(runtime)
    if config["enableContainerization"]:
        result.append("containerization")
    return result


def target_id_to_display_name(target_id):
    return TARGET_ID_TO_DISPLAY_NAME.get(target_id.lower(), target_id)


def inject_metadata(report_path, config):
    # Best-effort metadata injection; failures are logged but non-fatal.
    try:
        with open(report_path, "r", encoding="utf-8") as fh:
            root = json.load(fh)

        if not isinstance(root, dict):
            log("Report JSON root is not an object; skipping metadata injection.")
            return

        metadata = root.get("metadata")
        if not isinstance(metadata, dict):
            metadata = {}
            root["metadata"] = metadata

        metadata["capabilities"] = capabilities_from_config(config)
        metadata["os"] = list(config["targetOS"])
        metadata["domains"] = list(config["assessmentDomains"])
        metadata["mode"] = config["analysisCoverage"]
        metadata["minimumCveSeverity"] = config["minimumCveSeverity"]

        existing_targets = metadata.get("targetIds")
        if not (isinstance(existing_targets, list) and len(existing_targets) > 0):
            metadata["targetIds"] = list(config["targetComputeServices"])
            metadata["targetDisplayNames"] = [
                target_id_to_display_name(t) for t in config["targetComputeServices"]
            ]

        with open(report_path, "w", encoding="utf-8") as fh:
            json.dump(root, fh, indent=2)
    except Exception as exc:  # noqa: BLE001
        log(f"Failed to inject assessment metadata into report ({exc}); continuing.")


# ----------------------------------------------------------------------------
# AppCAT acquisition — download + sha256 verify + extract the self-contained
# native appcat launcher directly into ~/.appcat (appcat.exe on Windows, appcat
# elsewhere), with version-aware caching driven by appcat-java-manifest.json.
# ----------------------------------------------------------------------------

def detect_platform_key():
    # Returns "{os}-{arch}" matching the manifest keys, e.g. "linux-amd64".
    plat = sys.platform
    if plat.startswith("linux"):
        os_name = "linux"
    elif plat == "darwin":
        os_name = "macos"
    elif plat.startswith("win"):
        os_name = "windows"
    else:
        os_name = plat

    machine = (platform.machine() or "").lower()
    if machine in ("x86_64", "amd64", "x64"):
        arch = "amd64"
    elif machine in ("arm64", "aarch64"):
        arch = "arm64"
    else:
        arch = machine

    return f"{os_name}-{arch}"


def load_manifest(manifest_path):
    with open(manifest_path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def find_appcat_executable(root_dir):
    # appcat is a self-contained native binary: appcat.exe on Windows, appcat
    # otherwise. Extraction strips the archive's single top-level folder, so the
    # launcher lands directly under root_dir (e.g. ~/.appcat/appcat.exe).
    for name in ("appcat.exe", "appcat"):
        candidate = os.path.join(root_dir, name)
        if _is_file(candidate):
            return candidate
    return None


def _sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _download(url, dest):
    log(f"Downloading AppCAT from {url}")
    # urlopen handles the redirect chain from download.visualstudio.microsoft.com.
    with urllib.request.urlopen(url) as resp, open(dest, "wb") as out:  # noqa: S310
        shutil.copyfileobj(resp, out)


def _strip_first_component(name):
    # Drop the archive's single top-level folder so the launcher lands directly in
    # ~/.appcat (equivalent to `tar --strip-components=1`). Returns None for the
    # top-level dir entry itself (nothing to extract).
    # Normalize away "." segments first: tar archives commonly prefix entries with
    # "./", which would otherwise be mistaken for the top-level component and leave
    # the real folder (and the launcher under it) one level too deep.
    parts = [p for p in name.replace("\\", "/").split("/") if p not in ("", ".")]
    if len(parts) <= 1:
        return None
    return os.path.join(*parts[1:])


def _extract_stripped(archive, dest_dir):
    # Extract archive into dest_dir, stripping the single top-level folder. Guards
    # against path traversal (zip-slip / tar-slip) by confining every member to
    # dest_dir.
    dest_root = os.path.abspath(dest_dir)

    def _safe_join(rel):
        target = os.path.abspath(os.path.join(dest_root, rel))
        if target != dest_root and not target.startswith(dest_root + os.sep):
            raise ValueError(f"Refusing to extract outside target dir: {rel}")
        return target

    if archive.endswith(".zip"):
        with zipfile.ZipFile(archive) as zf:
            for info in zf.infolist():
                rel = _strip_first_component(info.filename)
                if rel is None:
                    continue
                target = _safe_join(rel)
                if info.is_dir():
                    os.makedirs(target, exist_ok=True)
                    continue
                os.makedirs(os.path.dirname(target), exist_ok=True)
                with zf.open(info) as src, open(target, "wb") as out:
                    shutil.copyfileobj(src, out)
    else:
        # .tar.gz / .tgz
        with tarfile.open(archive, "r:*") as tf:
            for member in tf.getmembers():
                rel = _strip_first_component(member.name)
                if rel is None:
                    continue
                target = _safe_join(rel)
                if member.isdir():
                    os.makedirs(target, exist_ok=True)
                    continue
                os.makedirs(os.path.dirname(target), exist_ok=True)
                extracted = tf.extractfile(member)
                if extracted is None:
                    continue
                with extracted as src, open(target, "wb") as out:
                    shutil.copyfileobj(src, out)
                # Preserve the executable bit so appcat can be launched on POSIX.
                if member.mode & 0o111:
                    os.chmod(target, os.stat(target).st_mode | 0o111)


def ensure_appcat(appcat_home, manifest_path):
    """Ensure an appcat launcher exists under ``appcat_home`` and return its path.

    Version-aware cache: when ``appcat_home`` already holds the launcher AND the
    recorded version matches the manifest, the cached binary is reused and nothing
    is downloaded. Otherwise the platform archive is downloaded, sha256-verified,
    and extracted (stripping the single top-level folder).
    """
    if not _is_file(manifest_path):
        fail(f"AppCAT manifest not found at {manifest_path}.")

    manifest = load_manifest(manifest_path)
    version = str(manifest.get("version") or "")
    platform_key = detect_platform_key()
    platforms = manifest.get("platforms") or {}
    entry = platforms.get(platform_key)
    if not entry or not entry.get("url"):
        fail(
            f"No AppCAT download for platform '{platform_key}' in manifest "
            f"{manifest_path}. Available: {', '.join(sorted(platforms)) or '(none)'}."
        )

    version_marker = os.path.join(appcat_home, ".appcat-version")
    existing = find_appcat_executable(appcat_home)
    if existing:
        cached_version = None
        if _is_file(version_marker):
            try:
                with open(version_marker, "r", encoding="utf-8") as fh:
                    cached_version = fh.read().strip()
            except OSError:
                cached_version = None
        if cached_version == version:
            log(f"AppCAT {version} already cached at {existing}; skipping download.")
            return existing
        log(
            f"Cached AppCAT version '{cached_version}' != manifest '{version}'; "
            "re-acquiring."
        )

    os.makedirs(appcat_home, exist_ok=True)
    url = entry["url"]
    expected_sha = (entry.get("sha256") or "").lower()
    suffix = ".zip" if url.lower().endswith(".zip") else ".tar.gz"

    tmp_fd, tmp_archive = tempfile.mkstemp(prefix="appcat-dl-", suffix=suffix)
    os.close(tmp_fd)
    try:
        try:
            _download(url, tmp_archive)
        except Exception as exc:  # noqa: BLE001
            fail(f"Failed to download AppCAT from {url}: {exc}")

        if expected_sha:
            actual_sha = _sha256_of(tmp_archive)
            if actual_sha.lower() != expected_sha:
                fail(
                    "AppCAT download failed sha256 verification "
                    f"(expected {expected_sha}, got {actual_sha})."
                )
            log("AppCAT archive sha256 verified.")

        log(f"Extracting AppCAT into {appcat_home}")
        try:
            _extract_stripped(tmp_archive, appcat_home)
        except Exception as exc:  # noqa: BLE001
            fail(f"Failed to extract AppCAT archive: {exc}")
    finally:
        try:
            os.remove(tmp_archive)
        except OSError:
            pass

    executable = find_appcat_executable(appcat_home)
    if not executable:
        fail(
            f"AppCAT extraction completed but no launcher found under {appcat_home}."
        )

    try:
        with open(version_marker, "w", encoding="utf-8") as fh:
            fh.write(version)
    except OSError:
        pass  # best-effort cache marker

    log(f"AppCAT {version} ready at {executable}")
    return executable


def run_appcat(executable, args):
    # appcat invocation, mirroring the desktop-CLI's AssessmentRunner:
    #   * stdin  = DEVNULL -> appcat gets an immediately-EOF stdin, so it can never
    #                         block waiting on interactive input.
    #   * stdout/stderr = PIPE (NOT inherited terminal fds) -> we capture appcat's
    #                         output instead of letting it write straight to the
    #                         terminal, so we can prefix each line and keep it in
    #                         non-interactive (non-TTY) mode.
    # appcat-for-java is a self-contained Go binary that streams its progress to
    # stderr line-by-line in real time, so forwarding the pipe gives live progress
    # (no separate heartbeat needed). We stream (rather than buffer) so there is no
    # output limit that could kill appcat mid-run on a chatty project.
    log(f"Running: appcat {' '.join(args)}")

    try:
        child = subprocess.Popen(
            [executable, *args],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
    except Exception as exc:  # noqa: BLE001
        log(f"Failed to launch appcat ({exc}).")
        return 1

    started_at = time.time()

    # Forward appcat output on a DAEMON thread instead of blocking the main thread
    # on the stdout pipe. This is critical: if appcat is a launcher that forks a
    # worker which inherits our stdout pipe, that worker can keep the write end open
    # after appcat itself exits, so the pipe never reaches EOF. A blocking
    # `for line in child.stdout` would then hang forever even though the report is
    # already on disk — exactly the "report.json written but the runner never
    # returns" symptom (which surfaces as a 300s coding-agent timeout). We instead
    # wait on the process itself (child.wait, equivalent to Node's 'exit' event, not
    # 'close') and let the daemon reader die with the interpreter.
    def _forward():
        try:
            for line in child.stdout:
                line = line.rstrip("\r\n")
                if line:
                    log(f"appcat | {line}")
        except Exception:  # noqa: BLE001
            pass

    reader = threading.Thread(target=_forward, daemon=True)
    reader.start()

    code = child.wait()
    # Give the reader a brief grace period to flush buffered tail output, but never
    # block on it — if a forked worker is holding the pipe open, join() would hang.
    reader.join(timeout=5)

    elapsed = round(time.time() - started_at)
    log(f"appcat exited with code {code} after {elapsed}s.")
    return code if code is not None else 1


# ----------------------------------------------------------------------------
# Report id derivation from the report's analysis start time.
# ----------------------------------------------------------------------------

def _utc_now_stamp():
    return datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")


def derive_report_id(report_path):
    # reportId = metadata.analysisStartTime formatted as yyyyMMddHHmmss; UTC now as fallback.
    try:
        with open(report_path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        start = None
        if isinstance(data, dict) and isinstance(data.get("metadata"), dict):
            start = data["metadata"].get("analysisStartTime")
        if isinstance(start, str) and start.strip():
            m = re.search(r"(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})", start)
            if m:
                return "".join(m.groups())
            digits = "".join(re.findall(r"\d+", start))
            if len(digits) >= 14:
                return digits[:14]
    except Exception as exc:  # noqa: BLE001
        log(f"Could not derive reportId from analysisStartTime ({exc}); using current UTC time.")

    return _utc_now_stamp()


# ----------------------------------------------------------------------------
# Helpers.
# ----------------------------------------------------------------------------

def clean_old_reports(reports_dir):
    # Remove existing report-* subdirectories so a fresh run doesn't accumulate
    # multiple report folders (e.g. after a previous failed-and-retried run).
    # Only report-* directories are touched; sibling files such as
    # assessment-config.yaml are left in place. Best-effort — failures are logged
    # but never abort the run.
    if not _is_dir(reports_dir):
        return
    try:
        entries = os.listdir(reports_dir)
    except Exception as exc:  # noqa: BLE001
        log(f"Could not list reports dir '{reports_dir}' ({exc}); skipping cleanup.")
        return
    for name in entries:
        if not name.startswith("report-"):
            continue
        path = os.path.join(reports_dir, name)
        if not _is_dir(path):
            continue
        try:
            shutil.rmtree(path)
        except Exception as exc:  # noqa: BLE001
            log(f"Could not remove stale report dir '{path}' ({exc}); continuing.")


def _is_file(p):
    try:
        return os.path.isfile(p)
    except OSError:
        return False


def _is_dir(p):
    try:
        return os.path.isdir(p)
    except OSError:
        return False


# ----------------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("--workspace-path")
    parser.add_argument("--config")
    parser.add_argument("--reports-dir")
    parser.add_argument("--manifest")
    values = parser.parse_args()

    appcat_home = os.path.join(os.path.expanduser("~"), ".appcat")
    script_dir = os.path.dirname(os.path.abspath(__file__))
    manifest_path = values.manifest or os.path.join(script_dir, "appcat-java-manifest.json")

    workspace = os.path.abspath(values.workspace_path or os.getcwd())
    if not _is_dir(workspace):
        fail(f"Workspace path does not exist: {workspace}")

    config_path = values.config or os.path.join(
        workspace, ".github", "modernize", "assessment", "reports", "assessment-config.yaml"
    )
    reports_dir = values.reports_dir or os.path.join(
        workspace, ".github", "modernize", "assessment", "reports"
    )

    config = load_config(config_path)
    log(
        f"Resolved config: domains={json.dumps(config['assessmentDomains'])} "
        f"runtime={config['targetRuntime']} services={json.dumps(config['targetComputeServices'])} "
        f"os={json.dumps(config['targetOS'])} containerization={config['enableContainerization']}"
    )

    executable = ensure_appcat(appcat_home, manifest_path)
    if os.name != "nt":
        try:
            os.chmod(executable, stat.S_IRWXU | stat.S_IRGRP | stat.S_IXGRP | stat.S_IROTH | stat.S_IXOTH)
        except OSError:
            pass  # best-effort
    log(f"Using AppCAT at {executable}")

    correlation_id = str(uuid.uuid4())
    session_id = str(uuid.uuid4())

    out_dir = tempfile.mkdtemp(prefix="appcat-out-")
    try:
        analyze_args = build_analyze_arguments(
            config, workspace, out_dir, correlation_id, session_id
        )
        exit_code = run_appcat(executable, analyze_args)

        produced_report = os.path.join(out_dir, "report.json")
        if exit_code != 0 and not _is_file(produced_report):
            fail(f"AppCAT analyze failed with exit code {exit_code}.", exit_code or 1)
        if not _is_file(produced_report):
            fail("AppCAT completed but no report.json was produced.")

        inject_metadata(produced_report, config)

        report_id = derive_report_id(produced_report)
        # Remove stale report-* directories from previous (possibly failed and
        # retried) runs so the reports dir ends up with exactly this run's report.
        # Done only now that a valid report.json is in hand — never before, so a run
        # that fails early leaves any previous good report untouched. The sibling
        # assessment-config.yaml and other files are preserved. Cleanup is purely
        # optional housekeeping: any failure here must never block writing the real
        # report, so swallow everything.
        try:
            clean_old_reports(reports_dir)
        except Exception as exc:  # noqa: BLE001
            log(f"Stale-report cleanup failed ({exc}); continuing with new report.")
        versioned_dir = os.path.join(reports_dir, f"report-{report_id}")
        os.makedirs(versioned_dir, exist_ok=True)
        final_report = os.path.join(versioned_dir, "report.json")
        shutil.copyfile(produced_report, final_report)
    finally:
        shutil.rmtree(out_dir, ignore_errors=True)

    log(f"Assessment report written to: {final_report}")
    sys.stdout.write(f"{final_report}\n")


if __name__ == "__main__":
    try:
        main()
    except SystemExit as exc:
        # Flush std streams, then force a deterministic exit. appcat finishes and the
        # report is written, but a lingering daemon reader thread holding a pipe that
        # a forked appcat worker kept open could otherwise keep the interpreter from
        # exiting cleanly. os._exit bypasses that and guarantees the runner returns.
        sys.stdout.flush()
        sys.stderr.flush()
        os._exit(exc.code if isinstance(exc.code, int) else (0 if exc.code is None else 1))
    except Exception as exc:  # noqa: BLE001
        import traceback
        log(f"ERROR: Unexpected error: {traceback.format_exc()}")
        sys.stdout.flush()
        sys.stderr.flush()
        os._exit(1)
    else:
        sys.stdout.flush()
        sys.stderr.flush()
        os._exit(0)


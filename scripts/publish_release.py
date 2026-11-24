"""Publish a complete, CI-verified AI Hub Windows release without replacing one.

Run only in the release workflow with its scoped GH_TOKEN. The read-only CI
gate is also used immediately before publishing, so a cancelled/rerun check
cannot silently inherit an earlier success. All release versions are numeric
x.y.z, which older installed clients can compare correctly.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent.parent
ASSETS = {
    "AI-Hub-windows-x86_64.tar.gz", "AI-Hub-windows-x86_64.zip",
    "install.ps1", "install.sh", "changelog.md", "latest.json", "SHA256SUMS.txt",
}


class GitHub:
    def __init__(self):
        self.token = os.environ["GH_TOKEN"]

    def api(self, path, *, method="GET", data=None, missing=False):
        request = Request(
            f"https://api.github.com/{path}",
            data=None if data is None else json.dumps(data).encode(),
            method=method,
            headers={
                "Authorization": f"Bearer {self.token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                "Content-Type": "application/json",
                "User-Agent": "AI-Hub-release",
            },
        )
        try:
            with urlopen(request, timeout=60) as response:
                return json.load(response)
        except HTTPError as error:
            if missing and error.code == 404:
                return None
            raise RuntimeError(f"GitHub {method} {path}: HTTP {error.code}") from None

    def upload(self, repository, tag, files):
        subprocess.run(
            ["gh", "release", "upload", tag, *map(str, files),
             "--repo", repository, "--clobber"], check=True,
        )


def version_key(version):
    if not re.fullmatch(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)", version):
        raise ValueError("release versions must be numeric x.y.z (for example 0.1.18)")
    return tuple(map(int, version.split(".")))


def current_main(github, repository, sha, ref):
    if ref == "refs/heads/main":
        head = github.api(f"repos/{repository}/git/ref/heads/main")["object"]["sha"]
        if head != sha:
            raise RuntimeError("main moved to a newer commit; its own verified build will publish")


def checked_ci(github, repository, sha):
    runs = github.api(f"repos/{repository}/actions/workflows/ci.yml/runs?head_sha={sha}&per_page=100")["workflow_runs"]
    matches = [run for run in runs if
               run.get("head_sha") == sha and run.get("head_branch") == "main"
               and run.get("event") in ("push", "workflow_dispatch")
               and (run.get("head_repository") or {}).get("full_name") == repository]
    if not matches:
        return None
    # Rerunning an older workflow keeps its id. Do not let a newer id's old
    # success hide a running or more recently failed attempt on this commit.
    if any(run["status"] != "completed" for run in matches):
        return None
    run = max(matches, key=lambda item: (
        item.get("updated_at") or item.get("run_started_at") or item.get("created_at") or "",
        item["id"],
    ))
    if run["conclusion"] != "success":
        raise RuntimeError(f"CI {run['id']} for {sha} finished with {run['conclusion']}; release stopped")
    return run["html_url"]


def wait_for_ci(github, repository, sha, ref):
    deadline = time.monotonic() + 75 * 60
    while time.monotonic() < deadline:
        current_main(github, repository, sha, ref)
        result = checked_ci(github, repository, sha)
        if result:
            print(f"Exact-commit platform CI passed: {result}", flush=True)
            return
        print(f"Waiting for main CI on {sha}", flush=True)
        time.sleep(30)
    raise RuntimeError("timed out waiting for the exact commit's platform CI")


def bundle(root, dist, repository, ref):
    manifest_text = (root / "Cargo.toml").read_text(encoding="utf-8")
    package = re.split(r"^\[package\]\s*$", manifest_text, maxsplit=1, flags=re.M)
    section = re.split(r"^\[", package[1], maxsplit=1, flags=re.M)[0] if len(package) == 2 else ""
    match = re.search(r'^version\s*=\s*"([^"]+)"', section, re.M)
    if not match:
        raise ValueError("Cargo.toml has no package version")
    version = match.group(1)
    version_key(version)
    tag = f"v{version}"
    if ref.startswith("refs/tags/") and ref != f"refs/tags/{tag}":
        raise ValueError("the tag must match the package version")
    files = {path.name: path for path in dist.iterdir()}
    if files.keys() != ASSETS or any(not path.is_file() or path.is_symlink() for path in files.values()):
        raise ValueError("the complete Windows release asset set is required")
    hashes = {name: hashlib.sha256(path.read_bytes()).hexdigest() for name, path in files.items()}
    checksums = {}
    for line in files["SHA256SUMS.txt"].read_text(encoding="utf-8").splitlines():
        digest, name = line.split("  ", 1)
        if name in checksums:
            raise ValueError("duplicate release checksum")
        checksums[name] = digest
    if checksums != {name: digest for name, digest in hashes.items() if name != "SHA256SUMS.txt"}:
        raise ValueError("release checksums do not match the complete asset set")
    manifest = json.loads(files["latest.json"].read_text(encoding="utf-8"))
    expected = {
        "windows-x86_64": {
            "url": f"https://github.com/{repository}/releases/download/{tag}/AI-Hub-windows-x86_64.tar.gz",
            "sha256": hashes["AI-Hub-windows-x86_64.tar.gz"],
        },
    }
    if manifest.get("version") != version or manifest.get("targets") != expected:
        raise ValueError("the update manifest must match this version and its verified Windows archive")
    return version, tag, files, hashes


def tag_commit(github, repository, tag):
    ref = github.api(f"repos/{repository}/git/ref/tags/{tag}", missing=True)
    if ref is None:
        return None
    obj = ref["object"]
    for _ in range(10):
        if obj["type"] == "commit":
            return obj["sha"]
        if obj["type"] != "tag":
            break
        obj = github.api(f"repos/{repository}/git/tags/{obj['sha']}")["object"]
    raise RuntimeError("the release tag does not resolve to a commit")


def release_for_tag(github, repository, tag):
    # GitHub's tag endpoint returns published releases only. Authenticated
    # listings also include drafts, which must be resumed rather than recreated.
    release = github.api(f"repos/{repository}/releases/tags/{tag}", missing=True)
    if release is not None:
        return release
    page = 1
    while True:
        releases = github.api(f"repos/{repository}/releases?per_page=100&page={page}")
        matches = [item for item in releases if item.get("tag_name") == tag]
        if len(matches) > 1:
            raise RuntimeError("multiple releases use this tag; inspect them before publishing")
        if matches:
            return matches[0]
        if len(releases) < 100:
            return None
        page += 1


def require_newer(github, repository, version):
    latest = github.api(f"repos/{repository}/releases/latest", missing=True)
    if latest is not None and version_key(version) <= version_key(latest["tag_name"].removeprefix("v")):
        raise RuntimeError("bump the package version above the published latest release; feed rollback is blocked")


def release_notes(root, version, sha, ci_url):
    changelog = (root / "CHANGELOG.md").read_text(encoding="utf-8")
    match = re.search(rf"^## \[{re.escape(version)}\][^\n]*\n(.*?)(?=^## \[|\Z)", changelog, re.M | re.S)
    if not match:
        raise ValueError("the release needs a CHANGELOG.md entry for its version")
    changes = re.sub(r"<!--.*?-->", "", match.group(1), flags=re.S).strip()
    return (
        "## Windows 설치 및 업데이트\n\n"
        "`AI-Hub-windows-x86_64.zip`을 내려받아 압축을 풀고, "
        "`herdr-app` 폴더의 `Install.cmd`를 실행하세요.\n\n"
        "설치된 AI Hub에서는 **Settings → Updates → Check now**를 누르고, "
        "다운로드가 끝나면 **Restart to update**로 적용할 수 있습니다.\n\n"
        f"{changes}\n\n## 빌드 확인\n\n"
        f"- 코드: `{sha}`\n- [동일 커밋의 플랫폼 검사]({ci_url})\n"
        "- 배포 파일의 SHA-256: `SHA256SUMS.txt`\n"
    )


def publish(github, root, dist, repository, sha, ref):
    version, tag, files, hashes = bundle(root, dist, repository, ref)
    current_main(github, repository, sha, ref)
    ci_url = checked_ci(github, repository, sha)
    if not ci_url:
        raise RuntimeError("the exact commit's platform CI has not passed")
    existing_sha = tag_commit(github, repository, tag)
    if existing_sha is not None and existing_sha != sha:
        raise RuntimeError(f"{tag} already belongs to another commit; bump Cargo.toml, Cargo.lock and CHANGELOG.md")
    release = release_for_tag(github, repository, tag)
    if release is not None and not release["draft"]:
        if existing_sha != sha:
            raise RuntimeError("the published release tag is missing or changed")
        print(f"Already published; preserving its tag, assets and latest status: {release['html_url']}")
        return release["html_url"], False
    require_newer(github, repository, version)
    notes = release_notes(root, version, sha, ci_url)
    if existing_sha is None:
        github.api(f"repos/{repository}/git/refs", method="POST", data={"ref": f"refs/tags/{tag}", "sha": sha})
    if release is None:
        release = github.api(f"repos/{repository}/releases", method="POST", data={
            "tag_name": tag, "target_commitish": sha, "name": f"AI Hub {version}",
            "body": notes, "draft": True, "prerelease": False,
        })
    # Only this same-commit draft may be repaired. Published assets are untouched.
    if any(asset["name"] not in ASSETS for asset in release.get("assets", [])):
        raise RuntimeError("unexpected assets in the draft; inspect it before publishing")
    release_id = release["id"]
    github.upload(repository, tag, [files[name] for name in sorted(files)])
    # Drafts are readable by their authenticated release ID, not by tag.
    release = github.api(f"repos/{repository}/releases/{release_id}")
    if release["id"] != release_id or release["tag_name"] != tag:
        raise RuntimeError("the release identity changed during upload; publication stopped")
    assets = release["assets"]
    if not release["draft"] or len(assets) != len(files) or {asset["name"] for asset in assets} != files.keys():
        raise RuntimeError("the complete asset set must remain in a draft until verified")
    for asset in assets:
        name = asset["name"]
        if asset["state"] != "uploaded" or asset["size"] != files[name].stat().st_size:
            raise RuntimeError(f"incomplete uploaded asset: {name}")
        if asset.get("digest") != f"sha256:{hashes[name]}":
            raise RuntimeError(f"uploaded asset checksum mismatch: {name}")
    # Recheck after uploading as another main push or a CI rerun may have arrived.
    current_main(github, repository, sha, ref)
    if not checked_ci(github, repository, sha):
        raise RuntimeError("CI was restarted; leaving this release as a draft")
    if tag_commit(github, repository, tag) != sha:
        raise RuntimeError("the tag changed during upload; leaving this release as a draft")
    require_newer(github, repository, version)
    published = github.api(f"repos/{repository}/releases/{release['id']}", method="PATCH", data={
        "body": notes, "draft": False, "prerelease": False, "make_latest": "true",
    })
    print(f"Published complete verified release: {published['html_url']}")
    return published["html_url"], True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", default=os.environ.get("GITHUB_REPOSITORY"))
    parser.add_argument("--sha", default=os.environ.get("GITHUB_SHA"))
    parser.add_argument("--ref", default=os.environ.get("GITHUB_REF"))
    parser.add_argument("--dist", type=Path, default=ROOT / "dist")
    parser.add_argument("--wait-for-ci", action="store_true")
    args = parser.parse_args()
    if not args.repository or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", args.repository):
        parser.error("a GitHub owner/repository is required")
    if not args.sha or not re.fullmatch(r"[0-9a-f]{40}", args.sha):
        parser.error("the full tested commit SHA is required")
    if args.ref != "refs/heads/main" and not (args.ref or "").startswith("refs/tags/v"):
        parser.error("only main or a version tag may publish")
    github = GitHub()
    if args.wait_for_ci:
        wait_for_ci(github, args.repository, args.sha, args.ref)
    else:
        url, newly_published = publish(github, ROOT, args.dist, args.repository, args.sha, args.ref)
        if os.environ.get("GITHUB_OUTPUT"):
            with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
                output.write(f"published={str(newly_published).lower()}\n")
        if os.environ.get("GITHUB_STEP_SUMMARY"):
            with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as summary:
                summary.write(f"## AI Hub release\n\n[Download and update]({url})\n")


if __name__ == "__main__":
    main()

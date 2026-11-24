"""Create AI Hub's GitHub release assets from verified, built app archives.

The release feed is <releases/latest/download>/latest.json. It contains
immutable URLs under releases/download/v<VERSION>, never upstream app URLs.
This script does not upload anything or build the app.
"""

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import tarfile
import zipfile


ROOT = Path(__file__).resolve().parent.parent
NOTICES = ("LICENSE", "NOTICE", "THIRD-PARTY-NOTICES")


def prepare(root, dist, repository, tag=None):
    root, dist = Path(root), Path(dist)
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise ValueError("repository must be a GitHub owner/name")
    match = re.search(r'^version\s*=\s*"([^"]+)"', (root / "Cargo.toml").read_text(), re.M)
    if not match:
        raise ValueError("Cargo.toml has no package version")
    version = match.group(1)
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?", version):
        raise ValueError("the package version must be a semantic version")
    expected_tag = f"v{version}"
    if tag and tag != expected_tag:
        raise ValueError(f"tag {tag} does not match Cargo.toml ({expected_tag})")
    base = f"https://github.com/{repository}/releases/download/{expected_tag}"
    archives = sorted(dist.glob("AI-Hub-*.tar.gz"))
    if not archives:
        raise ValueError("no built AI-Hub-*.tar.gz archives found")
    targets = {}
    for path in archives:
        target = path.name.removeprefix("AI-Hub-").removesuffix(".tar.gz")
        if target not in ("windows-x86_64", "linux-x86_64", "linux-aarch64", "macos-aarch64"):
            raise ValueError(f"unsupported release target: {target}")
        prefix = "Herdr.app/Contents/Resources" if target.startswith("macos-") else "herdr-app"
        with tarfile.open(path, "r:gz") as archive:
            for name in NOTICES:
                member = archive.extractfile(f"{prefix}/{name}")
                if member is None or member.read() != (root / name).read_bytes():
                    raise ValueError(f"{path.name}: {name} does not match the source notice")
            if target.startswith("windows-"):
                for name in ("herdr-app.exe", "herdr-app.svg", "Install.ps1", "Install.cmd"):
                    if not archive.getmember(f"herdr-app/{name}").isfile():
                        raise ValueError(f"{path.name}: missing Windows payload {name}")
                # The ZIP is the same payload as the updater's tarball.
                zip_path = dist / f"AI-Hub-{target}.zip"
                with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as packed:
                    for member in archive.getmembers():
                        parts = PurePosixPath(member.name).parts
                        if not parts or parts[0] != "herdr-app" or ".." in parts:
                            raise ValueError(f"unexpected payload path: {member.name}")
                        if member.isdir():
                            continue
                        if not member.isfile():
                            raise ValueError(f"unsupported Windows archive entry: {member.name}")
                        packed.writestr(member.name, archive.extractfile(member).read())
        targets[target] = {"url": f"{base}/{path.name}", "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}

    for name in ("install.ps1", "install.sh"):
        shutil.copy2(root / "distribution" / name, dist / name)
    shutil.copy2(root / "CHANGELOG.md", dist / "changelog.md")
    manifest = {
        "version": version,
        "core_min": (root / "distribution/core-version").read_text().strip(),
        "notes": f"AI Hub {version}",
        "targets": targets,
    }
    (dist / "latest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    files = [p for p in sorted(dist.iterdir()) if p.is_file() and p.name != "SHA256SUMS.txt"]
    (dist / "SHA256SUMS.txt").write_text(
        "".join(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n" for path in files),
        encoding="utf-8",
    )
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dist", type=Path, default=ROOT / "dist")
    parser.add_argument("--repository", default="q1926313-art/AI-HUB")
    parser.add_argument("--tag")
    args = parser.parse_args()
    manifest = prepare(ROOT, args.dist, args.repository, args.tag)
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()

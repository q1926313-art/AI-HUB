"""Release-contract checks using tiny fixture archives, without builds/network."""

import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
import zipfile

from prepare_release import NOTICES, prepare


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        work = tempfile.TemporaryDirectory(prefix="ai-hub-release-")
        self.addCleanup(work.cleanup)
        self.root = Path(work.name)
        self.dist = self.root / "dist"
        self.dist.mkdir()
        (self.root / "distribution").mkdir()
        (self.root / "Cargo.toml").write_text('[package]\nversion = "0.1.17-aihub.1"\n')
        (self.root / "distribution/core-version").write_text("0.1.13\n")
        (self.root / "CHANGELOG.md").write_text("# AI Hub release notes\n")
        for name in NOTICES:
            (self.root / name).write_text(f"{name}: keep attribution\n")
        for name in ("install.ps1", "install.sh"):
            (self.root / "distribution" / name).write_text(f"installer: {name}\n")
        self.archive = self.dist / "AI-Hub-windows-x86_64.tar.gz"

    def make_archive(self, changed_notice=False):
        with tarfile.open(self.archive, "w:gz") as archive:
            for name in (*NOTICES, "herdr-app.exe", "herdr-app.svg", "Install.ps1", "Install.cmd"):
                data = (self.root / name).read_bytes() if name in NOTICES else f"payload {name}".encode()
                if changed_notice and name == "NOTICE":
                    data = b"incorrect attribution"
                member = tarfile.TarInfo(f"herdr-app/{name}")
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))

    def test_assets_use_versioned_fork_urls_and_matching_hashes(self):
        self.make_archive()
        manifest = prepare(self.root, self.dist, "q1926313-art/AI-HUB", "v0.1.17-aihub.1")
        entry = manifest["targets"]["windows-x86_64"]
        self.assertEqual(entry["url"], "https://github.com/q1926313-art/AI-HUB/releases/download/v0.1.17-aihub.1/AI-Hub-windows-x86_64.tar.gz")
        self.assertEqual(entry["sha256"], hashlib.sha256(self.archive.read_bytes()).hexdigest())
        self.assertEqual(json.loads((self.dist / "latest.json").read_text()), manifest)
        self.assertEqual((self.dist / "changelog.md").read_bytes(), (self.root / "CHANGELOG.md").read_bytes())
        with zipfile.ZipFile(self.dist / "AI-Hub-windows-x86_64.zip") as packed:
            self.assertEqual(packed.read("herdr-app/NOTICE"), (self.root / "NOTICE").read_bytes())
            self.assertEqual(packed.read("herdr-app/Install.cmd"), b"payload Install.cmd")
        for line in (self.dist / "SHA256SUMS.txt").read_text().splitlines():
            digest, name = line.split("  ", 1)
            self.assertEqual(digest, hashlib.sha256((self.dist / name).read_bytes()).hexdigest())

    def test_tag_mismatch_is_rejected_before_publishing_metadata(self):
        self.make_archive()
        with self.assertRaisesRegex(ValueError, "does not match"):
            prepare(self.root, self.dist, "q1926313-art/AI-HUB", "v9.9.9")
        self.assertFalse((self.dist / "latest.json").exists())

    def test_changed_attribution_is_rejected(self):
        self.make_archive(changed_notice=True)
        with self.assertRaisesRegex(ValueError, "NOTICE does not match"):
            prepare(self.root, self.dist, "q1926313-art/AI-HUB")
        self.assertFalse((self.dist / "latest.json").exists())

    def test_absent_binary_archives_cannot_make_an_empty_release(self):
        with self.assertRaisesRegex(ValueError, "no built"):
            prepare(self.root, self.dist, "q1926313-art/AI-HUB")


if __name__ == "__main__":
    unittest.main()

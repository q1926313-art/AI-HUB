"""AI Hub publication behaviors using real tiny bundles and an isolated GitHub fake."""

import copy
from contextlib import redirect_stdout
import hashlib
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit

from prepare_release import NOTICES, prepare
from publish_release import ASSETS, GitHub, publish, wait_for_ci


REPOSITORY = "q1926313-art/AI-HUB"
SHA = "a" * 40
OTHER_SHA = "b" * 40
VERSION = "0.1.18"
TAG = f"v{VERSION}"


def ci_run(run_id=100, **changes):
    run = {
        "id": run_id, "head_sha": SHA, "head_branch": "main", "event": "push",
        "head_repository": {"full_name": REPOSITORY},
        "status": "completed", "conclusion": "success", "run_attempt": 1,
        "updated_at": "2026-11-24T10:00:00Z",
        "run_started_at": "2026-11-24T09:59:00Z",
        "html_url": f"https://github.com/{REPOSITORY}/actions/runs/{run_id}",
    }
    return {**run, **changes}


class FakeGitHub:
    """Model reads, draft uploads and the public transition without network access."""

    def __init__(self, runs=None):
        self.runs = [ci_run()] if runs is None else runs
        self.main = SHA
        self.tags = {}
        self.tag_objects = {}
        self.releases = {}
        self.latest = None
        self.reads = []
        self.writes = []
        self.uploads = []
        self.upload_fault = None
        self.after_upload = None

    def seed_release(self, *, draft, assets=None):
        self.releases[TAG] = {
            "id": 42, "tag_name": TAG, "draft": draft, "prerelease": False,
            "html_url": f"https://github.com/{REPOSITORY}/releases/tag/{TAG}",
            "assets": copy.deepcopy(assets or []),
        }

    def api(self, path, *, method="GET", data=None, missing=False):
        prefix = f"repos/{REPOSITORY}/"
        if not path.startswith(prefix):
            raise AssertionError(f"unexpected repository: {path}")
        route = path.removeprefix(prefix)
        if method != "GET":
            self.writes.append((method, route, copy.deepcopy(data)))
        if method == "GET":
            self.reads.append(route)
            if route.startswith("actions/workflows/ci.yml/runs?"):
                value = {"workflow_runs": self.runs}
            elif route == "git/ref/heads/main":
                value = {"object": {"type": "commit", "sha": self.main}}
            elif route.startswith("git/ref/tags/"):
                obj = self.tags.get(route.removeprefix("git/ref/tags/"))
                value = None if obj is None else {"object": obj}
            elif route.startswith("git/tags/"):
                value = {"object": self.tag_objects[route.removeprefix("git/tags/")]}
            elif route == "releases/latest":
                value = None if self.latest is None else {"tag_name": self.latest}
            elif route.startswith("releases/tags/"):
                value = self.releases.get(route.removeprefix("releases/tags/"))
                # The real tag endpoint exposes only published releases.
                if value is not None and value["draft"]:
                    value = None
            elif route.startswith("releases?"):
                query = parse_qs(urlsplit(route).query)
                size = min(int(query.get("per_page", [30])[0]), 100)
                page = int(query.get("page", [1])[0])
                releases = sorted(self.releases.values(), key=lambda item: item["id"], reverse=True)
                value = releases[(page - 1) * size:page * size]
            elif route.startswith("releases/"):
                release_id = int(route.removeprefix("releases/"))
                value = next((item for item in self.releases.values() if item["id"] == release_id), None)
            else:
                raise AssertionError(f"unexpected GET: {route}")
            if value is None and not missing:
                raise RuntimeError(f"missing fixture resource: {route}")
            return copy.deepcopy(value)
        if method == "POST" and route == "git/refs":
            tag = data["ref"].removeprefix("refs/tags/")
            if tag in self.tags:
                raise RuntimeError("tag already exists")
            self.tags[tag] = {"type": "commit", "sha": data["sha"]}
            return {"object": copy.deepcopy(self.tags[tag])}
        if method == "POST" and route == "releases":
            if data["tag_name"] in self.releases:
                raise RuntimeError("a release for this tag already exists")
            self.seed_release(draft=data["draft"])
            self.releases[TAG].update(data)
            return copy.deepcopy(self.releases[TAG])
        if method == "PATCH" and route == "releases/42":
            self.releases[TAG].update(data)
            if data.get("make_latest") == "true":
                self.latest = TAG
            return copy.deepcopy(self.releases[TAG])
        raise AssertionError(f"unexpected mutation: {method} {route}")

    def upload(self, repository, tag, files):
        if repository != REPOSITORY or not self.releases[tag]["draft"]:
            raise AssertionError("uploads must target this repository's draft")
        self.uploads.append([path.name for path in files])
        assets = [
            {"name": path.name, "state": "uploaded", "size": path.stat().st_size,
             "digest": f"sha256:{hashlib.sha256(path.read_bytes()).hexdigest()}"}
            for path in files
        ]
        if self.upload_fault == "partial":
            assets.pop()
        elif self.upload_fault == "hash":
            assets[0]["digest"] = "sha256:" + "0" * 64
        elif self.upload_fault == "missing-hash":
            assets[0].pop("digest")
        elif self.upload_fault == "size":
            assets[0]["size"] += 1
        self.releases[tag]["assets"] = assets
        if self.after_upload:
            self.after_upload(self)
        if self.upload_fault == "interrupted":
            raise RuntimeError("upload interrupted")

    @property
    def publications(self):
        return [write for write in self.writes if write[0] == "PATCH" and write[2].get("draft") is False]


class PublisherTests(unittest.TestCase):
    def setUp(self):
        work = tempfile.TemporaryDirectory(prefix="ai-hub-publisher-")
        self.addCleanup(work.cleanup)
        self.root = Path(work.name)
        self.dist = self.root / "dist"
        self.dist.mkdir()
        (self.root / "distribution").mkdir()
        (self.root / "Cargo.toml").write_text(f'[package]\nname = "herdr-app"\nversion = "{VERSION}"\n')
        (self.root / "CHANGELOG.md").write_text(f"# AI Hub\n\n## [{VERSION}] - 2026-11-24\n\n### Fixed\n- Fixture release.\n")
        (self.root / "distribution/core-version").write_text("0.1.13\n")
        for name in NOTICES:
            (self.root / name).write_text(f"{name}: preserved attribution\n")
        for name in ("install.ps1", "install.sh"):
            (self.root / "distribution" / name).write_text(f"fixture installer: {name}\n")
        with tarfile.open(self.dist / "AI-Hub-windows-x86_64.tar.gz", "w:gz") as archive:
            for name in (*NOTICES, "herdr-app.exe", "herdr-app.svg", "Install.ps1", "Install.cmd"):
                data = (self.root / name).read_bytes() if name in NOTICES else f"fixture {name}".encode()
                member = tarfile.TarInfo(f"herdr-app/{name}")
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
        prepare(self.root, self.dist, REPOSITORY, TAG)

    def run_publish(self, github, ref="refs/heads/main"):
        with redirect_stdout(io.StringIO()):
            return publish(github, self.root, self.dist, REPOSITORY, SHA, ref)

    def assert_blocked(self, github, *, untouched=False):
        with self.assertRaises((RuntimeError, ValueError)):
            self.run_publish(github)
        self.assertEqual(github.publications, [])
        if untouched:
            self.assertEqual(github.writes, [])
            self.assertEqual(github.uploads, [])

    def rehash(self):
        paths = sorted(path for path in self.dist.iterdir() if path.name != "SHA256SUMS.txt")
        (self.dist / "SHA256SUMS.txt").write_text("".join(
            f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n" for path in paths
        ))

    def test_complete_bundle_publishes_stable_release_at_the_verified_commit(self):
        github = FakeGitHub()
        url, newly_published = self.run_publish(github)
        self.assertEqual(github.tags[TAG], {"type": "commit", "sha": SHA})
        self.assertEqual(github.latest, TAG)
        self.assertEqual(len(github.publications), 1)
        release = github.releases[TAG]
        self.assertFalse(release["draft"])
        self.assertFalse(release["prerelease"])
        self.assertEqual({asset["name"] for asset in release["assets"]}, ASSETS)
        self.assertIn(SHA, release["body"])
        self.assertIn(ci_run()["html_url"], release["body"])
        self.assertEqual(url, release["html_url"])
        self.assertTrue(newly_published)

    def test_ci_from_a_pr_fork_other_branch_or_other_commit_cannot_authorize_publication(self):
        invalid = [
            {"event": "pull_request"}, {"head_repository": {"full_name": "someone/fork"}},
            {"head_sha": OTHER_SHA}, {"head_branch": "feature"},
        ]
        for changes in invalid:
            with self.subTest(changes=changes):
                self.assert_blocked(FakeGitHub([ci_run(**changes)]), untouched=True)
        self.assert_blocked(FakeGitHub([]), untouched=True)

    def test_unrelated_newer_runs_do_not_hide_a_valid_manual_main_ci(self):
        github = FakeGitHub([ci_run(event="workflow_dispatch"), ci_run(200, event="pull_request", conclusion="failure")])
        self.run_publish(github)
        self.assertEqual(len(github.publications), 1)

    def test_failed_cancelled_or_timed_out_latest_ci_blocks_earlier_success(self):
        for conclusion in ("failure", "cancelled", "timed_out"):
            with self.subTest(conclusion=conclusion):
                self.assert_blocked(FakeGitHub([ci_run(), ci_run(200, conclusion=conclusion)]), untouched=True)

    def test_new_attempt_of_an_older_run_blocks_stale_success(self):
        for status, conclusion in (("in_progress", None), ("completed", "failure")):
            with self.subTest(status=status):
                rerun = ci_run(100, run_attempt=2, status=status, conclusion=conclusion,
                               updated_at="2026-11-24T12:00:00Z", run_started_at="2026-11-24T11:59:00Z")
                self.assert_blocked(FakeGitHub([rerun, ci_run(200)]), untouched=True)

    def test_cancelled_ci_ends_wait_without_sleeping(self):
        github = FakeGitHub([ci_run(conclusion="cancelled")])
        with patch("publish_release.time.sleep", side_effect=AssertionError("must not wait for cancelled CI")):
            with self.assertRaises(RuntimeError):
                wait_for_ci(github, REPOSITORY, SHA, "refs/heads/main")
        self.assertEqual(github.writes, [])

    def test_same_published_commit_is_a_noop_even_after_a_newer_release(self):
        github = FakeGitHub()
        github.tags[TAG] = {"type": "commit", "sha": SHA}
        github.seed_release(draft=False, assets=[{"name": "preserve-published-assets"}])
        github.latest = "v0.1.19"
        github.main = OTHER_SHA
        before = copy.deepcopy(github.releases)
        result = self.run_publish(github, f"refs/tags/{TAG}")
        self.assertEqual(result, (github.releases[TAG]["html_url"], False))
        self.assertEqual(github.writes, [])
        self.assertEqual(github.uploads, [])
        self.assertEqual(github.releases, before)
        self.assertEqual(github.latest, "v0.1.19")
        self.assertFalse(any(route.startswith("releases?") for route in github.reads))

    def test_existing_version_cannot_be_reassigned_to_another_commit(self):
        github = FakeGitHub()
        github.tags[TAG] = {"type": "commit", "sha": OTHER_SHA}
        github.seed_release(draft=False)
        self.assert_blocked(github, untouched=True)
        self.assertEqual(github.tags[TAG]["sha"], OTHER_SHA)

    def test_nested_annotated_tag_is_peeled_and_preserved(self):
        github = FakeGitHub()
        first, second = "c" * 40, "d" * 40
        github.tags[TAG] = {"type": "tag", "sha": first}
        github.tag_objects[first] = {"type": "tag", "sha": second}
        github.tag_objects[second] = {"type": "commit", "sha": SHA}
        self.run_publish(github, f"refs/tags/{TAG}")
        self.assertEqual(github.tags[TAG], {"type": "tag", "sha": first})
        self.assertEqual(len(github.publications), 1)

    def test_same_commit_partial_draft_can_resume_without_recreating_the_release(self):
        github = FakeGitHub()
        github.tags[TAG] = {"type": "commit", "sha": SHA}
        github.seed_release(draft=True, assets=[{"name": "latest.json"}])
        self.run_publish(github)
        self.assertEqual(github.releases[TAG]["id"], 42)
        self.assertFalse(any(method == "POST" for method, _, _ in github.writes))
        self.assertEqual(len(github.publications), 1)

    def test_draft_resume_finds_the_exact_tag_beyond_the_first_listing_page(self):
        github = FakeGitHub()
        github.tags[TAG] = {"type": "commit", "sha": SHA}
        # These authenticated drafts fill the first page, including a tag that
        # starts with the desired version but belongs to a different release.
        for number in range(100):
            tag = f"{TAG}{number}"
            github.releases[tag] = {
                "id": 1000 + number, "tag_name": tag, "draft": True,
                "assets": [{"name": "reserved-draft-asset"}],
            }
        unrelated = copy.deepcopy(github.releases)
        github.seed_release(draft=True, assets=[{"name": "latest.json"}])
        self.run_publish(github)
        self.assertEqual(github.releases[TAG]["id"], 42)
        self.assertEqual(len(github.publications), 1)
        self.assertFalse(any(method == "POST" for method, _, _ in github.writes))
        self.assertEqual({tag: value for tag, value in github.releases.items() if tag != TAG}, unrelated)

    def test_partial_interrupted_or_unverified_uploads_remain_drafts(self):
        for fault in ("partial", "interrupted", "hash", "missing-hash", "size"):
            with self.subTest(fault=fault):
                github = FakeGitHub()
                github.upload_fault = fault
                self.assert_blocked(github)
                self.assertTrue(github.releases[TAG]["draft"])
                self.assertIsNone(github.latest)

    def test_main_moving_after_upload_prevents_publication(self):
        github = FakeGitHub()
        github.after_upload = lambda client: setattr(client, "main", OTHER_SHA)
        self.assert_blocked(github)
        self.assertTrue(github.releases[TAG]["draft"])

    def test_ci_restart_or_failure_after_upload_prevents_publication(self):
        for status, conclusion in (("in_progress", None), ("completed", "failure")):
            with self.subTest(status=status):
                github = FakeGitHub()
                github.after_upload = lambda client: setattr(client, "runs", [ci_run(status=status, conclusion=conclusion)])
                self.assert_blocked(github)
                self.assertTrue(github.releases[TAG]["draft"])

    def test_tag_moving_after_upload_prevents_publication(self):
        github = FakeGitHub()
        github.after_upload = lambda client: client.tags.update({TAG: {"type": "commit", "sha": OTHER_SHA}})
        self.assert_blocked(github)

    def test_numeric_versions_advance_numerically_and_cannot_roll_back(self):
        github = FakeGitHub()
        github.latest = "v0.1.9"
        self.run_publish(github)
        self.assertEqual(github.latest, TAG)
        for latest in (TAG, "v0.1.19", "v0.2.0"):
            with self.subTest(latest=latest):
                github = FakeGitHub()
                github.latest = latest
                self.assert_blocked(github, untouched=True)

    def test_newer_release_arriving_during_upload_blocks_feed_rollback(self):
        github = FakeGitHub()
        github.after_upload = lambda client: setattr(client, "latest", "v0.1.19")
        self.assert_blocked(github)
        self.assertEqual(github.latest, "v0.1.19")

    def test_missing_assets_extra_assets_and_checksum_corruption_block_all_writes(self):
        archive = self.dist / "AI-Hub-windows-x86_64.zip"
        original = archive.read_bytes()
        archive.unlink()
        self.assert_blocked(FakeGitHub(), untouched=True)
        archive.write_bytes(original)
        extra = self.dist / "unexpected.txt"
        extra.write_text("unexpected payload")
        self.assert_blocked(FakeGitHub(), untouched=True)
        extra.unlink()
        archive.write_bytes(original + b"changed")
        self.assert_blocked(FakeGitHub(), untouched=True)

    def test_manifest_cannot_redirect_updates_or_misstate_archive_identity(self):
        path = self.dist / "latest.json"
        original = json.loads(path.read_text())
        for change in ("url", "hash", "version"):
            with self.subTest(change=change):
                manifest = copy.deepcopy(original)
                target = manifest["targets"]["windows-x86_64"]
                if change == "url":
                    target["url"] = "https://example.invalid/unverified-app.tar.gz"
                elif change == "hash":
                    target["sha256"] = "0" * 64
                else:
                    manifest["version"] = "0.1.19"
                path.write_text(json.dumps(manifest))
                self.rehash()
                self.assert_blocked(FakeGitHub(), untouched=True)


class GitHubHttpTests(unittest.TestCase):
    def test_only_an_explicitly_optional_404_is_treated_as_absent(self):
        with patch.dict(os.environ, {"GH_TOKEN": "fixture-token"}):
            github = GitHub()
        for status, missing in ((404, True), (404, False), (403, True), (429, True), (503, True)):
            with self.subTest(status=status, missing=missing):
                error = HTTPError("https://api.github.com/fixture", status, "fixture error", {}, None)
                with patch("publish_release.urlopen", side_effect=error):
                    if status == 404 and missing:
                        self.assertIsNone(github.api("repos/fixture/releases/latest", missing=missing))
                    else:
                        with self.assertRaisesRegex(RuntimeError, str(status)):
                            github.api("repos/fixture/releases/latest", missing=missing)


if __name__ == "__main__":
    unittest.main()

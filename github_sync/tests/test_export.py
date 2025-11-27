"""
Tests for export/import functionality.
"""

import gzip
import json
from datetime import UTC, datetime
from pathlib import Path

import pytest

from github_sync import (
    ArtifactFormat,
    PRContext,
    SyncStore,
    export_database,
    import_database,
)
from github_sync.export import (
    ARTIFACT_SCHEMA_VERSION,
    export_pr_context,
    list_artifact_contents,
)


class TestArtifactFormat:
    """Tests for artifact format enum."""

    def test_format_values(self):
        """Test all format enum values."""
        assert ArtifactFormat.JSON.value == "json"
        assert ArtifactFormat.JSON_GZ.value == "json.gz"
        assert ArtifactFormat.JSONL.value == "jsonl"
        assert ArtifactFormat.JSONL_GZ.value == "jsonl.gz"


class TestExportDatabase:
    """Tests for database export."""

    @pytest.mark.asyncio
    async def test_export_json(self, sync_store: SyncStore, temp_dir: Path):
        """Test exporting to JSON format."""
        # Add test data
        await sync_store.save_repository("test-repo", "/path", "main")
        await sync_store.save_pr_snapshot(
            "test-repo",
            {
                "number": 1,
                "title": "Test PR",
                "state": "open",
                "head_branch": "feature",
                "base_branch": "main",
            },
        )

        output_path = temp_dir / "export.json"
        result = await export_database(
            sync_store,
            output_path,
            format=ArtifactFormat.JSON,
        )

        assert result["path"] == str(output_path)
        assert result["format"] == "json"
        assert result["repositories"] == 1
        assert result["pull_requests"] == 1
        assert output_path.exists()

        # Verify contents
        with open(output_path) as f:
            data = json.load(f)

        assert data["schema_version"] == ARTIFACT_SCHEMA_VERSION
        assert len(data["data"]["repositories"]) == 1

    @pytest.mark.asyncio
    async def test_export_json_gz(self, sync_store: SyncStore, temp_dir: Path):
        """Test exporting to compressed JSON format."""
        await sync_store.save_repository("repo", "/path", "main")

        output_path = temp_dir / "export.json.gz"
        result = await export_database(
            sync_store,
            output_path,
            format=ArtifactFormat.JSON_GZ,
        )

        assert result["format"] == "json.gz"
        assert output_path.exists()

        # Verify compressed contents
        with gzip.open(output_path, "rt") as f:
            data = json.load(f)

        assert data["schema_version"] == ARTIFACT_SCHEMA_VERSION

    @pytest.mark.asyncio
    async def test_export_jsonl(self, sync_store: SyncStore, temp_dir: Path):
        """Test exporting to JSONL format."""
        await sync_store.save_repository("repo1", "/path1", "main")
        await sync_store.save_repository("repo2", "/path2", "main")

        output_path = temp_dir / "export.jsonl"
        result = await export_database(
            sync_store,
            output_path,
            format=ArtifactFormat.JSONL,
        )

        assert result["format"] == "jsonl"

        # Verify JSONL format
        with open(output_path) as f:
            lines = f.readlines()

        # First line is metadata
        metadata = json.loads(lines[0])
        assert metadata["type"] == "metadata"

        # Subsequent lines are data
        data_lines = [json.loads(line) for line in lines[1:]]
        repo_lines = [d for d in data_lines if d["type"] == "repository"]
        assert len(repo_lines) == 2

    @pytest.mark.asyncio
    async def test_export_jsonl_gz(self, sync_store: SyncStore, temp_dir: Path):
        """Test exporting to compressed JSONL format."""
        await sync_store.save_repository("repo", "/path", "main")

        output_path = temp_dir / "export.jsonl.gz"
        result = await export_database(
            sync_store,
            output_path,
            format=ArtifactFormat.JSONL_GZ,
        )

        assert result["format"] == "jsonl.gz"

        # Verify compressed JSONL
        with gzip.open(output_path, "rt") as f:
            first_line = f.readline()
            metadata = json.loads(first_line)

        assert metadata["type"] == "metadata"

    @pytest.mark.asyncio
    async def test_export_with_repo_filter(self, sync_store: SyncStore, temp_dir: Path):
        """Test exporting with repository filter."""
        await sync_store.save_repository("repo1", "/path1", "main")
        await sync_store.save_repository("repo2", "/path2", "main")
        await sync_store.save_pr_snapshot(
            "repo1",
            {
                "number": 1,
                "title": "PR 1",
                "state": "open",
                "head_branch": "f1",
                "base_branch": "main",
            },
        )
        await sync_store.save_pr_snapshot(
            "repo2",
            {
                "number": 2,
                "title": "PR 2",
                "state": "open",
                "head_branch": "f2",
                "base_branch": "main",
            },
        )

        output_path = temp_dir / "filtered.json"
        result = await export_database(
            sync_store,
            output_path,
            format=ArtifactFormat.JSON,
            repo_filter="repo1",
        )

        assert result["repositories"] == 1
        assert result["pull_requests"] == 1

    @pytest.mark.asyncio
    async def test_export_with_contexts(self, sync_store: SyncStore, temp_dir: Path):
        """Test exporting includes PR contexts."""
        await sync_store.save_repository("repo", "/path", "main")

        context = PRContext(
            repo_name="repo",
            pr_number=1,
            pr_url="https://github.com/test/repo/pull/1",
            diff="+ line",
            body="body",
            captured_at=datetime.now(UTC),
        )
        await sync_store.save_pr_context(context)

        output_path = temp_dir / "with-contexts.json"
        result = await export_database(
            sync_store,
            output_path,
            format=ArtifactFormat.JSON,
            include_contexts=True,
        )

        assert result["pr_contexts"] == 1

        with open(output_path) as f:
            data = json.load(f)

        assert len(data["data"]["pr_contexts"]) == 1

    @pytest.mark.asyncio
    async def test_export_without_contexts(self, sync_store: SyncStore, temp_dir: Path):
        """Test exporting without PR contexts."""
        await sync_store.save_repository("repo", "/path", "main")

        context = PRContext(
            repo_name="repo",
            pr_number=1,
            pr_url="url",
            diff="diff",
            body="body",
        )
        await sync_store.save_pr_context(context)

        output_path = temp_dir / "no-contexts.json"
        result = await export_database(
            sync_store,
            output_path,
            format=ArtifactFormat.JSON,
            include_contexts=False,
        )

        assert result["pr_contexts"] == 0

    @pytest.mark.asyncio
    async def test_export_pretty_json(self, sync_store: SyncStore, temp_dir: Path):
        """Test exporting with pretty formatting."""
        await sync_store.save_repository("repo", "/path", "main")

        # Export with pretty=True
        pretty_path = temp_dir / "pretty.json"
        await export_database(sync_store, pretty_path, pretty=True)

        # Export with pretty=False
        compact_path = temp_dir / "compact.json"
        await export_database(sync_store, compact_path, pretty=False)

        # Pretty should be larger (has whitespace)
        assert pretty_path.stat().st_size > compact_path.stat().st_size


class TestImportDatabase:
    """Tests for database import."""

    @pytest.mark.asyncio
    async def test_import_json(self, sync_store: SyncStore, temp_dir: Path):
        """Test importing from JSON format."""
        # Create export file
        export_data = {
            "schema_version": ARTIFACT_SCHEMA_VERSION,
            "exported_at": datetime.now(UTC).isoformat(),
            "data": {
                "repositories": [
                    {"name": "imported-repo", "path": "/imported", "default_branch": "main"}
                ],
                "pull_requests": [],
                "pr_contexts": [],
            },
        }

        import_path = temp_dir / "import.json"
        with open(import_path, "w") as f:
            json.dump(export_data, f)

        # Create new store for import
        new_store = SyncStore(temp_dir / "imported.db")

        result = await import_database(new_store, import_path)

        assert result["repositories_imported"] == 1
        assert result["errors"] == 0

        # Verify imported data
        repos = await new_store.get_all_repositories()
        assert len(repos) == 1
        assert repos[0]["name"] == "imported-repo"

    @pytest.mark.asyncio
    async def test_import_json_gz(self, sync_store: SyncStore, temp_dir: Path):
        """Test importing from compressed JSON."""
        export_data = {
            "schema_version": ARTIFACT_SCHEMA_VERSION,
            "data": {
                "repositories": [{"name": "repo", "path": "/path"}],
                "pull_requests": [],
                "pr_contexts": [],
            },
        }

        import_path = temp_dir / "import.json.gz"
        with gzip.open(import_path, "wt") as f:
            json.dump(export_data, f)

        new_store = SyncStore(temp_dir / "imported.db")
        result = await import_database(new_store, import_path)

        assert result["repositories_imported"] == 1

    @pytest.mark.asyncio
    async def test_import_with_prs(self, sync_store: SyncStore, temp_dir: Path):
        """Test importing PRs."""
        export_data = {
            "schema_version": ARTIFACT_SCHEMA_VERSION,
            "data": {
                "repositories": [],
                "pull_requests": [
                    {
                        "repo_name": "repo",
                        "number": 1,
                        "title": "Test PR",
                        "state": "open",
                        "head_branch": "feature",
                        "base_branch": "main",
                        "labels": ["bug"],
                    }
                ],
                "pr_contexts": [],
            },
        }

        import_path = temp_dir / "import.json"
        with open(import_path, "w") as f:
            json.dump(export_data, f)

        new_store = SyncStore(temp_dir / "imported.db")
        result = await import_database(new_store, import_path)

        assert result["pull_requests_imported"] == 1

    @pytest.mark.asyncio
    async def test_import_with_contexts(self, sync_store: SyncStore, temp_dir: Path):
        """Test importing PR contexts."""
        export_data = {
            "schema_version": ARTIFACT_SCHEMA_VERSION,
            "data": {
                "repositories": [],
                "pull_requests": [],
                "pr_contexts": [
                    {
                        "repo_name": "repo",
                        "pr_number": 1,
                        "pr_url": "url",
                        "diff": "+ added",
                        "body": "body",
                        "comments": [],
                        "review_comments": [],
                        "commits": [],
                        "files": [],
                        "conflicts": {},
                        "ci_checks": {},
                        "guidelines": "",
                        "commit_examples": "",
                    }
                ],
            },
        }

        import_path = temp_dir / "import.json"
        with open(import_path, "w") as f:
            json.dump(export_data, f)

        new_store = SyncStore(temp_dir / "imported.db")
        result = await import_database(new_store, import_path)

        assert result["pr_contexts_imported"] == 1

    @pytest.mark.asyncio
    async def test_import_incompatible_version(self, temp_dir: Path):
        """Test importing incompatible schema version."""
        export_data = {
            "schema_version": "999.0",  # Future version
            "data": {"repositories": [], "pull_requests": [], "pr_contexts": []},
        }

        import_path = temp_dir / "incompatible.json"
        with open(import_path, "w") as f:
            json.dump(export_data, f)

        new_store = SyncStore(temp_dir / "imported.db")

        with pytest.raises(ValueError) as exc_info:
            await import_database(new_store, import_path)

        assert "Incompatible" in str(exc_info.value)

    @pytest.mark.asyncio
    async def test_import_jsonl(self, temp_dir: Path):
        """Test importing from JSONL format."""
        import_path = temp_dir / "import.jsonl"
        with open(import_path, "w") as f:
            f.write(
                json.dumps({"type": "metadata", "schema_version": ARTIFACT_SCHEMA_VERSION}) + "\n"
            )
            f.write(
                json.dumps({"type": "repository", "data": {"name": "repo", "path": "/p"}}) + "\n"
            )

        new_store = SyncStore(temp_dir / "imported.db")
        result = await import_database(new_store, import_path)

        assert result["repositories_imported"] == 1


class TestExportPRContext:
    """Tests for single PR context export."""

    @pytest.mark.asyncio
    async def test_export_single_context(self, sync_store: SyncStore, temp_dir: Path):
        """Test exporting a single PR context."""
        context = PRContext(
            repo_name="test-repo",
            pr_number=42,
            pr_url="https://github.com/test/repo/pull/42",
            diff="+ new line\n- old line",
            body="PR description",
            comments=[{"author": "user", "body": "LGTM"}],
            captured_at=datetime.now(UTC),
        )
        await sync_store.save_pr_context(context)

        output_path = temp_dir / "pr-context.json"
        result = await export_pr_context(sync_store, "test-repo", 42, output_path)

        assert result["repo_name"] == "test-repo"
        assert result["pr_number"] == 42
        assert result["diff_size"] == len(context.diff)

        # Verify contents
        with open(output_path) as f:
            data = json.load(f)

        assert data["type"] == "pr_context"
        assert data["data"]["pr_number"] == 42

    @pytest.mark.asyncio
    async def test_export_context_compressed(self, sync_store: SyncStore, temp_dir: Path):
        """Test exporting PR context compressed."""
        context = PRContext(
            repo_name="repo",
            pr_number=1,
            pr_url="url",
            diff="diff",
            body="body",
        )
        await sync_store.save_pr_context(context)

        output_path = temp_dir / "context.json.gz"
        result = await export_pr_context(sync_store, "repo", 1, output_path)

        assert output_path.exists()

        with gzip.open(output_path, "rt") as f:
            data = json.load(f)

        assert data["pr_number"] == 1

    @pytest.mark.asyncio
    async def test_export_context_not_found(self, sync_store: SyncStore, temp_dir: Path):
        """Test error when PR context not found."""
        output_path = temp_dir / "missing.json"

        with pytest.raises(ValueError) as exc_info:
            await export_pr_context(sync_store, "nonexistent", 999, output_path)

        assert "No context found" in str(exc_info.value)


class TestListArtifactContents:
    """Tests for listing artifact contents."""

    @pytest.mark.asyncio
    async def test_list_json_contents(self, temp_dir: Path):
        """Test listing JSON artifact contents."""
        artifact = {
            "schema_version": ARTIFACT_SCHEMA_VERSION,
            "exported_at": "2024-01-01T00:00:00Z",
            "counts": {"repositories": 2, "pull_requests": 5, "pr_contexts": 3},
            "data": {},
        }

        artifact_path = temp_dir / "artifact.json"
        with open(artifact_path, "w") as f:
            json.dump(artifact, f)

        result = await list_artifact_contents(artifact_path)

        assert result["format"] == "json"
        assert result["schema_version"] == ARTIFACT_SCHEMA_VERSION
        assert result["counts"]["repositories"] == 2

    @pytest.mark.asyncio
    async def test_list_jsonl_contents(self, temp_dir: Path):
        """Test listing JSONL artifact contents."""
        artifact_path = temp_dir / "artifact.jsonl"
        with open(artifact_path, "w") as f:
            f.write(
                json.dumps(
                    {
                        "type": "metadata",
                        "schema_version": ARTIFACT_SCHEMA_VERSION,
                        "exported_at": "2024-01-01T00:00:00Z",
                    }
                )
                + "\n"
            )
            f.write(json.dumps({"type": "repository", "data": {}}) + "\n")
            f.write(json.dumps({"type": "repository", "data": {}}) + "\n")
            f.write(json.dumps({"type": "pull_request", "data": {}}) + "\n")

        result = await list_artifact_contents(artifact_path)

        assert result["format"] == "jsonl"
        assert result["counts"]["repositories"] == 2
        assert result["counts"]["pull_requests"] == 1


class TestExportImportRoundtrip:
    """Tests for full export/import roundtrip."""

    @pytest.mark.asyncio
    async def test_full_roundtrip(self, sync_store: SyncStore, temp_dir: Path):
        """Test exporting and importing preserves data."""
        # Create test data
        await sync_store.save_repository("repo", "/path/to/repo", "main")
        await sync_store.save_pr_snapshot(
            "repo",
            {
                "number": 1,
                "title": "Test PR",
                "state": "open",
                "head_branch": "feature",
                "base_branch": "main",
                "author": "developer",
                "labels": ["enhancement", "ready"],
            },
        )

        context = PRContext(
            repo_name="repo",
            pr_number=1,
            pr_url="https://github.com/test/repo/pull/1",
            diff="+ added line\n- removed line",
            body="This is the PR body",
            comments=[{"author": "reviewer", "body": "Looks good!"}],
            captured_at=datetime.now(UTC),
        )
        await sync_store.save_pr_context(context)

        # Export
        export_path = temp_dir / "export.json.gz"
        await export_database(sync_store, export_path, include_contexts=True)

        # Import into new store
        new_store = SyncStore(temp_dir / "imported.db")
        await import_database(new_store, export_path)

        # Verify data was preserved
        repos = await new_store.get_all_repositories()
        assert len(repos) == 1
        assert repos[0]["name"] == "repo"

        prs = await new_store.get_all_prs("repo")
        assert len(prs) == 1
        assert prs[0]["title"] == "Test PR"

        contexts = await new_store.get_all_pr_contexts("repo")
        assert len(contexts) == 1
        assert contexts[0].diff == context.diff

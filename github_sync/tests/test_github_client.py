"""
Tests for GitHubClient with mocked HTTP responses.
"""

from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from github_sync import CIStatus, GitHubClient, PRState
from github_sync.github_client import GitHubClientError


class TestGitHubClientInitialization:
    """Tests for client initialization."""

    def test_client_creation_with_token(self):
        """Test creating client with explicit token."""
        client = GitHubClient(
            token="test-token",
            repo_owner="owner",
            repo_name="repo",
        )

        assert client.token == "test-token"
        assert client.repo_owner == "owner"
        assert client.repo_name == "repo"

    def test_client_creation_without_token(self):
        """Test creating client without token (tries environment)."""
        with patch.dict("os.environ", {}, clear=True), patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(returncode=1, stdout="")
            client = GitHubClient(repo_owner="owner", repo_name="repo")
            assert client.token is None

    def test_client_gets_token_from_env(self):
        """Test client gets token from GITHUB_TOKEN."""
        with patch.dict("os.environ", {"GITHUB_TOKEN": "env-token"}):
            client = GitHubClient(repo_owner="owner", repo_name="repo")
            assert client.token == "env-token"

    def test_client_gets_token_from_gh_token(self):
        """Test client gets token from GH_TOKEN."""
        with patch.dict("os.environ", {"GH_TOKEN": "gh-token"}, clear=True):
            client = GitHubClient(repo_owner="owner", repo_name="repo")
            assert client.token == "gh-token"


class TestGitHubClientFromRepoPath:
    """Tests for creating client from repo path."""

    @pytest.mark.asyncio
    async def test_from_repo_path_ssh_url(self, temp_dir):
        """Test extracting repo from SSH URL."""
        repo_dir = temp_dir / "repo"
        repo_dir.mkdir()
        (repo_dir / ".git").mkdir()

        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(
                returncode=0,
                stdout="git@github.com:testowner/testrepo.git\n",
            )

            client = await GitHubClient.from_repo_path(repo_dir, token="test")

            assert client.repo_owner == "testowner"
            assert client.repo_name == "testrepo"

    @pytest.mark.asyncio
    async def test_from_repo_path_https_url(self, temp_dir):
        """Test extracting repo from HTTPS URL."""
        repo_dir = temp_dir / "repo"
        repo_dir.mkdir()
        (repo_dir / ".git").mkdir()

        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(
                returncode=0,
                stdout="https://github.com/owner/repo.git\n",
            )

            client = await GitHubClient.from_repo_path(repo_dir, token="test")

            assert client.repo_owner == "owner"
            assert client.repo_name == "repo"

    @pytest.mark.asyncio
    async def test_from_repo_path_non_github(self, temp_dir):
        """Test error for non-GitHub remote."""
        repo_dir = temp_dir / "repo"
        repo_dir.mkdir()
        (repo_dir / ".git").mkdir()

        with patch("subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(
                returncode=0,
                stdout="https://gitlab.com/owner/repo.git\n",
            )

            with pytest.raises(GitHubClientError) as exc_info:
                await GitHubClient.from_repo_path(repo_dir, token="test")

            assert "Could not determine" in str(exc_info.value)


class TestGitHubClientPROperations:
    """Tests for PR-related operations."""

    @pytest.fixture
    def mock_client(self):
        """Create a client with mocked HTTP."""
        client = GitHubClient(
            token="test-token",
            repo_owner="owner",
            repo_name="repo",
        )
        return client

    @pytest.mark.asyncio
    async def test_get_pull_requests(self, mock_client):
        """Test fetching pull requests."""
        mock_response = [
            {
                "number": 1,
                "title": "Test PR",
                "state": "open",
                "draft": False,
                "user": {"login": "testuser"},
                "labels": [{"name": "bug"}],
                "head": {"ref": "feature", "sha": "abc123"},
                "base": {"ref": "main"},
                "html_url": "https://github.com/owner/repo/pull/1",
                "created_at": "2024-01-01T00:00:00Z",
                "updated_at": "2024-01-02T00:00:00Z",
                "additions": 10,
                "deletions": 5,
                "changed_files": 2,
                "commits": 1,
                "mergeable": True,
            }
        ]

        with patch.object(mock_client, "_request", new_callable=AsyncMock) as mock_req:
            # First call for PRs, subsequent calls for CI checks
            mock_req.side_effect = [
                mock_response,  # PR list
                {"check_runs": []},  # CI checks for PR 1
                [],  # Status checks for PR 1
            ]

            prs = await mock_client.get_pull_requests(state="open")

            assert len(prs) == 1
            assert prs[0].number == 1
            assert prs[0].title == "Test PR"
            assert prs[0].state == PRState.OPEN
            assert prs[0].author == "testuser"
            assert "bug" in prs[0].labels

    @pytest.mark.asyncio
    async def test_get_pull_requests_draft(self, mock_client):
        """Test that draft PRs are detected."""
        mock_response = [
            {
                "number": 1,
                "title": "Draft PR",
                "state": "open",
                "draft": True,
                "user": {"login": "user"},
                "labels": [],
                "head": {"ref": "feature", "sha": "abc"},
                "base": {"ref": "main"},
                "html_url": "https://github.com/owner/repo/pull/1",
                "created_at": "2024-01-01T00:00:00Z",
                "updated_at": "2024-01-01T00:00:00Z",
            }
        ]

        with patch.object(mock_client, "_request", new_callable=AsyncMock) as mock_req:
            mock_req.side_effect = [mock_response, {"check_runs": []}, []]

            prs = await mock_client.get_pull_requests()

            assert prs[0].state == PRState.DRAFT
            assert prs[0].draft is True

    @pytest.mark.asyncio
    async def test_get_pull_request_by_number(self, mock_client):
        """Test fetching a specific PR."""
        mock_response = {
            "number": 42,
            "title": "Specific PR",
            "state": "open",
            "draft": False,
            "user": {"login": "dev"},
            "labels": [],
            "head": {"ref": "feature-42", "sha": "def456"},
            "base": {"ref": "main"},
            "html_url": "https://github.com/owner/repo/pull/42",
            "created_at": "2024-01-01T00:00:00Z",
            "updated_at": "2024-01-01T00:00:00Z",
            "body": "PR body text",
        }

        with patch.object(mock_client, "_request", new_callable=AsyncMock) as mock_req:
            mock_req.side_effect = [mock_response, {"check_runs": []}, []]

            pr = await mock_client.get_pull_request(42)

            assert pr is not None
            assert pr.number == 42
            assert pr.body == "PR body text"

    @pytest.mark.asyncio
    async def test_get_pull_request_not_found(self, mock_client):
        """Test handling PR not found."""
        with patch.object(mock_client, "_request", new_callable=AsyncMock) as mock_req:
            mock_req.side_effect = GitHubClientError("Not found")

            pr = await mock_client.get_pull_request(999)

            assert pr is None


class TestGitHubClientCIChecks:
    """Tests for CI check operations."""

    @pytest.fixture
    def mock_client(self):
        return GitHubClient(token="test", repo_owner="owner", repo_name="repo")

    @pytest.mark.asyncio
    async def test_get_ci_checks_success(self, mock_client):
        """Test parsing successful CI checks."""
        check_runs_response = {
            "check_runs": [
                {
                    "name": "build",
                    "status": "completed",
                    "conclusion": "success",
                    "html_url": "https://github.com/owner/repo/runs/1",
                    "started_at": "2024-01-01T00:00:00Z",
                    "completed_at": "2024-01-01T00:01:00Z",
                },
                {
                    "name": "test",
                    "status": "completed",
                    "conclusion": "success",
                    "html_url": "https://github.com/owner/repo/runs/2",
                    "started_at": "2024-01-01T00:00:00Z",
                    "completed_at": "2024-01-01T00:02:00Z",
                },
            ]
        }

        with patch.object(mock_client, "_request", new_callable=AsyncMock) as mock_req:
            mock_req.side_effect = [check_runs_response, []]

            checks = await mock_client._get_ci_checks("abc123")

            assert len(checks) == 2
            assert checks[0].name == "build"
            assert checks[0].status == CIStatus.SUCCESS
            assert checks[1].name == "test"

    @pytest.mark.asyncio
    async def test_get_ci_checks_failure(self, mock_client):
        """Test parsing failed CI checks."""
        check_runs_response = {
            "check_runs": [
                {
                    "name": "test",
                    "status": "completed",
                    "conclusion": "failure",
                    "html_url": "url",
                },
            ]
        }

        with patch.object(mock_client, "_request", new_callable=AsyncMock) as mock_req:
            mock_req.side_effect = [check_runs_response, []]

            checks = await mock_client._get_ci_checks("abc123")

            assert checks[0].status == CIStatus.FAILURE

    @pytest.mark.asyncio
    async def test_get_ci_checks_pending(self, mock_client):
        """Test parsing pending CI checks."""
        check_runs_response = {
            "check_runs": [
                {
                    "name": "deploy",
                    "status": "in_progress",
                    "conclusion": None,
                    "html_url": "url",
                },
            ]
        }

        with patch.object(mock_client, "_request", new_callable=AsyncMock) as mock_req:
            mock_req.side_effect = [check_runs_response, []]

            checks = await mock_client._get_ci_checks("abc123")

            assert checks[0].status == CIStatus.PENDING

    @pytest.mark.asyncio
    async def test_get_ci_checks_with_status_api(self, mock_client):
        """Test parsing older status API responses."""
        check_runs_response = {"check_runs": []}
        statuses_response = [
            {
                "context": "ci/travis",
                "state": "success",
                "target_url": "https://travis-ci.org/build/1",
                "created_at": "2024-01-01T00:00:00Z",
                "updated_at": "2024-01-01T00:01:00Z",
            }
        ]

        with patch.object(mock_client, "_request", new_callable=AsyncMock) as mock_req:
            mock_req.side_effect = [check_runs_response, statuses_response]

            checks = await mock_client._get_ci_checks("abc123")

            assert len(checks) == 1
            assert checks[0].name == "ci/travis"
            assert checks[0].status == CIStatus.SUCCESS


class TestGitHubClientPRContext:
    """Tests for PR context fetching."""

    @pytest.fixture
    def mock_client(self):
        return GitHubClient(token="test", repo_owner="owner", repo_name="repo")

    @pytest.mark.asyncio
    async def test_get_pr_diff(self, mock_client):
        """Test fetching PR diff."""
        diff_content = """diff --git a/file.py b/file.py
--- a/file.py
+++ b/file.py
@@ -1,3 +1,4 @@
+# New comment
 def main():
     pass
"""

        with patch.object(mock_client, "_get_client", new_callable=AsyncMock) as mock_get:
            mock_http = AsyncMock()
            mock_response = MagicMock()
            mock_response.status_code = 200
            mock_response.text = diff_content
            mock_response.raise_for_status = MagicMock()
            mock_http.get = AsyncMock(return_value=mock_response)
            mock_get.return_value = mock_http

            diff = await mock_client.get_pr_diff(1)

            assert "New comment" in diff
            assert "def main():" in diff

    @pytest.mark.asyncio
    async def test_get_pr_comments(self, mock_client):
        """Test fetching PR comments."""
        comments_response = [
            {
                "id": 1,
                "user": {"login": "reviewer"},
                "body": "Looks good!",
                "created_at": "2024-01-01T00:00:00Z",
                "updated_at": "2024-01-01T00:00:00Z",
            },
            {
                "id": 2,
                "user": {"login": "author"},
                "body": "Thanks!",
                "created_at": "2024-01-02T00:00:00Z",
                "updated_at": "2024-01-02T00:00:00Z",
            },
        ]

        with patch.object(mock_client, "_request", new_callable=AsyncMock) as mock_req:
            mock_req.return_value = comments_response

            comments = await mock_client.get_pr_comments(1)

            assert len(comments) == 2
            assert comments[0]["author"] == "reviewer"
            assert comments[0]["body"] == "Looks good!"

    @pytest.mark.asyncio
    async def test_get_pr_review_comments(self, mock_client):
        """Test fetching PR review comments."""
        review_comments_response = [
            {
                "id": 1,
                "user": {"login": "reviewer"},
                "body": "Fix this line",
                "path": "src/main.py",
                "line": 42,
                "created_at": "2024-01-01T00:00:00Z",
                "updated_at": "2024-01-01T00:00:00Z",
            },
        ]

        with patch.object(mock_client, "_request", new_callable=AsyncMock) as mock_req:
            mock_req.return_value = review_comments_response

            comments = await mock_client.get_pr_review_comments(1)

            assert len(comments) == 1
            assert comments[0]["path"] == "src/main.py"
            assert comments[0]["line"] == 42

    @pytest.mark.asyncio
    async def test_get_pr_commits(self, mock_client):
        """Test fetching PR commits."""
        commits_response = [
            {
                "sha": "abc123",
                "commit": {
                    "message": "Initial commit",
                    "author": {
                        "name": "Developer",
                        "date": "2024-01-01T00:00:00Z",
                    },
                },
            },
            {
                "sha": "def456",
                "commit": {
                    "message": "Fix bug",
                    "author": {
                        "name": "Developer",
                        "date": "2024-01-02T00:00:00Z",
                    },
                },
            },
        ]

        with patch.object(mock_client, "_request", new_callable=AsyncMock) as mock_req:
            mock_req.return_value = commits_response

            commits = await mock_client.get_pr_commits(1)

            assert len(commits) == 2
            assert commits[0]["sha"] == "abc123"
            assert commits[1]["message"] == "Fix bug"

    @pytest.mark.asyncio
    async def test_get_pr_files(self, mock_client):
        """Test fetching PR files."""
        files_response = [
            {
                "filename": "src/main.py",
                "status": "modified",
                "additions": 10,
                "deletions": 5,
                "changes": 15,
                "patch": "@@ -1,3 +1,4 @@\n+# comment",
            },
            {
                "filename": "tests/test_main.py",
                "status": "added",
                "additions": 20,
                "deletions": 0,
                "changes": 20,
                "patch": "@@ -0,0 +1,20 @@\n+import pytest",
            },
        ]

        with patch.object(mock_client, "_request", new_callable=AsyncMock) as mock_req:
            mock_req.return_value = files_response

            files = await mock_client.get_pr_files(1)

            assert len(files) == 2
            assert files[0]["filename"] == "src/main.py"
            assert files[0]["status"] == "modified"
            assert files[1]["additions"] == 20


class TestGitHubClientLabelFiltering:
    """Tests for label-based PR filtering."""

    @pytest.fixture
    def mock_client(self):
        return GitHubClient(token="test", repo_owner="owner", repo_name="repo")

    @pytest.mark.asyncio
    async def test_get_prs_with_labels(self, mock_client):
        """Test filtering PRs by labels."""
        # Mock get_pull_requests to return some PRs
        from github_sync import PRState, PullRequest

        now = datetime.now(UTC)
        mock_prs = [
            PullRequest(
                number=1,
                title="PR 1",
                state=PRState.OPEN,
                head_branch="f1",
                base_branch="main",
                author="u",
                url="url1",
                created_at=now,
                updated_at=now,
                labels=["for-landing", "bug"],
            ),
            PullRequest(
                number=2,
                title="PR 2",
                state=PRState.OPEN,
                head_branch="f2",
                base_branch="main",
                author="u",
                url="url2",
                created_at=now,
                updated_at=now,
                labels=["for-review"],
            ),
            PullRequest(
                number=3,
                title="PR 3",
                state=PRState.OPEN,
                head_branch="f3",
                base_branch="main",
                author="u",
                url="url3",
                created_at=now,
                updated_at=now,
                labels=["enhancement"],
            ),
        ]

        with patch.object(mock_client, "get_pull_requests", new_callable=AsyncMock) as mock_get:
            mock_get.return_value = mock_prs

            pr_numbers = await mock_client.get_prs_with_labels(["for-landing"])

            assert pr_numbers == [1]

    @pytest.mark.asyncio
    async def test_get_prs_with_multiple_labels(self, mock_client):
        """Test filtering PRs by multiple labels."""
        from github_sync import PRState, PullRequest

        now = datetime.now(UTC)
        mock_prs = [
            PullRequest(
                number=1,
                title="PR 1",
                state=PRState.OPEN,
                head_branch="f1",
                base_branch="main",
                author="u",
                url="url1",
                created_at=now,
                updated_at=now,
                labels=["for-landing"],
            ),
            PullRequest(
                number=2,
                title="PR 2",
                state=PRState.OPEN,
                head_branch="f2",
                base_branch="main",
                author="u",
                url="url2",
                created_at=now,
                updated_at=now,
                labels=["for-review"],
            ),
        ]

        with patch.object(mock_client, "get_pull_requests", new_callable=AsyncMock) as mock_get:
            mock_get.return_value = mock_prs

            pr_numbers = await mock_client.get_prs_with_labels(["for-landing", "for-review"])

            assert set(pr_numbers) == {1, 2}


class TestGitHubClientErrorHandling:
    """Tests for error handling."""

    @pytest.fixture
    def mock_client(self):
        return GitHubClient(token="test", repo_owner="owner", repo_name="repo")

    @pytest.mark.asyncio
    async def test_http_error_handling(self, mock_client):
        """Test handling HTTP errors."""
        with patch.object(mock_client, "_get_client", new_callable=AsyncMock) as mock_get:
            mock_http = AsyncMock()
            mock_response = MagicMock()
            mock_response.status_code = 404
            mock_response.text = "Not Found"
            mock_response.raise_for_status.side_effect = httpx.HTTPStatusError(
                "Not Found",
                request=MagicMock(),
                response=mock_response,
            )
            mock_http.request = AsyncMock(return_value=mock_response)
            mock_get.return_value = mock_http

            with pytest.raises(GitHubClientError) as exc_info:
                await mock_client._request("GET", "/repos/owner/repo/pulls")

            assert "404" in str(exc_info.value)

    @pytest.mark.asyncio
    async def test_connection_error_handling(self, mock_client):
        """Test handling connection errors."""
        with patch.object(mock_client, "_get_client", new_callable=AsyncMock) as mock_get:
            mock_http = AsyncMock()
            mock_http.request.side_effect = httpx.RequestError("Connection failed")
            mock_get.return_value = mock_http

            with pytest.raises(GitHubClientError) as exc_info:
                await mock_client._request("GET", "/repos/owner/repo/pulls")

            assert "Request error" in str(exc_info.value)


class TestGitHubClientContextManager:
    """Tests for async context manager."""

    @pytest.mark.asyncio
    async def test_context_manager(self):
        """Test using client as context manager."""
        client = GitHubClient(token="test", repo_owner="owner", repo_name="repo")

        async with client:
            # Client uses lazy initialization - force creation
            await client._get_client()
            assert client._client is not None

        # Client should be closed after context
        assert client._client is None

    @pytest.mark.asyncio
    async def test_close_method(self):
        """Test explicit close method."""
        client = GitHubClient(token="test", repo_owner="owner", repo_name="repo")

        # Force client creation
        await client._get_client()
        assert client._client is not None

        await client.close()
        assert client._client is None

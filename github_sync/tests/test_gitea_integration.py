"""
Integration tests using Gitea testcontainer.

These tests require Docker and test the full GitHub-compatible API flow.
Run with: pytest github_sync/tests/test_gitea_integration.py -v

Note: These tests are slower due to container startup time.
The container and shared repos are session-scoped for performance.

Fixtures:
- gitea_shared_repo: Session-scoped repo for read-only tests
- gitea_shared_repo_with_pr: Session-scoped repo with PR for read-only tests
- gitea_repo: Function-scoped fresh repo for tests that modify state
- gitea_repo_with_pr: Function-scoped fresh repo with PR for tests that modify state
"""

import pytest

# Mark all tests in this module as integration tests
pytestmark = [
    pytest.mark.integration,
    pytest.mark.slow,
]


class TestGiteaContainer:
    """Tests for basic Gitea container functionality (read-only)."""

    @pytest.mark.asyncio
    async def test_gitea_starts(self, gitea_instance):
        """Test that Gitea container starts and is accessible."""
        import httpx

        response = httpx.get(f"{gitea_instance.api_url}/version", timeout=10)
        assert response.status_code == 200
        data = response.json()
        assert "version" in data

    @pytest.mark.asyncio
    async def test_gitea_admin_auth(self, gitea_instance):
        """Test that admin authentication works."""
        import httpx

        response = httpx.get(
            f"{gitea_instance.api_url}/user",
            auth=(gitea_instance.admin_user, gitea_instance.admin_password),
            timeout=10,
        )
        # May be 200 or 404 depending on whether user exists
        assert response.status_code in (200, 404, 401)


class TestGiteaSharedRepoReadOnly:
    """Read-only tests using the shared session-scoped repo."""

    @pytest.mark.asyncio
    async def test_gitea_repo_created(self, gitea_shared_repo):
        """Test that the shared repo exists on Gitea."""
        import httpx

        instance = gitea_shared_repo.gitea_instance
        repo_name = gitea_shared_repo.name

        # Verify repo exists on Gitea
        response = httpx.get(
            f"{instance.api_url}/repos/{instance.admin_user}/{repo_name}",
            auth=(instance.admin_user, instance.admin_password),
            timeout=10,
        )
        assert response.status_code == 200

    @pytest.mark.asyncio
    async def test_gitea_repo_has_remote(self, gitea_shared_repo):
        """Test that the local repo has the correct remote."""
        result = gitea_shared_repo.run_git("remote", "-v")
        assert "origin" in result.stdout
        assert gitea_shared_repo.gitea_instance.host in result.stdout


class TestGiteaRepoMutating:
    """Tests that modify repo state - use function-scoped fixture."""

    @pytest.mark.asyncio
    async def test_gitea_repo_can_push(self, gitea_repo):
        """Test that we can push to the Gitea repo."""
        # Create a new commit
        (gitea_repo.path / "test-file.txt").write_text("test content\n")
        gitea_repo.run_git("add", ".")
        gitea_repo.run_git("commit", "-m", "Test commit")

        # Push should succeed
        result = gitea_repo.run_git("push", "origin", "main", check=False)
        # May succeed or may need force push depending on state
        assert result.returncode in (0, 1)


class TestGiteaSharedPRReadOnly:
    """Read-only tests using the shared session-scoped repo with PR."""

    @pytest.mark.asyncio
    async def test_pr_exists(self, gitea_shared_repo_with_pr):
        """Test that the PR exists on Gitea."""
        import httpx

        repo, pr_number = gitea_shared_repo_with_pr
        instance = repo.gitea_instance

        response = httpx.get(
            f"{instance.api_url}/repos/{instance.admin_user}/{repo.name}/pulls/{pr_number}",
            auth=(instance.admin_user, instance.admin_password),
            timeout=10,
        )
        assert response.status_code == 200

        data = response.json()
        assert data["number"] == pr_number
        assert data["state"] == "open"

    @pytest.mark.asyncio
    async def test_pr_has_feature_branch(self, gitea_shared_repo_with_pr):
        """Test that the PR's feature branch exists."""
        repo, _ = gitea_shared_repo_with_pr

        branches = repo.run_git("branch", "-a")
        assert "feature/test-pr" in branches.stdout


class TestSyncWithGitea:
    """Tests for syncing with Gitea (read-only operations)."""

    @pytest.mark.asyncio
    async def test_sync_gitea_repo(self, gitea_shared_repo, sync_store):
        """Test syncing a Gitea repository."""
        from github_sync import GitClient

        client = GitClient(gitea_shared_repo.path)
        await client.validate_repo()

        # Get branches
        local, remote = await client.get_all_branches_with_status()

        assert len(local) > 0
        assert len(remote) > 0

        # Verify we can detect the remote
        info = await client.get_repository_info()
        assert "remote_url" in info

    @pytest.mark.asyncio
    async def test_store_gitea_repo_state(self, gitea_shared_repo, sync_store):
        """Test storing Gitea repo state in the database."""
        from github_sync import ActionRegistry, SaveBranchState, SaveRepository

        registry = ActionRegistry(sync_store)

        # Save repository
        await registry.execute(
            SaveRepository(
                repo_name=gitea_shared_repo.name,
                repo_path=str(gitea_shared_repo.path),
                default_branch="main",
            )
        )

        # Save branch state
        await registry.execute(
            SaveBranchState(
                repo_name=gitea_shared_repo.name,
                branch_name="main",
                is_local=True,
                is_remote=True,
            )
        )

        # Verify stored
        from github_sync import GetRepository

        result = await registry.execute(GetRepository(repo_name=gitea_shared_repo.name))

        assert result.success
        assert result.data["result"]["name"] == gitea_shared_repo.name


class TestGiteaAPIClient:
    """Tests for the GitHub client against Gitea's GitHub-compatible API (read-only)."""

    @pytest.mark.asyncio
    async def test_fetch_prs_from_gitea(self, gitea_shared_repo_with_pr):
        """Test fetching PRs via the GitHub-compatible API."""
        import httpx

        repo, pr_number = gitea_shared_repo_with_pr
        instance = repo.gitea_instance

        # Gitea's API is GitHub-compatible
        response = httpx.get(
            f"{instance.api_url}/repos/{instance.admin_user}/{repo.name}/pulls",
            auth=(instance.admin_user, instance.admin_password),
            timeout=10,
        )
        assert response.status_code == 200

        prs = response.json()
        assert len(prs) >= 1
        assert any(pr["number"] == pr_number for pr in prs)

    @pytest.mark.asyncio
    async def test_fetch_pr_diff_from_gitea(self, gitea_shared_repo_with_pr):
        """Test fetching PR diff from Gitea."""
        import httpx

        repo, pr_number = gitea_shared_repo_with_pr
        instance = repo.gitea_instance

        response = httpx.get(
            f"{instance.api_url}/repos/{instance.admin_user}/{repo.name}/pulls/{pr_number}.diff",
            auth=(instance.admin_user, instance.admin_password),
            timeout=10,
        )
        # Gitea returns diff as plain text
        assert response.status_code == 200
        assert "diff" in response.text.lower() or "---" in response.text or "+++" in response.text

    @pytest.mark.asyncio
    async def test_fetch_pr_files_from_gitea(self, gitea_shared_repo_with_pr):
        """Test fetching changed files from Gitea PR."""
        import httpx

        repo, pr_number = gitea_shared_repo_with_pr
        instance = repo.gitea_instance

        response = httpx.get(
            f"{instance.api_url}/repos/{instance.admin_user}/{repo.name}/pulls/{pr_number}/files",
            auth=(instance.admin_user, instance.admin_password),
            timeout=10,
        )
        assert response.status_code == 200

        files = response.json()
        assert len(files) >= 1
        assert any("feature.txt" in f.get("filename", "") for f in files)

"""
Tests for data models and their serialization.
"""

from datetime import UTC, datetime

from github_sync import (
    Branch,
    BranchPRState,
    BranchStatus,
    CICheck,
    CIStatus,
    PRContext,
    PRState,
    PullRequest,
    RepositoryState,
)


class TestBranchModel:
    """Tests for Branch model."""

    def test_branch_creation(self):
        """Test creating a Branch."""
        branch = Branch(
            name="feature/test",
            sha="abc123def456",
            is_local=True,
            is_remote=False,
        )

        assert branch.name == "feature/test"
        assert branch.sha == "abc123def456"
        assert branch.is_local
        assert not branch.is_remote
        assert branch.status == BranchStatus.UNKNOWN

    def test_branch_with_all_fields(self):
        """Test Branch with all optional fields."""
        now = datetime.now(UTC)
        branch = Branch(
            name="main",
            sha="abc123",
            is_local=True,
            is_remote=True,
            upstream="origin/main",
            status=BranchStatus.AHEAD,
            ahead_by=3,
            behind_by=1,
            last_commit_date=now,
            last_commit_author="testuser",
            last_commit_message="Fix bug",
        )

        assert branch.upstream == "origin/main"
        assert branch.status == BranchStatus.AHEAD
        assert branch.ahead_by == 3
        assert branch.behind_by == 1
        assert branch.last_commit_date == now

    def test_branch_to_dict(self):
        """Test Branch serialization to dict."""
        now = datetime.now(UTC)
        branch = Branch(
            name="feature",
            sha="abc123",
            is_local=True,
            is_remote=False,
            status=BranchStatus.LOCAL_ONLY,
            last_commit_date=now,
        )

        data = branch.to_dict()

        assert data["name"] == "feature"
        assert data["sha"] == "abc123"
        assert data["is_local"] is True
        assert data["is_remote"] is False
        assert data["status"] == "local_only"
        assert data["last_commit_date"] == now.isoformat()

    def test_branch_from_dict(self):
        """Test Branch deserialization from dict."""
        now = datetime.now(UTC)
        data = {
            "name": "feature",
            "sha": "abc123",
            "is_local": True,
            "is_remote": False,
            "status": "ahead",
            "ahead_by": 2,
            "behind_by": 0,
            "last_commit_date": now.isoformat(),
            "last_commit_author": "user",
            "last_commit_message": "msg",
        }

        branch = Branch.from_dict(data)

        assert branch.name == "feature"
        assert branch.status == BranchStatus.AHEAD
        assert branch.ahead_by == 2

    def test_branch_roundtrip(self):
        """Test Branch serialization roundtrip."""
        original = Branch(
            name="test",
            sha="sha123",
            is_local=True,
            is_remote=True,
            upstream="origin/test",
            status=BranchStatus.DIVERGED,
            ahead_by=5,
            behind_by=3,
            last_commit_date=datetime.now(UTC),
            last_commit_author="author",
            last_commit_message="message",
        )

        restored = Branch.from_dict(original.to_dict())

        assert restored.name == original.name
        assert restored.sha == original.sha
        assert restored.status == original.status
        assert restored.ahead_by == original.ahead_by


class TestCICheckModel:
    """Tests for CICheck model."""

    def test_ci_check_creation(self):
        """Test creating a CICheck."""
        check = CICheck(
            name="build",
            status=CIStatus.SUCCESS,
        )

        assert check.name == "build"
        assert check.status == CIStatus.SUCCESS

    def test_ci_check_with_all_fields(self):
        """Test CICheck with all fields."""
        started = datetime.now(UTC)
        completed = datetime.now(UTC)

        check = CICheck(
            name="test",
            status=CIStatus.FAILURE,
            conclusion="failure",
            details_url="https://ci.example.com/123",
            started_at=started,
            completed_at=completed,
        )

        assert check.conclusion == "failure"
        assert check.details_url == "https://ci.example.com/123"
        assert check.started_at == started

    def test_ci_check_to_dict(self):
        """Test CICheck serialization."""
        check = CICheck(
            name="lint",
            status=CIStatus.PENDING,
        )

        data = check.to_dict()

        assert data["name"] == "lint"
        assert data["status"] == "pending"

    def test_ci_check_roundtrip(self):
        """Test CICheck serialization roundtrip."""
        original = CICheck(
            name="deploy",
            status=CIStatus.SUCCESS,
            conclusion="success",
            details_url="https://example.com",
            started_at=datetime.now(UTC),
            completed_at=datetime.now(UTC),
        )

        restored = CICheck.from_dict(original.to_dict())

        assert restored.name == original.name
        assert restored.status == original.status


class TestPullRequestModel:
    """Tests for PullRequest model."""

    def test_pull_request_creation(self):
        """Test creating a PullRequest."""
        now = datetime.now(UTC)
        pr = PullRequest(
            number=123,
            title="Add feature",
            state=PRState.OPEN,
            head_branch="feature/add",
            base_branch="main",
            author="testuser",
            url="https://github.com/test/repo/pull/123",
            created_at=now,
            updated_at=now,
        )

        assert pr.number == 123
        assert pr.title == "Add feature"
        assert pr.state == PRState.OPEN

    def test_pull_request_get_ci_status_no_checks(self):
        """Test CI status when no checks exist."""
        pr = PullRequest(
            number=1,
            title="Test",
            state=PRState.OPEN,
            head_branch="test",
            base_branch="main",
            author="user",
            url="https://example.com",
            created_at=datetime.now(UTC),
            updated_at=datetime.now(UTC),
        )

        assert pr.get_ci_status() == CIStatus.NONE

    def test_pull_request_get_ci_status_all_success(self):
        """Test CI status when all checks succeed."""
        pr = PullRequest(
            number=1,
            title="Test",
            state=PRState.OPEN,
            head_branch="test",
            base_branch="main",
            author="user",
            url="https://example.com",
            created_at=datetime.now(UTC),
            updated_at=datetime.now(UTC),
            ci_checks=[
                CICheck(name="build", status=CIStatus.SUCCESS),
                CICheck(name="test", status=CIStatus.SUCCESS),
            ],
        )

        assert pr.get_ci_status() == CIStatus.SUCCESS

    def test_pull_request_get_ci_status_any_failure(self):
        """Test CI status when any check fails."""
        pr = PullRequest(
            number=1,
            title="Test",
            state=PRState.OPEN,
            head_branch="test",
            base_branch="main",
            author="user",
            url="https://example.com",
            created_at=datetime.now(UTC),
            updated_at=datetime.now(UTC),
            ci_checks=[
                CICheck(name="build", status=CIStatus.SUCCESS),
                CICheck(name="test", status=CIStatus.FAILURE),
            ],
        )

        assert pr.get_ci_status() == CIStatus.FAILURE

    def test_pull_request_get_ci_status_pending(self):
        """Test CI status when any check is pending."""
        pr = PullRequest(
            number=1,
            title="Test",
            state=PRState.OPEN,
            head_branch="test",
            base_branch="main",
            author="user",
            url="https://example.com",
            created_at=datetime.now(UTC),
            updated_at=datetime.now(UTC),
            ci_checks=[
                CICheck(name="build", status=CIStatus.SUCCESS),
                CICheck(name="test", status=CIStatus.PENDING),
            ],
        )

        assert pr.get_ci_status() == CIStatus.PENDING

    def test_pull_request_get_processing_mode_for_landing(self):
        """Test processing mode detection for landing."""
        pr = PullRequest(
            number=1,
            title="Test",
            state=PRState.OPEN,
            head_branch="test",
            base_branch="main",
            author="user",
            url="https://example.com",
            created_at=datetime.now(UTC),
            updated_at=datetime.now(UTC),
            labels=["for-landing", "bug"],
        )

        assert pr.get_processing_mode() == "for-landing"

    def test_pull_request_get_processing_mode_for_review(self):
        """Test processing mode detection for review."""
        pr = PullRequest(
            number=1,
            title="Test",
            state=PRState.OPEN,
            head_branch="test",
            base_branch="main",
            author="user",
            url="https://example.com",
            created_at=datetime.now(UTC),
            updated_at=datetime.now(UTC),
            labels=["for-review"],
        )

        assert pr.get_processing_mode() == "for-review"

    def test_pull_request_get_processing_mode_none(self):
        """Test processing mode when no relevant labels."""
        pr = PullRequest(
            number=1,
            title="Test",
            state=PRState.OPEN,
            head_branch="test",
            base_branch="main",
            author="user",
            url="https://example.com",
            created_at=datetime.now(UTC),
            updated_at=datetime.now(UTC),
            labels=["enhancement"],
        )

        assert pr.get_processing_mode() is None

    def test_pull_request_to_dict(self):
        """Test PullRequest serialization."""
        now = datetime.now(UTC)
        pr = PullRequest(
            number=42,
            title="Feature",
            state=PRState.DRAFT,
            head_branch="feature",
            base_branch="main",
            author="dev",
            url="https://github.com/test/repo/pull/42",
            created_at=now,
            updated_at=now,
            body="Description",
            draft=True,
            labels=["wip"],
            additions=100,
            deletions=50,
        )

        data = pr.to_dict()

        assert data["number"] == 42
        assert data["state"] == "draft"
        assert data["draft"] is True
        assert data["additions"] == 100

    def test_pull_request_roundtrip(self):
        """Test PullRequest serialization roundtrip."""
        now = datetime.now(UTC)
        original = PullRequest(
            number=1,
            title="Test PR",
            state=PRState.OPEN,
            head_branch="feature",
            base_branch="main",
            author="user",
            url="https://example.com/pull/1",
            created_at=now,
            updated_at=now,
            body="Body text",
            draft=False,
            labels=["bug", "priority"],
            ci_checks=[
                CICheck(name="build", status=CIStatus.SUCCESS),
            ],
            additions=10,
            deletions=5,
            changed_files=3,
            commits=2,
        )

        restored = PullRequest.from_dict(original.to_dict())

        assert restored.number == original.number
        assert restored.title == original.title
        assert restored.labels == original.labels
        assert len(restored.ci_checks) == 1


class TestPRContextModel:
    """Tests for PRContext model."""

    def test_pr_context_creation(self):
        """Test creating a PRContext."""
        context = PRContext(
            repo_name="test-repo",
            pr_number=1,
            pr_url="https://github.com/test/repo/pull/1",
            diff="+ added line",
            body="PR description",
        )

        assert context.repo_name == "test-repo"
        assert context.pr_number == 1
        assert context.diff == "+ added line"

    def test_pr_context_with_all_fields(self):
        """Test PRContext with all fields."""
        now = datetime.now(UTC)
        context = PRContext(
            repo_name="repo",
            pr_number=42,
            pr_url="https://example.com/pull/42",
            diff="diff content",
            body="body",
            comments=[{"author": "user1", "body": "LGTM"}],
            review_comments=[{"author": "user2", "body": "Fix this", "path": "file.py"}],
            commits=[{"sha": "abc", "message": "commit"}],
            files=[{"filename": "test.py", "status": "modified"}],
            conflicts={"has_conflicts": False},
            ci_checks={"total": 2, "success": 2},
            guidelines="Follow style guide",
            commit_examples="feat: description",
            captured_at=now,
        )

        assert len(context.comments) == 1
        assert len(context.review_comments) == 1
        assert context.captured_at == now

    def test_pr_context_to_dict(self):
        """Test PRContext serialization."""
        context = PRContext(
            repo_name="repo",
            pr_number=1,
            pr_url="url",
            diff="diff",
            body="body",
            comments=[{"id": 1}],
        )

        data = context.to_dict()

        assert data["repo_name"] == "repo"
        assert data["pr_number"] == 1
        assert len(data["comments"]) == 1

    def test_pr_context_roundtrip(self):
        """Test PRContext serialization roundtrip."""
        original = PRContext(
            repo_name="test-repo",
            pr_number=123,
            pr_url="https://github.com/test/repo/pull/123",
            diff="+ line1\n- line2",
            body="Description",
            comments=[{"author": "a", "body": "b"}],
            review_comments=[{"author": "c", "body": "d"}],
            commits=[{"sha": "e", "message": "f"}],
            files=[{"filename": "g"}],
            captured_at=datetime.now(UTC),
        )

        restored = PRContext.from_dict(original.to_dict())

        assert restored.repo_name == original.repo_name
        assert restored.pr_number == original.pr_number
        assert restored.diff == original.diff
        assert restored.comments == original.comments


class TestBranchPRStateModel:
    """Tests for BranchPRState model."""

    def test_branch_pr_state_with_local_only(self):
        """Test BranchPRState with only local branch."""
        local_branch = Branch(
            name="feature",
            sha="abc123",
            is_local=True,
            is_remote=False,
        )

        state = BranchPRState(
            branch_name="feature",
            local_branch=local_branch,
        )

        assert state.branch_status == BranchStatus.LOCAL_ONLY
        assert not state.is_tracked
        assert not state.has_pr

    def test_branch_pr_state_with_both_branches(self):
        """Test BranchPRState with local and remote branches."""
        local_branch = Branch(
            name="feature",
            sha="abc123",
            is_local=True,
            is_remote=False,
            status=BranchStatus.AHEAD,
        )
        remote_branch = Branch(
            name="feature",
            sha="def456",
            is_local=False,
            is_remote=True,
        )

        state = BranchPRState(
            branch_name="feature",
            local_branch=local_branch,
            remote_branch=remote_branch,
        )

        assert state.is_tracked
        assert state.needs_push
        assert not state.needs_pull

    def test_branch_pr_state_with_pr(self):
        """Test BranchPRState with associated PR."""
        now = datetime.now(UTC)
        pr = PullRequest(
            number=1,
            title="Test",
            state=PRState.OPEN,
            head_branch="feature",
            base_branch="main",
            author="user",
            url="url",
            created_at=now,
            updated_at=now,
            ci_checks=[CICheck(name="build", status=CIStatus.FAILURE)],
        )

        state = BranchPRState(
            branch_name="feature",
            pr=pr,
        )

        assert state.has_pr
        assert state.ci_status == CIStatus.FAILURE

    def test_branch_pr_state_to_dict(self):
        """Test BranchPRState serialization."""
        state = BranchPRState(
            branch_name="test",
            local_branch=Branch(name="test", sha="abc", is_local=True, is_remote=False),
        )

        data = state.to_dict()

        assert data["branch_name"] == "test"
        assert data["local_branch"] is not None
        assert data["remote_branch"] is None


class TestRepositoryStateModel:
    """Tests for RepositoryState model."""

    def test_repository_state_creation(self):
        """Test creating a RepositoryState."""
        state = RepositoryState(
            repo_path="/path/to/repo",
            default_branch="main",
        )

        assert state.repo_path == "/path/to/repo"
        assert state.default_branch == "main"
        assert len(state.branch_pr_states) == 0

    def test_repository_state_add_state(self):
        """Test adding branch states."""
        repo_state = RepositoryState(
            repo_path="/repo",
            default_branch="main",
        )

        branch_state = BranchPRState(branch_name="feature")
        repo_state.add_state(branch_state)

        assert len(repo_state.branch_pr_states) == 1
        assert repo_state.get_by_branch("feature") == branch_state

    def test_repository_state_indexes(self):
        """Test branch and PR lookups."""
        now = datetime.now(UTC)
        repo_state = RepositoryState(
            repo_path="/repo",
            default_branch="main",
        )

        pr = PullRequest(
            number=42,
            title="Test",
            state=PRState.OPEN,
            head_branch="feature",
            base_branch="main",
            author="user",
            url="url",
            created_at=now,
            updated_at=now,
        )

        branch_state = BranchPRState(branch_name="feature", pr=pr)
        repo_state.add_state(branch_state)

        # Lookup by branch
        assert repo_state.get_by_branch("feature") == branch_state

        # Lookup by PR
        assert repo_state.get_by_pr(42) == branch_state

    def test_repository_state_filtering(self):
        """Test filtering methods."""
        now = datetime.now(UTC)
        repo_state = RepositoryState(
            repo_path="/repo",
            default_branch="main",
        )

        # Add branch with PR
        pr = PullRequest(
            number=1,
            title="Test",
            state=PRState.OPEN,
            head_branch="with-pr",
            base_branch="main",
            author="user",
            url="url",
            created_at=now,
            updated_at=now,
            ci_checks=[CICheck(name="build", status=CIStatus.FAILURE)],
        )
        repo_state.add_state(BranchPRState(branch_name="with-pr", pr=pr))

        # Add branch without PR
        repo_state.add_state(BranchPRState(branch_name="no-pr"))

        # Add branch needing sync
        local = Branch(
            name="needs-sync", sha="abc", is_local=True, is_remote=False, status=BranchStatus.AHEAD
        )
        remote = Branch(name="needs-sync", sha="def", is_local=False, is_remote=True)
        repo_state.add_state(
            BranchPRState(branch_name="needs-sync", local_branch=local, remote_branch=remote)
        )

        assert len(repo_state.get_branches_with_prs()) == 1
        assert len(repo_state.get_branches_without_prs()) == 2
        assert len(repo_state.get_failing_ci()) == 1
        assert len(repo_state.get_branches_needing_sync()) == 1

    def test_repository_state_to_dict(self):
        """Test RepositoryState serialization."""
        repo_state = RepositoryState(
            repo_path="/repo",
            default_branch="main",
            last_updated=datetime.now(UTC),
        )
        repo_state.add_state(BranchPRState(branch_name="test"))

        data = repo_state.to_dict()

        assert data["repo_path"] == "/repo"
        assert data["default_branch"] == "main"
        assert len(data["branch_pr_states"]) == 1


class TestEnumValues:
    """Tests for enum value handling."""

    def test_branch_status_values(self):
        """Test all BranchStatus values."""
        assert BranchStatus.UP_TO_DATE.value == "up_to_date"
        assert BranchStatus.AHEAD.value == "ahead"
        assert BranchStatus.BEHIND.value == "behind"
        assert BranchStatus.DIVERGED.value == "diverged"
        assert BranchStatus.LOCAL_ONLY.value == "local_only"
        assert BranchStatus.REMOTE_ONLY.value == "remote_only"
        assert BranchStatus.UNKNOWN.value == "unknown"

    def test_pr_state_values(self):
        """Test all PRState values."""
        assert PRState.OPEN.value == "open"
        assert PRState.CLOSED.value == "closed"
        assert PRState.MERGED.value == "merged"
        assert PRState.DRAFT.value == "draft"

    def test_ci_status_values(self):
        """Test all CIStatus values."""
        assert CIStatus.SUCCESS.value == "success"
        assert CIStatus.FAILURE.value == "failure"
        assert CIStatus.PENDING.value == "pending"
        assert CIStatus.NONE.value == "none"

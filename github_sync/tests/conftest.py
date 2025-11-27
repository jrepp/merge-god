"""
Pytest fixtures for github_sync tests.

Provides Gitea testcontainer with pre-generated git scenarios.
"""

import asyncio
import subprocess
import tempfile
import time
from collections.abc import AsyncGenerator, Generator
from dataclasses import dataclass
from pathlib import Path

import httpx
import pytest
from testcontainers.core.container import DockerContainer

from github_sync import SyncStore

# =============================================================================
# Gitea Container Configuration
# =============================================================================

GITEA_IMAGE = "gitea/gitea:1.21"
GITEA_ADMIN_USER = "testadmin"
GITEA_ADMIN_PASSWORD = "testpassword123"
GITEA_ADMIN_EMAIL = "admin@test.local"


@dataclass
class GiteaInstance:
    """Running Gitea instance information."""

    host: str
    http_port: int
    ssh_port: int
    admin_user: str
    admin_password: str
    admin_token: str | None = None

    @property
    def base_url(self) -> str:
        return f"http://{self.host}:{self.http_port}"

    @property
    def api_url(self) -> str:
        return f"{self.base_url}/api/v1"

    @property
    def clone_url_base(self) -> str:
        return f"http://{self.admin_user}:{self.admin_password}@{self.host}:{self.http_port}"


class GiteaContainer(DockerContainer):
    """Gitea Docker container for testing."""

    def __init__(
        self,
        image: str = GITEA_IMAGE,
        http_port: int = 3000,
        ssh_port: int = 22,
    ):
        super().__init__(image)
        self.http_port = http_port
        self.ssh_port = ssh_port

        # Configure container
        self.with_exposed_ports(http_port, ssh_port)
        self.with_env("GITEA__security__INSTALL_LOCK", "true")
        self.with_env("GITEA__server__ROOT_URL", f"http://localhost:{http_port}/")
        self.with_env("GITEA__server__HTTP_PORT", str(http_port))
        self.with_env("GITEA__database__DB_TYPE", "sqlite3")
        self.with_env("GITEA__service__DISABLE_REGISTRATION", "false")
        self.with_env("GITEA__service__REQUIRE_SIGNIN_VIEW", "false")
        # Skip email validation for test accounts
        self.with_env("GITEA__service__REGISTER_EMAIL_CONFIRM", "false")

    def get_instance(self) -> GiteaInstance:
        """Get instance info after container is started."""
        host = self.get_container_host_ip()
        http_port = int(self.get_exposed_port(self.http_port))
        ssh_port = int(self.get_exposed_port(self.ssh_port))

        return GiteaInstance(
            host=host,
            http_port=http_port,
            ssh_port=ssh_port,
            admin_user=GITEA_ADMIN_USER,
            admin_password=GITEA_ADMIN_PASSWORD,
        )


def _wait_for_gitea_ready(instance: GiteaInstance, timeout: int = 60) -> None:
    """Wait for Gitea to be ready to accept requests."""
    start = time.time()
    while time.time() - start < timeout:
        try:
            response = httpx.get(f"{instance.base_url}/api/v1/version", timeout=5)
            if response.status_code == 200:
                return
        except (httpx.RequestError, httpx.TimeoutException):
            pass
        time.sleep(1)
    raise TimeoutError(f"Gitea did not become ready within {timeout} seconds")


def _create_admin_user(instance: GiteaInstance) -> None:
    """Create the admin user via Gitea CLI."""
    # This would typically be done via docker exec, but for simplicity
    # we'll use the API registration endpoint
    try:
        response = httpx.post(
            f"{instance.base_url}/user/sign_up",
            data={
                "user_name": instance.admin_user,
                "email": GITEA_ADMIN_EMAIL,
                "password": instance.admin_password,
                "retype": instance.admin_password,
            },
            follow_redirects=True,
            timeout=30,
        )
        # Registration might redirect or return various codes
    except httpx.RequestError:
        pass


def _create_access_token(instance: GiteaInstance) -> str:
    """Create an API access token for the admin user."""
    response = httpx.post(
        f"{instance.api_url}/users/{instance.admin_user}/tokens",
        auth=(instance.admin_user, instance.admin_password),
        json={"name": "test-token", "scopes": ["all"]},
        timeout=30,
    )
    if response.status_code == 201:
        return response.json()["sha1"]
    # Try without scopes for older Gitea versions
    response = httpx.post(
        f"{instance.api_url}/users/{instance.admin_user}/tokens",
        auth=(instance.admin_user, instance.admin_password),
        json={"name": "test-token-2"},
        timeout=30,
    )
    if response.status_code == 201:
        return response.json()["sha1"]
    raise RuntimeError(f"Failed to create token: {response.status_code} {response.text}")


# =============================================================================
# Git Scenario Fixtures
# =============================================================================


@dataclass
class GitRepo:
    """A test git repository."""

    path: Path
    name: str
    gitea_instance: GiteaInstance | None = None

    @property
    def clone_url(self) -> str:
        if self.gitea_instance:
            return f"{self.gitea_instance.clone_url_base}/{self.gitea_instance.admin_user}/{self.name}.git"
        return str(self.path)

    def run_git(self, *args: str, check: bool = True) -> subprocess.CompletedProcess:
        """Run a git command in this repository."""
        return subprocess.run(
            ["git", *args],
            cwd=self.path,
            capture_output=True,
            text=True,
            check=check,
        )


def _init_git_repo(path: Path, name: str) -> GitRepo:
    """Initialize a new git repository."""
    path.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "init"], cwd=path, check=True, capture_output=True)
    subprocess.run(
        ["git", "config", "user.email", "test@test.local"],
        cwd=path,
        check=True,
        capture_output=True,
    )
    subprocess.run(
        ["git", "config", "user.name", "Test User"], cwd=path, check=True, capture_output=True
    )
    return GitRepo(path=path, name=name)


def _create_gitea_repo(instance: GiteaInstance, name: str) -> None:
    """Create a repository on Gitea."""
    response = httpx.post(
        f"{instance.api_url}/user/repos",
        auth=(instance.admin_user, instance.admin_password),
        json={
            "name": name,
            "private": False,
            "auto_init": False,
        },
        timeout=30,
    )
    if response.status_code == 409:
        raise RuntimeError(f"Repo already exists (409): {name}")
    if response.status_code != 201:
        raise RuntimeError(f"Failed to create repo: {response.status_code} {response.text}")


# =============================================================================
# Pytest Fixtures
# =============================================================================


@pytest.fixture(scope="session")
def event_loop():
    """Create an event loop for the test session."""
    loop = asyncio.get_event_loop_policy().new_event_loop()
    yield loop
    loop.close()


@pytest.fixture(scope="session")
def gitea_container() -> Generator[GiteaContainer, None, None]:
    """
    Start a Gitea container for the test session.

    Uses random ports to avoid conflicts.
    """
    container = GiteaContainer()
    container.start()

    try:
        yield container
    finally:
        container.stop()


@pytest.fixture(scope="session")
def gitea_instance(gitea_container: GiteaContainer) -> GiteaInstance:
    """Get the Gitea instance info and ensure it's ready."""
    instance = gitea_container.get_instance()
    _wait_for_gitea_ready(instance)
    _create_admin_user(instance)

    # Create and store access token
    try:
        instance.admin_token = _create_access_token(instance)
    except Exception:
        # Token creation might fail on some Gitea versions, continue anyway
        pass

    return instance


@pytest.fixture
def temp_dir() -> Generator[Path, None, None]:
    """Create a temporary directory for test files."""
    with tempfile.TemporaryDirectory() as tmpdir:
        yield Path(tmpdir)


@pytest.fixture
async def sync_store(temp_dir: Path) -> AsyncGenerator[SyncStore, None]:
    """Create a temporary SyncStore for testing."""
    db_path = temp_dir / "test.db"
    store = SyncStore(db_path)
    await store.initialize()
    return store


# =============================================================================
# Pre-generated Git Scenario Fixtures
# =============================================================================


@pytest.fixture
def empty_repo(temp_dir: Path) -> GitRepo:
    """An empty git repository with just an initial commit."""
    repo = _init_git_repo(temp_dir / "empty-repo", "empty-repo")
    (repo.path / "README.md").write_text("# Empty Repo\n")
    repo.run_git("add", ".")
    repo.run_git("commit", "-m", "Initial commit")
    return repo


@pytest.fixture
def repo_with_branches(temp_dir: Path) -> GitRepo:
    """A repository with multiple branches."""
    repo = _init_git_repo(temp_dir / "branched-repo", "branched-repo")

    # Initial commit on main
    (repo.path / "README.md").write_text("# Branched Repo\n")
    repo.run_git("add", ".")
    repo.run_git("commit", "-m", "Initial commit")

    # Create feature branch
    repo.run_git("checkout", "-b", "feature/add-feature")
    (repo.path / "feature.txt").write_text("New feature\n")
    repo.run_git("add", ".")
    repo.run_git("commit", "-m", "Add feature")

    # Create another branch
    repo.run_git("checkout", "main")
    repo.run_git("checkout", "-b", "bugfix/fix-issue")
    (repo.path / "bugfix.txt").write_text("Bug fix\n")
    repo.run_git("add", ".")
    repo.run_git("commit", "-m", "Fix bug")

    # Back to main
    repo.run_git("checkout", "main")

    return repo


@pytest.fixture
def repo_with_history(temp_dir: Path) -> GitRepo:
    """A repository with substantial commit history."""
    repo = _init_git_repo(temp_dir / "history-repo", "history-repo")

    # Create multiple commits
    for i in range(10):
        (repo.path / f"file{i}.txt").write_text(f"Content {i}\n")
        repo.run_git("add", ".")
        repo.run_git("commit", "-m", f"Commit {i}")

    return repo


@pytest.fixture
def repo_with_conflicts(temp_dir: Path) -> GitRepo:
    """A repository with branches that would conflict on merge."""
    repo = _init_git_repo(temp_dir / "conflict-repo", "conflict-repo")

    # Initial commit
    (repo.path / "shared.txt").write_text("Original content\n")
    repo.run_git("add", ".")
    repo.run_git("commit", "-m", "Initial commit")

    # Create branch with one change
    repo.run_git("checkout", "-b", "branch-a")
    (repo.path / "shared.txt").write_text("Content from branch A\n")
    repo.run_git("add", ".")
    repo.run_git("commit", "-m", "Change from A")

    # Create another branch with conflicting change
    repo.run_git("checkout", "main")
    repo.run_git("checkout", "-b", "branch-b")
    (repo.path / "shared.txt").write_text("Content from branch B\n")
    repo.run_git("add", ".")
    repo.run_git("commit", "-m", "Change from B")

    repo.run_git("checkout", "main")
    return repo


@pytest.fixture
def repo_ahead_behind(temp_dir: Path) -> GitRepo:
    """A repository with local branch ahead/behind remote simulation."""
    repo = _init_git_repo(temp_dir / "ahead-behind-repo", "ahead-behind-repo")

    # Initial commits
    (repo.path / "README.md").write_text("# Ahead Behind Repo\n")
    repo.run_git("add", ".")
    repo.run_git("commit", "-m", "Initial commit")

    # Create a "remote" by cloning
    remote_path = temp_dir / "ahead-behind-remote"
    subprocess.run(
        ["git", "clone", "--bare", str(repo.path), str(remote_path)],
        check=True,
        capture_output=True,
    )

    # Add remote to original repo
    repo.run_git("remote", "add", "origin", str(remote_path))
    repo.run_git("fetch", "origin")
    repo.run_git("branch", "--set-upstream-to=origin/main", "main")

    # Make local commits (ahead)
    (repo.path / "local.txt").write_text("Local change\n")
    repo.run_git("add", ".")
    repo.run_git("commit", "-m", "Local commit")

    return repo


# =============================================================================
# Gitea Repo Creation Helpers
# =============================================================================


def _generate_unique_repo_name(prefix: str = "test-repo") -> str:
    """Generate a unique repo name with timestamp and random suffix."""
    import random
    import string

    suffix = "".join(random.choices(string.ascii_lowercase, k=8))
    return f"{prefix}-{int(time.time())}-{suffix}"


def _create_gitea_repo_with_retry(
    instance: GiteaInstance,
    prefix: str = "test-repo",
    max_attempts: int = 3,
) -> str:
    """Create a Gitea repo with retry on conflicts, returns repo name."""
    repo_name = _generate_unique_repo_name(prefix)

    for attempt in range(max_attempts):
        try:
            _create_gitea_repo(instance, repo_name)
            return repo_name
        except RuntimeError as e:
            if "409" in str(e) and attempt < max_attempts - 1:
                repo_name = _generate_unique_repo_name(prefix)
            else:
                raise

    return repo_name


def _push_with_retry(
    repo: GitRepo,
    ref: str,
    max_attempts: int = 3,
    set_upstream: bool = True,
) -> None:
    """Push a ref to origin with retry logic."""
    args = ["push"]
    if set_upstream:
        args.extend(["-u", "origin", ref])
    else:
        args.extend(["origin", ref])

    for attempt in range(max_attempts):
        result = repo.run_git(*args, check=False)
        if result.returncode == 0:
            return
        if attempt == max_attempts - 1:
            raise RuntimeError(
                f"Failed to push {ref} to Gitea after {max_attempts} attempts: {result.stderr}"
            )
        time.sleep(0.5)


def _setup_gitea_repo(
    instance: GiteaInstance,
    local_path: Path,
    prefix: str = "test-repo",
) -> GitRepo:
    """Create and setup a Gitea repo with initial commit."""
    repo_name = _create_gitea_repo_with_retry(instance, prefix)

    # Create local repo
    repo = _init_git_repo(local_path / repo_name, repo_name)
    repo.gitea_instance = instance

    # Initial commit
    (repo.path / "README.md").write_text(f"# {repo_name}\n")
    repo.run_git("add", ".")
    repo.run_git("commit", "-m", "Initial commit")

    # Add remote and push
    repo.run_git("remote", "add", "origin", repo.clone_url)
    _push_with_retry(repo, "main")

    return repo


def _setup_gitea_repo_with_pr(
    instance: GiteaInstance,
    local_path: Path,
    prefix: str = "test-pr-repo",
) -> tuple[GitRepo, int]:
    """Create a Gitea repo with an open pull request."""
    repo = _setup_gitea_repo(instance, local_path, prefix)

    # Create feature branch
    repo.run_git("checkout", "-b", "feature/test-pr")
    (repo.path / "feature.txt").write_text("Feature content\n")
    repo.run_git("add", ".")
    repo.run_git("commit", "-m", "Add feature")

    # Push feature branch
    _push_with_retry(repo, "feature/test-pr")

    # Wait for Gitea to process
    time.sleep(0.5)

    # Create PR via API with retry
    for attempt in range(3):
        response = httpx.post(
            f"{instance.api_url}/repos/{instance.admin_user}/{repo.name}/pulls",
            auth=(instance.admin_user, instance.admin_password),
            json={
                "title": "Test PR",
                "body": "This is a test pull request",
                "head": "feature/test-pr",
                "base": "main",
            },
            timeout=30,
        )
        if response.status_code == 201:
            break
        if attempt == 2:
            raise RuntimeError(f"Failed to create PR: {response.status_code} {response.text}")
        time.sleep(0.5)

    pr_number = response.json()["number"]

    # Back to main
    repo.run_git("checkout", "main")

    return repo, pr_number


# =============================================================================
# Session-Scoped Gitea Fixtures (Shared Across Tests)
# =============================================================================


@pytest.fixture(scope="session")
def gitea_session_dir(tmp_path_factory) -> Path:
    """Session-scoped temporary directory for Gitea test repos."""
    return tmp_path_factory.mktemp("gitea_repos")


@pytest.fixture(scope="session")
def gitea_shared_repo(
    gitea_instance: GiteaInstance,
    gitea_session_dir: Path,
) -> GitRepo:
    """
    Session-scoped shared repository for read-only tests.

    Use this for tests that only read state and don't modify the repo.
    """
    return _setup_gitea_repo(gitea_instance, gitea_session_dir, "shared-repo")


@pytest.fixture(scope="session")
def gitea_shared_repo_with_pr(
    gitea_instance: GiteaInstance,
    gitea_session_dir: Path,
) -> tuple[GitRepo, int]:
    """
    Session-scoped shared repository with PR for read-only tests.

    Use this for tests that only read PR state and don't modify it.
    """
    return _setup_gitea_repo_with_pr(gitea_instance, gitea_session_dir, "shared-pr-repo")


# =============================================================================
# Function-Scoped Gitea Fixtures (Fresh Per Test)
# =============================================================================


@pytest.fixture
def gitea_repo(
    gitea_instance: GiteaInstance,
    temp_dir: Path,
) -> GitRepo:
    """
    Function-scoped repository for tests that need to modify state.

    Creates a fresh repo for each test. For read-only tests, use
    gitea_shared_repo instead for better performance.
    """
    return _setup_gitea_repo(gitea_instance, temp_dir, "test-repo")


@pytest.fixture
def gitea_repo_with_pr(
    gitea_instance: GiteaInstance,
    temp_dir: Path,
) -> tuple[GitRepo, int]:
    """
    Function-scoped repository with PR for tests that need to modify state.

    Creates a fresh repo with PR for each test. For read-only tests, use
    gitea_shared_repo_with_pr instead for better performance.
    """
    return _setup_gitea_repo_with_pr(gitea_instance, temp_dir, "test-pr-repo")


# =============================================================================
# MCP Server Fixtures
# =============================================================================


@dataclass
class MCPClient:
    """
    A simple MCP client that communicates with an MCP server via STDIO.

    Uses standard Python libraries (asyncio, subprocess) to validate
    the server conforms to the MCP protocol.
    """

    process: asyncio.subprocess.Process
    _request_id: int = 0

    @classmethod
    async def spawn(cls, workspace: Path) -> "MCPClient":
        """Spawn an MCP server process and return a client connected to it."""
        import sys

        process = await asyncio.create_subprocess_exec(
            sys.executable,
            "-m",
            "github_sync.mcp_server",
            "--workspace",
            str(workspace),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        return cls(process=process)

    async def close(self):
        """Terminate the server process."""
        if self.process.returncode is None:
            self.process.terminate()
            try:
                await asyncio.wait_for(self.process.wait(), timeout=5.0)
            except asyncio.TimeoutError:
                self.process.kill()

    def _next_id(self) -> int:
        """Get next request ID."""
        self._request_id += 1
        return self._request_id

    async def send_request(self, method: str, params: dict | None = None) -> dict:
        """
        Send a JSON-RPC 2.0 request and wait for response.

        Args:
            method: The MCP method to call
            params: Optional parameters

        Returns:
            The JSON-RPC response dict
        """
        import json

        request_id = self._next_id()
        request = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
        }
        if params is not None:
            request["params"] = params

        # Send request
        request_line = json.dumps(request) + "\n"
        self.process.stdin.write(request_line.encode("utf-8"))
        await self.process.stdin.drain()

        # Read response
        response_line = await asyncio.wait_for(self.process.stdout.readline(), timeout=30.0)

        if not response_line:
            raise RuntimeError("Server closed connection")

        response = json.loads(response_line.decode("utf-8"))

        # Validate JSON-RPC 2.0 response format
        assert response.get("jsonrpc") == "2.0", "Response must be JSON-RPC 2.0"
        assert response.get("id") == request_id, "Response ID must match request ID"

        return response

    async def send_notification(self, method: str, params: dict | None = None):
        """Send a JSON-RPC notification (no response expected)."""
        import json

        notification = {
            "jsonrpc": "2.0",
            "method": method,
        }
        if params is not None:
            notification["params"] = params

        notification_line = json.dumps(notification) + "\n"
        self.process.stdin.write(notification_line.encode("utf-8"))
        await self.process.stdin.drain()

    async def initialize(self) -> dict:
        """Send initialize request and return server capabilities."""
        response = await self.send_request(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "test-client", "version": "1.0.0"},
            },
        )

        assert "result" in response, f"Initialize failed: {response}"

        # Send initialized notification
        await self.send_notification("notifications/initialized")

        return response["result"]

    async def list_tools(self) -> list[dict]:
        """Get list of available tools."""
        response = await self.send_request("tools/list")
        assert "result" in response, f"tools/list failed: {response}"
        return response["result"]["tools"]

    async def call_tool(self, name: str, arguments: dict | None = None) -> dict:
        """
        Call a tool and return the result.

        Args:
            name: Tool name
            arguments: Tool arguments

        Returns:
            The tool result (parsed from content)
        """
        import json

        response = await self.send_request(
            "tools/call", {"name": name, "arguments": arguments or {}}
        )

        assert "result" in response, f"Tool call failed: {response}"

        # Parse the content
        content = response["result"]["content"]
        assert len(content) > 0, "Tool must return content"
        assert content[0]["type"] == "text", "Content must be text type"

        # Parse JSON result
        return json.loads(content[0]["text"])

    async def ping(self) -> bool:
        """Send ping request."""
        response = await self.send_request("ping")
        return "result" in response


@pytest.fixture
async def mcp_workspace(temp_dir: Path) -> Path:
    """Create a workspace directory with git initialized for MCP tests."""
    workspace = temp_dir / "mcp_workspace"
    workspace.mkdir()

    subprocess.run(["git", "init"], cwd=workspace, check=True, capture_output=True)
    subprocess.run(
        ["git", "config", "user.email", "test@test.local"],
        cwd=workspace,
        check=True,
        capture_output=True,
    )
    subprocess.run(
        ["git", "config", "user.name", "Test User"],
        cwd=workspace,
        check=True,
        capture_output=True,
    )

    # Create initial commit
    (workspace / "README.md").write_text("# Test Repo\n")
    subprocess.run(["git", "add", "."], cwd=workspace, check=True, capture_output=True)
    subprocess.run(
        ["git", "commit", "-m", "Initial commit"],
        cwd=workspace,
        check=True,
        capture_output=True,
    )

    return workspace


@pytest.fixture
async def mcp_client(mcp_workspace: Path) -> MCPClient:
    """Spawn MCP server and return connected, initialized client."""
    client = await MCPClient.spawn(mcp_workspace)
    await client.initialize()
    yield client
    await client.close()


@pytest.fixture
async def mcp_client_uninit(mcp_workspace: Path) -> MCPClient:
    """Spawn MCP server and return connected client (not initialized)."""
    client = await MCPClient.spawn(mcp_workspace)
    yield client
    await client.close()

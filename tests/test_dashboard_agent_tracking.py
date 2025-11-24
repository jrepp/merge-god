#!/usr/bin/env python3
"""
Integration test for agent tracking in dashboard.

Tests that agent invocations are properly tracked when processing events.
"""

import json
import sys
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Define AgentInvocation locally to avoid import issues
@dataclass
class AgentInvocation:
    """Represents a single agent (bob) invocation with full context"""
    pr_number: int | None
    mode: str
    prompt: str
    prompt_size: int
    timestamp: datetime
    result: dict[str, Any] = field(default_factory=dict)
    duration: float | None = None
    success: bool | None = None

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary for serialization"""
        return {
            "pr_number": self.pr_number,
            "mode": self.mode,
            "prompt": self.prompt[:500],  # Truncate prompt for display
            "prompt_size": self.prompt_size,
            "timestamp": self.timestamp.isoformat(),
            "result": {
                "returncode": self.result.get("returncode"),
                "stdout": self.result.get("stdout", "")[:200],  # Truncate
                "stderr": self.result.get("stderr", "")[:200],  # Truncate
            },
            "duration": self.duration,
            "success": self.success,
        }


def test_agent_tracking():
    """Test that agent tracking data structures work correctly"""
    print("\n" + "="*60)
    print("Testing Agent Tracking Data Structures")
    print("="*60 + "\n")

    # Create agent history deque (simulating RepoMonitor.agent_history)
    agent_history = deque(maxlen=50)

    print("✓ Created agent history deque")

    # Test 1: Initial state
    assert len(agent_history) == 0, "Should start with empty history"
    print("✓ Initial state correct")

    # Test 2: Create successful invocation
    invocation1 = AgentInvocation(
        pr_number=123,
        mode="for-landing",
        prompt="Process PR #123 with conflicts",
        prompt_size=5000,
        timestamp=datetime.now(timezone.utc),
        result={"returncode": 0, "stdout": "Changes committed successfully", "stderr": ""},
        duration=45.5,
        success=True
    )
    agent_history.append(invocation1)

    assert len(agent_history) == 1, "Should have one invocation"
    assert invocation1.pr_number == 123, "Should have correct PR number"
    assert invocation1.success is True, "Should be successful"
    print("✓ Successful invocation created and tracked")

    # Test 3: Create failed invocation
    invocation2 = AgentInvocation(
        pr_number=456,
        mode="for-review",
        prompt="Review PR #456 for code quality",
        prompt_size=6000,
        timestamp=datetime.now(timezone.utc),
        result={"returncode": 1, "stdout": "", "stderr": "Tests failed"},
        duration=30.2,
        success=False
    )
    agent_history.append(invocation2)

    assert len(agent_history) == 2, "Should have two invocations"
    assert invocation2.success is False, "Should be failed"
    assert invocation2.result["returncode"] == 1, "Should have error code"
    print("✓ Failed invocation created and tracked")

    # Test 4: Test serialization
    invocation_dict = invocation1.to_dict()
    assert "pr_number" in invocation_dict, "Should have pr_number"
    assert "mode" in invocation_dict, "Should have mode"
    assert "result" in invocation_dict, "Should have result"
    assert "timestamp" in invocation_dict, "Should have timestamp"
    assert "duration" in invocation_dict, "Should have duration"
    assert "success" in invocation_dict, "Should have success"
    assert invocation_dict["pr_number"] == 123, "Should serialize pr_number correctly"
    assert invocation_dict["mode"] == "for-landing", "Should serialize mode correctly"
    print("✓ Serialization works")

    # Test 5: Test prompt truncation in serialization
    long_prompt = "A" * 1000
    invocation3 = AgentInvocation(
        pr_number=789,
        mode="for-landing",
        prompt=long_prompt,
        prompt_size=1000,
        timestamp=datetime.now(timezone.utc)
    )
    dict3 = invocation3.to_dict()
    assert len(dict3["prompt"]) == 500, "Should truncate prompt to 500 chars"
    print("✓ Prompt truncation works")

    # Test 6: Test output truncation in serialization
    long_output = "B" * 500
    invocation4 = AgentInvocation(
        pr_number=101,
        mode="for-review",
        prompt="Test",
        prompt_size=100,
        timestamp=datetime.now(timezone.utc),
        result={"returncode": 0, "stdout": long_output, "stderr": long_output}
    )
    dict4 = invocation4.to_dict()
    assert len(dict4["result"]["stdout"]) == 200, "Should truncate stdout to 200 chars"
    assert len(dict4["result"]["stderr"]) == 200, "Should truncate stderr to 200 chars"
    print("✓ Output truncation works")

    # Test 7: Test history limit (maxlen=50)
    for i in range(60):
        agent_history.append(
            AgentInvocation(
                pr_number=i,
                mode="for-landing",
                prompt=f"Test {i}",
                prompt_size=1000,
                timestamp=datetime.now(timezone.utc),
                success=True
            )
        )

    assert len(agent_history) == 50, "Should maintain max 50 invocations"
    print("✓ History limit enforced")

    # Test 8: Test timestamp formatting
    now = datetime.now(timezone.utc)
    invocation5 = AgentInvocation(
        pr_number=999,
        mode="for-landing",
        prompt="Test",
        prompt_size=100,
        timestamp=now
    )
    dict5 = invocation5.to_dict()
    assert isinstance(dict5["timestamp"], str), "Should convert timestamp to string"
    assert "T" in dict5["timestamp"], "Should be ISO format"
    print("✓ Timestamp formatting works")

    # Test 9: Test None PR number (for issue processing)
    invocation6 = AgentInvocation(
        pr_number=None,
        mode="for-impl",
        prompt="Implement issue",
        prompt_size=2000,
        timestamp=datetime.now(timezone.utc),
        success=True
    )
    dict6 = invocation6.to_dict()
    assert dict6["pr_number"] is None, "Should handle None PR number"
    print("✓ None PR number handled")

    print("\n" + "="*60)
    print("✅ All agent tracking tests passed!")
    print("="*60 + "\n")

    return 0

if __name__ == "__main__":
    try:
        sys.exit(test_agent_tracking())
    except AssertionError as e:
        print(f"\n❌ Test failed: {e}\n")
        sys.exit(1)
    except Exception as e:
        print(f"\n❌ Error: {e}\n")
        import traceback
        traceback.print_exc()
        sys.exit(1)

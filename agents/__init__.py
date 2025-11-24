"""
Agent abstraction layer for PR processing.

This module provides a clean abstraction over the Claude Agent SDK
for processing pull requests with structured tasks, streaming updates,
and tool calling capabilities.
"""

from .callbacks import AgentCallbacks, PRProcessingCallbacks
from .claude_agent import (
    AgentAction,
    AgentEvent,
    AgentTask,
    PRAgent,
    PRContext,
    ProcessingResult,
    create_claude_client,
    get_model_name,
)

__all__ = [
    "AgentAction",
    "AgentCallbacks",
    "AgentEvent",
    "AgentTask",
    "PRAgent",
    "PRContext",
    "PRProcessingCallbacks",
    "ProcessingResult",
    "create_claude_client",
    "get_model_name",
]

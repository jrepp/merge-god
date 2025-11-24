"""
Agent abstraction layer for PR processing.

This module provides a clean abstraction over the Claude Agent SDK
for processing pull requests with structured tasks, streaming updates,
and tool calling capabilities.
"""

from .claude_agent import (
    PRAgent,
    AgentAction,
    AgentTask,
    AgentEvent,
    PRContext,
    ProcessingResult,
    create_claude_client,
    get_model_name,
)
from .callbacks import AgentCallbacks, PRProcessingCallbacks

__all__ = [
    "PRAgent",
    "AgentAction",
    "AgentTask",
    "AgentEvent",
    "PRContext",
    "ProcessingResult",
    "AgentCallbacks",
    "PRProcessingCallbacks",
    "create_claude_client",
    "get_model_name",
]

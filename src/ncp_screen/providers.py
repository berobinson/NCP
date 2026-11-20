"""Model-specific API calls. Each factory returns screen(user_message) -> (result, usage)."""

from __future__ import annotations

import json

from .rubric import Rubric

TOOL_NAME = "record_screening_decision"


def make_claude(rubric: Rubric, model: str, temperature: float | None = 0.0,
                max_tokens: int = 1024):
    import anthropic

    client = anthropic.Anthropic(max_retries=8)  # retries 429/5xx with backoff
    tool = {"name": TOOL_NAME,
            "description": "Record the structured screening decision for one record.",
            "input_schema": rubric.schema}
    # The rubric is identical for every call, so cache it (cheaper input tokens).
    system = [{"type": "text", "text": rubric.system_prompt,
               "cache_control": {"type": "ephemeral"}}]

    def screen(user_message: str):
        kwargs = dict(model=model, max_tokens=max_tokens, system=system, tools=[tool],
                      tool_choice={"type": "tool", "name": TOOL_NAME},
                      messages=[{"role": "user", "content": user_message}])
        if temperature is not None:
            kwargs["temperature"] = temperature
        msg = client.messages.create(**kwargs)
        block = next((b for b in msg.content if b.type == "tool_use"), None)
        if block is None:
            raise ValueError(f"no structured output (stop_reason={msg.stop_reason})")
        u = msg.usage
        return dict(block.input), {
            "input": u.input_tokens, "output": u.output_tokens,
            "cache_read": getattr(u, "cache_read_input_tokens", 0) or 0,
            "cache_write": getattr(u, "cache_creation_input_tokens", 0) or 0}

    return screen


def make_openai(rubric: Rubric, model: str, reasoning_effort: str | None = "medium",
                temperature: float | None = None, max_output_tokens: int = 4000):
    from openai import OpenAI

    client = OpenAI(max_retries=8)
    text_format = {"format": {"type": "json_schema", "name": "screening_decision",
                              "schema": rubric.schema, "strict": True}}

    def screen(user_message: str):
        kwargs = dict(model=model, instructions=rubric.system_prompt, input=user_message,
                      text=text_format, max_output_tokens=max_output_tokens, store=False)
        if reasoning_effort and reasoning_effort != "none":
            kwargs["reasoning"] = {"effort": reasoning_effort}
        if temperature is not None:  # reasoning models reject temperature
            kwargs["temperature"] = temperature
        resp = client.responses.create(**kwargs)
        if resp.status != "completed":
            raise ValueError(f"status={resp.status} ({getattr(resp, 'incomplete_details', None)})")
        u = resp.usage
        cached = getattr(getattr(u, "input_tokens_details", None), "cached_tokens", 0) or 0
        return json.loads(resp.output_text), {
            "input": u.input_tokens, "output": u.output_tokens, "cache_read": cached}

    return screen

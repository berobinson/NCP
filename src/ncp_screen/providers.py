"""Model-specific API calls. Each factory returns screen(user_message) -> (result, usage)."""

from __future__ import annotations

import json

from .rubric import Rubric

def make_claude(rubric: Rubric, model: str, temperature: float | None = 0.0,
                max_tokens: int = 1024):
    import anthropic

    client = anthropic.Anthropic(max_retries=8)  # retries 429/5xx with backoff
    # The rubric is identical for every call, so cache it (cheaper input tokens).
    system = [{"type": "text", "text": rubric.system_prompt,
               "cache_control": {"type": "ephemeral"}}]
    use_temp = {"on": temperature is not None}

    def screen(user_message: str):
        kwargs = dict(model=model, max_tokens=max_tokens, system=system,
                      output_config={"format": {"type": "json_schema",
                                                "schema": rubric.schema}},
                      messages=[{"role": "user", "content": user_message}])
        if use_temp["on"]:
            kwargs["temperature"] = temperature
        try:
            msg = client.messages.create(**kwargs)
        except anthropic.BadRequestError as e:
            # Some newer models fix sampling settings; retry once without temperature.
            if use_temp["on"] and "temperature" in str(e).lower():
                use_temp["on"] = False
                kwargs.pop("temperature")
                msg = client.messages.create(**kwargs)
            else:
                raise
        if msg.stop_reason == "refusal":
            raise ValueError("model declined to answer (refusal)")
        if msg.stop_reason == "max_tokens":
            raise ValueError("answer cut off: raise max_tokens in config.toml")
        block = next((b for b in msg.content if b.type == "text"), None)
        if block is None:
            raise ValueError(f"no output text (stop_reason={msg.stop_reason})")
        u = msg.usage
        return json.loads(block.text), {
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

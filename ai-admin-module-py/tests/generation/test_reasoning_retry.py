from app.services.generation.stream import _stream_chat_completions


def test_mandatory_reasoning_retry_preserves_model_and_budget(monkeypatch):
    calls = []

    class Response:
        def __init__(self, code, text=''):
            self.status_code, self.text = code, text
        def close(self): pass
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def iter_lines(self, **kwargs):
            yield 'data: {"choices":[{"delta":{"content":"case"}}]}'
            yield 'data: [DONE]'

    def post(*args, **kwargs):
        calls.append(kwargs['json'].copy())
        return Response(400, 'Reasoning is mandatory') if len(calls) == 1 else Response(200)

    monkeypatch.setattr('app.services.generation.stream.requests.post', post)
    result = ''.join(_stream_chat_completions(
        {'label': 'OpenRouter', 'url': 'https://example.invalid', 'headers': {},
         'model': 'openrouter/free', 'timeout': 10, 'token_field': 'max_tokens',
         'usage': {'reasoning': {'enabled': False}}},
        system_prompt='test', user_input='test', temperature=0.2, max_tokens=4096, timeout=10))
    assert result == 'case'
    assert len(calls) == 2
    assert calls[1]['reasoning'] == {'enabled': True}
    assert calls[1]['model'] == calls[0]['model']
    assert calls[1]['max_tokens'] == calls[0]['max_tokens']

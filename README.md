# in-context

A [pi](https://github.com/earendil-works/pi) extension that puts extra text into the model's context in two places:

- **system**: injected once per session. Pick one of two modes. By default it is a section appended to the end of pi's system prompt. It can instead be a hidden message stored before the first user message of a new session.
- **tail**: a block appended after the latest message on **every model request**. It is never saved to history, which makes it a good fit for external RAG or memory lookups.

Each place takes a list of sources. A source can be static text, a file, or a REST endpoint.

```text
system prompt … <cwd>…</cwd> <in-context>  system sources  </in-context>   (mode "system")
history …
latest user message
<in-context>  tail sources  </in-context>      ← this request only
```

## Install

```bash
cd ~/.pi/agent/extensions
git clone https://github.com/Twinkle661/in-context
cp in-context/config.example.json in-context/config.json
```

No `npm install` is needed. The extension has no runtime dependencies.

`pi install git:github.com/Twinkle661/in-context` also works. pi manages that checkout and resets it on update, so put your config in `~/.pi/agent/in-context.json` instead.

## Config lookup

The first file found is used as the base config:

1. `$PI_IN_CONTEXT_CONFIG`
2. `~/.pi/agent/in-context.json`
3. `~/.pi/agent/extensions/in-context/config.json`

After that, `<project>/.pi/in-context.json` is merged on top, but only if the project is trusted. Its `sources` are added after the base ones, and its scalar settings override.

If both 2 and 3 exist, a warning says which one is shadowed. Run `/reload` after editing.

## Sources

Every source has exactly one of `text`, `file`, or `url`. Both `system` and `tail` accept all three kinds.

| Field | Applies to | Default | Notes |
|---|---|---|---|
| `text` | text | | `{{var}}` placeholders are filled in |
| `file` | file | | Absolute, `~/…`, or relative to the config file |
| `url` | http | | `{{var}}` placeholders are filled in (URL-encoded); `${env:NAME}` is expanded |
| `method` | http | `GET` | `GET`, `POST`, or `PUT` |
| `headers` | http | | `${env:NAME}` is expanded. If a referenced variable is missing, the source is skipped |
| `body` | http | | A JSON value. A string that is exactly `"{{var}}"` becomes the raw value (arrays survive). Other strings are interpolated |
| `parse` | http | `json` | `json` reads `field`; `text` uses the whole response body |
| `field` | http | `content` | Dot path into the response, e.g. `data.items.0.text`. Non-string values are JSON-encoded |
| `timeoutMs` | http | `10000` | |
| `maxChars` | all | `12000` | Longer results are truncated and marked |
| `wrap` | all | | Wraps this item in `<wrap>…</wrap>` |
| `id` | all | position + url | Key under which a system snapshot stores this source's result |
| `enabled` | all | `true` | |

Sources resolve concurrently and are joined in list order with blank lines between them. A source that fails or returns nothing is left out.

### Variables

| Variable | system | tail |
|---|---|---|
| `session_id`, `cwd`, `model`, `now` | ✓ (frozen when the session's snapshot is created) | ✓ |
| `user_message` | | ✓ Text of the latest user message |
| `recent` | | ✓ Last `recentCount` messages as `[{role, text}]` |
| `turn_index` | | ✓ |

## system

| Field | Default | |
|---|---|---|
| `enabled` | `true` | |
| `mode` | `system` | `system` or `message`, see below |
| `wrap` | `in-context` | Wrapper tag. In `system` mode it is also pi's section name, so it must match `^[a-z][a-z0-9_-]*$` and cannot be `null`. In `message` mode, `null` means no wrapper |
| `sources` | `[]` | |

### mode `system`

The text is a section at the end of pi's system prompt.

Remote (`url`) sources are fetched when the session starts and saved in a session entry. That entry is never sent to the model.
- `resume`, `fork`, and `reload` reuse the saved result. `/in-context refresh` fetches again.
- `text` and `file` sources are read fresh on every run, so config edits take effect after `/reload`.
- A source that failed is retried on the next message, at most once a minute.

Why the section is declared on every run: pi's system prompt is declarative. pi compares the declared sections with the system message already in the transcript.
- An unchanged section sends nothing, and the prompt cache holds.
- A changed section sends a small patch.
- A section that is no longer declared is removed.

The transcript's system message is what persists. Declaring the section each run keeps it there. Compaction never touches it.

### mode `message`

On a **new** session, the text is stored as a hidden custom message just before the first user message. The model sees it as a user message. From then on it is ordinary history:
- It is never injected again, and never refreshed.
- Compaction summarises it like any other message.
- Sessions that already have a conversation are left untouched.

The message is stored from the `input` hook, while pi is still idle, which places it ahead of the prompt. A run that skips that hook, such as one started by another extension's custom message, gets the message right after its starting message instead.

Failed `url` sources get one more try at the first message. If they still fail, they are left out.

## tail

| Field | Default | |
|---|---|---|
| `enabled` | `true` | |
| `refresh` | `user_message` | `user_message`: fetch once per user message and reuse it for every request in a tool loop. `request`: fetch before every request |
| `placement` | `merge` | `merge`: append a text block to the trailing user message, or add a separate user message when the transcript ends with something else (e.g. a tool result). `separate`: always add a separate user message |
| `wrap` | `in-context` | Outer tag. `null` disables it |
| `recentCount` | `6` | Size of `{{recent}}` |
| `sources` | `[]` | |

The block is added in pi's `context_with_system` hook. That hook shapes one provider request and is not persisted, so the block never enters the session file or later requests. Only the cached tail of the prompt is invalidated.

## Failure behaviour

Every failure is fail-open: timeouts, HTTP errors, bad JSON, missing fields, and missing env vars. The source is skipped, a warning is logged, and the reply proceeds without it.

Warnings never go to stdout, because stdout is the protocol stream in RPC mode. `log` controls where they go:
- `auto`: TUI notification in interactive mode, stderr otherwise
- `ui`, `stderr`, or `off`

## Commands

- `/in-context status`: config files in use, system snapshot, last tail injection (size, time, errors)
- `/in-context refresh`: mode `system` only. Re-fetch system url sources. Takes effect from the next message. Values that fail to refresh keep their previous result
- `/in-context preview <message>`: show what tail would inject for `<message>`

With `"debug": true`, each tail fetch is recorded as an `in-context/tail-trace` session entry. Trace entries are never sent to the model.

## Example: per-message RAG endpoint

```json
{
  "tail": {
    "sources": [{
      "url": "https://example.com/api/prompt",
      "method": "POST",
      "headers": { "Authorization": "Bearer ${env:EXAMPLE_API_KEY}" },
      "body": { "user_message": "{{user_message}}" },
      "field": "content"
    }]
  }
}
```

## Development

```bash
npm install
npm run typecheck
npm test     # unit tests + an end-to-end run of a real pi process against mock servers
```

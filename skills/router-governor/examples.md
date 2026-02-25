# Router Governor Examples

## Example: simple question

- User: "What is sqlite-vec called in SQLite?"
- Action: Answer directly, no escalation needed.

## Example: complex debugging

- User: "Why is cloud bot timing out repeatedly? Analyze logs and propose fixes."
- Action: Escalate to worker model (`default`) immediately.

## Example: loop prevention

- User: "Find exact name of vector extension."
- If one web search already done and next search is same intent:
  - Do not repeat.
  - Answer from current evidence or escalate.

## Example: missing file retry

- `read` fails with ENOENT for same path twice:
  - Stop retries.
  - Escalate with concise failure context.

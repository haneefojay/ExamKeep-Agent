# ExamKeep outreach agent

Standalone marketing research and drafting agent with an approval queue. It runs on its own AI key,
so it does not depend on anyone's Claude plan. It **drafts only**: it never sends a message, and a
person copies each approved draft and sends it from the real account.

Not part of the ExamKeep exam platform. It holds no student, staff or exam data: only schools'
public details and our own drafts.

## What it does

1. **Find**: asks Gemini (with Google Search) for schools that match the criteria on the Criteria tab.
2. **Read**: opens each school's own public page, checks the page mentions the school, and extracts
   the facts with a cheap model. Pages on private or local addresses are refused.
3. **Draft**: writes a three-line message from the standing brief. A draft containing a price, a
   link, a naira amount or the pilot school's name is rejected.
4. **Approve**: the queue page. Approve, edit or reject; then copy, send by hand, mark sent, replied,
   demo booked. Every action is in the Log.

## Run

```sh
OUTREACH_PASSWORD='12+ characters' GEMINI_API_KEY='...' MONTHLY_CAP_USD=5 node server.mjs
```

Needs Node 22 or newer. No dependencies. State is one JSON file (`data/state.json`; set `DATA_FILE`
to move it). It listens on `127.0.0.1:8787`: put a TLS reverse proxy in front (Caddy) and sign in
with any username and the password. Never commit the key or the password.

| Setting | Default | Meaning |
| --- | --- | --- |
| `GEMINI_API_KEY` | none | Required to find or draft. |
| `MONTHLY_CAP_USD` | 5 | The agent stops when its estimated spend reaches this. |
| `GEMINI_MODEL_SEARCH`, `_READ`, `_DRAFT` | `gemini-2.5-flash` | Swap any stage's model on its own. |
| `PRICE_IN_PER_M_USD`, `PRICE_OUT_PER_M_USD`, `PRICE_PER_SEARCH_USD` | 1, 5, 0.035 | Estimates. Set the provider's real rates; the defaults are deliberately high. |

The spend shown is an estimate from token counts. For a hard limit, use prepaid credit with the
provider so nothing is billed past the balance.

## Test

`node --test test/` (the model is mocked; no key needed). Not yet run against the real Gemini API.

# Cursor Model Cost

A [Tampermonkey](https://www.tampermonkey.net/) userscript that adds a **Cost** column to [cursor.com/dashboard/usage](https://cursor.com/dashboard/usage) and [cursor.com/dashboard/billing](https://cursor.com/dashboard/billing). It shows the underlying model API cost (USD) of each request (or per-model totals on the billing page), computed from `inputTokens / outputTokens / cacheReadTokens / cacheWriteTokens`.

## Why?

Cursor's dashboard already shows a per-row token total and reveals the input / output / cache‑read / cache‑write breakdown only via a hover tooltip — it never tells you the dollar value of a single request, only the abstract "Cursor request units" or the discounted price Cursor charges you. This script computes the **list price you would have paid calling the upstream model API directly**, so you can see at a glance how much each request would cost outside the Cursor subscription.

## How it works

Rather than scraping the hover tooltip DOM (which is fragile and only populates on hover), the script patches `window.fetch` and `XMLHttpRequest` at `document-start` to capture the JSON the dashboard itself fetches:

| Endpoint | Used by | Captured shape |
|---|---|---|
| `POST /api/dashboard/get-filtered-usage-events` | Usage tab | `usageEvents[].tokenUsage` + `model` + `timestamp` |
| `POST /api/dashboard/get-aggregated-usage-events` | Billing tab | `aggregations[]` per `modelIntent` already summed for the cycle |

For the Usage table each row is matched back to a captured event by the full timestamp embedded in the Date cell's `title` attribute (`May 4, 2026, 03:18:12 AM GMT+8`) plus the displayed model name. For the Billing table each per-model row is matched by `modelIntent`, so no extra requests are issued.

A `MutationObserver` reruns rendering whenever the table is re-paginated.

## Supported models & pricing (USD per 1M tokens)

| Model | Input | Cache write | Cache read | Output | Source |
|---|---|---|---|---|---|
| `gpt-5.5` | $5.00 | $5.00¹ | $0.50 | $30.00 | [OpenAI](https://developers.openai.com/api/docs/models/gpt-5.5) |
| `claude-opus-4.7` | $5.00 | $6.25² | $0.50 | $25.00 | [Anthropic](https://platform.claude.com/docs/en/about-claude/pricing) |
| `composer-2` | $0.50 | $0.50¹ | $0.20 | $2.50 | [Cursor](https://cursor.com/docs/models/cursor-composer-2) |
| `composer-2-fast` | $1.50 | $1.50¹ | $0.35 | $7.50 | [Cursor](https://cursor.com/docs/models/cursor-composer-2) |

¹ The provider does not list a separate cache‑write rate, so the script charges cache writes at the regular input rate.
² 5‑minute TTL (Anthropic's platform default).

Suffix variants such as `gpt-5.5-medium`, `claude-opus-4-7-thinking-xhigh`, `composer-2-fast` are normalized to their pricing key by the `MODEL_ALIASES` table at the top of the script. Models that are not in the table render as `n/a` (and are excluded from the Billing total).

Numbers under $1 are rendered in the secondary text color so it's easy to skim the row that actually cost real money.

## Install

1. Install the [Tampermonkey](https://www.tampermonkey.net/) extension.
2. Open the [raw script](./cursor-model-cost.user.js) in your browser — Tampermonkey will offer to install it. Or in the Tampermonkey dashboard pick *Utilities → Import from file* and choose `cursor-model-cost.user.js`.
3. Visit https://cursor.com/dashboard/usage or https://cursor.com/dashboard/billing — the table grows a **Cost** column. Hover any cost cell to see the tokens × unit‑price breakdown that produced the number.

## Adding a new model

When Cursor releases a new pricing tier you only need to edit two tables at the top of `cursor-model-cost.user.js`:

```js
const MODEL_PRICING = {
  // ...
  "gpt-6": { input: 8.0, cacheWrite: 8.0, cacheRead: 0.8, output: 40.0 },
};

const MODEL_ALIASES = [
  // ...
  [/^gpt[-_]?6\b/i, "gpt-6"],
];
```

The first regex that matches wins, so list more specific patterns (e.g. `gpt-6-thinking`) before more general ones.

## Caveats

- The cost shown is the **upstream provider list price**, not what Cursor actually charges you (which is usually much lower thanks to Cursor's negotiated rates and your subscription).
- Cache‑write rates depend on TTL for some providers; the script picks the most common default (5 min for Anthropic).
- The script never sends data anywhere; it only reads the JSON your browser already fetched for the dashboard.

## License

MIT.

---
name: aihot
description: Read the internal AI hotboard auth-required API and render today AI items or daily brief as Chinese markdown. Use only when a request has both an AI/hotboard keyword and a today/daily/hot-topic keyword, for example "今天 AI 圈", "AI 日报", "AI 热点", "ai-hotboard 今天", or "/aihot today".
---

# AI Hotboard Skill

Use this skill to answer internal company questions about the AI 热点看板. This skill is read-only: call only the auth-required GET endpoints listed below and render the returned JSON as concise Chinese markdown.

## Endpoint Allowlist

**唯一可调用 endpoints**:

- `GET /api/aihot/items`
- `GET /api/aihot/daily`
- `GET /api/aihot/dailies`

All other endpoints must be refused, even if the user explicitly asks. This includes retry, refresh, ingest, vote, health, write-side, and POST endpoints such as `/api/sources/health/retry`, `/api/hotboard/zara/refresh`, `/api/hotboard/wechat/ingest`, `/api/hotboard/vote`, and `/api/public/*`.

## Base URL

- Production: `https://aihotboard.tangyuanjc.com`
- Local development: `http://127.0.0.1:3000`

Prefer production unless the user explicitly asks for local development data. Send `User-Agent: aihot-skill/1.0` for analytics only; user agent is not an access-control mechanism.

## Authentication and View

API calls must carry the ai-hotboard cookie. If no valid cookie is available, log in through the normal ai-hotboard auth flow using the configured password from `~/.hermes/data/internal/passwords-2026-04-27.txt`; never print or render the password or cookie.

Default output is member view. Owner-only fields such as `source_id` are intentionally absent unless the authenticated session has owner role. Always display the `view` field returned by the response so the reader knows which view was used.

## Trigger Words

Use this skill only when the user request contains both groups:

1. AI/hotboard keyword: `AI`, `hotboard`, `热点看板`, `ai-hotboard`, `AI 热点`
2. Today/daily/hot-topic keyword: `今天`, `日报`, `动态`, `热点`, `today`, `daily`

Positive examples:

- `今天 AI 圈`
- `AI 日报`
- `AI 热点`
- `热点看板今天有什么动态`
- `ai-hotboard today`
- `/aihot today`

Negative examples that must not trigger this skill:

- `今天日报`
- `写个日报`
- `会议日报`
- `standup 日报`
- Any bare `日报` request without an AI/hotboard keyword.

## Routing

Route by intent, not exact wording:

- User asks `今天 AI 圈`, `AI 热点`, `ai-hotboard 今天`, `/aihot today`, or what AI/hotboard items to read today: call `GET /api/aihot/items?date=today&limit=50`.
- User asks `AI 日报`, `热点看板日报`, or asks for a grouped AI/hotboard daily brief: call `GET /api/aihot/daily?date=today`.
- User asks for recent AI/hotboard daily archives or available dates: call `GET /api/aihot/dailies`.
- User provides a concrete date like `2026-05-10`: pass it as `date=2026-05-10`.

## Rendering Rules

After calling the API, render the JSON yourself as Chinese markdown.

### Markdown Escaping

External content from X, WeChat, Zara, YouTube, or other upstream sources is untrusted. Before rendering `title`, `summary`, section text, source labels, or other external strings:

- Escape Markdown control characters: asterisk, underscore, backtick, heading marker, blockquote marker, table pipe, and backslash.
- Remove HTML tags, code fences, and newlines; collapse whitespace to a single space.
- Render URLs as plain links on their own line. Do not nest external URLs inside Markdown link syntax.
- Do not render raw HTML, code blocks, or user-supplied Markdown formatting from external content.

### Items Output

For `/api/aihot/items`, use this shape:

```markdown
## 今天 AI 圈

数据日期：<date> · 视图：<view> · 条目：<count>

1. **<escaped title>**
   - 来源：<escaped source> · 分数：<signal_score> · 时间：<timestamp>
   - 摘要：<escaped summary>
   - 链接：<url>
```

If `items` is empty:

```markdown
## 今天 AI 圈

<date> 暂无可展示条目。视图：<view>
```

### Daily Output

For `/api/aihot/daily`, group by returned sections:

```markdown
## AI 日报 · <date>

视图：<view>

### <section title>

- **<escaped item title>** — <escaped summary>
  - 来源：<escaped source> · 分数：<signal_score> · 链接：<url>
```

Keep the answer compact. Prefer the top 3-5 items per section unless the user asks for all.

### Dailies Output

For `/api/aihot/dailies`, render:

```markdown
## AI Hotboard 近 7 天

- <date> · <count> 条
```

## Error Handling

- If the API returns 401, say ai-hotboard auth is required and retry only after a valid cookie is available.
- If the API returns 403, report the endpoint and status; do not retry by changing user agent.
- If the API returns 503, say the API is rate limited and ask the user to retry later.
- If the API returns 5xx, do not invent a summary; report the endpoint and status.

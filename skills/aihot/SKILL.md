---
name: aihot
description: Read the internal AI hotboard public API and render today AI items or daily brief as Chinese markdown. Use when the user asks "今天 AI 圈", "AI 日报", "AI 热点", "ai-hotboard 今天", or runs "/aihot today".
---

# AI Hotboard Skill

Use this skill to answer internal company questions about the AI 热点看板. This skill is read-only: call public GET endpoints and render the returned JSON as concise Chinese markdown.

## Base URL

- Production: `https://aihotboard.tangyuanjc.com`
- Local development: `http://127.0.0.1:3000`

Prefer production unless the user explicitly asks for local development data.

Send a non-crawler user agent, for example `User-Agent: aihot-skill/1.0`, so the public API can distinguish this skill from generic crawlers.

## Trigger Words

Use this skill when the user asks any of these:

- `今天 AI 圈`
- `AI 日报`
- `AI 热点`
- `ai-hotboard 今天`
- `/aihot today`
- Similar Chinese requests for today AI hotboard items or daily AI brief.

## Routing

Route by intent, not exact wording:

- User asks `今天 AI 圈`, `AI 热点`, `ai-hotboard 今天`, `/aihot today`, or what to read today: call `GET /api/public/items?date=today&limit=50`.
- User asks `AI 日报`, `日报`, `今日日报`, or asks for a grouped daily brief: call `GET /api/public/daily?date=today`.
- User asks for recent daily archives or available dates: call `GET /api/public/dailies`.
- User provides a concrete date like `2026-05-10`: pass it as `date=2026-05-10`.

## Do Not Call

These are explicit anti-routes:

- Do not call any retry endpoint.
- Do not trigger source health retry, source refresh, ingestion, vote, or write-side APIs.
- Do not call `/api/sources/health/retry`, `/api/hotboard/zara/refresh`, `/api/hotboard/wechat/ingest`, `/api/hotboard/vote`, or any POST endpoint.
- Do not infer missing data by fabricating items. If the API returns an empty list, say no items were returned for that date.
- Do not expose raw internal fields beyond the public API response.

## Rendering Rules

After calling the API, render the JSON yourself as Chinese markdown.

### Items Output

For `/api/public/items`, use this shape:

```markdown
## 今天 AI 圈

数据日期：<date> · 条目：<count>

1. **<title>**
   - 来源：<source> · 分数：<signal_score> · 时间：<timestamp>
   - 摘要：<summary>
   - 链接：<url>
```

If `items` is empty:

```markdown
## 今天 AI 圈

<date> 暂无可展示条目。
```

### Daily Output

For `/api/public/daily`, group by returned sections:

```markdown
## AI 日报 · <date>

### <section title>

- **<item title>** — <summary>
  - 来源：<source> · 分数：<signal_score> · 链接：<url>
```

Keep the answer compact. Prefer the top 3-5 items per section unless the user asks for all.

### Dailies Output

For `/api/public/dailies`, render:

```markdown
## AI Hotboard 近 7 天

- <date> · <count> 条
```

## Error Handling

- If the API returns 403, explain that the request looked like a crawler and retry once with `User-Agent: aihot-skill/1.0`.
- If the API returns 503, say the public API is rate limited and ask the user to retry later.
- If the API returns 5xx, do not invent a summary; report the endpoint and status.

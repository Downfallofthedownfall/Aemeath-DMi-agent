---
name: web-search
description: Use the dsh built-in web_search tool for live web lookups (news, new rules, unfamiliar terms) — returns structured results with sources. / 使用 dsh 内置 web_search 工具联网搜索（实时信息、新闻、新规定、不熟悉的机构/人名/术语），获得带来源的结构化结果。
whenToUse: When up-to-date external information is needed (exam/application deadlines, news, official-site content, unfamiliar terms) or the user explicitly asks to look something up; prefer it when local lecture notes and the worldbook have no answer and the answer changes over time. Do not use it for local retrieval (use lecture retrieval / memory instead). / 需要外部实时信息（考试/申请新规定、新闻、官网内容、不熟悉的专有名词）或用户明确要求"查一下/搜一下/上网看看"时；本地讲义与 worldbook 没有答案且答案会随时间变化时优先使用。不要用它做本地检索（本地走讲义检索/记忆）。
---
# Web search: use dsh's web_search, don't scrape search engines
# 联网搜索：用 dsh 的 web_search，别抓搜索引擎

## How to / 怎么做

1. **Prefer the `web_search` tool** / **首选 `web_search` 工具**：when you need external/live information, call the dsh built-in `web_search` tool (pass a query). It goes through the DeepSeek official search API and returns structured results (title, snippet, source URL) — not affected by anti-bot protection. / 需要外部/实时信息时，直接调用 dsh 内置的 `web_search` 工具（传查询词即可）。它走 DeepSeek 官方搜索接口，返回结构化结果列表（标题、摘要、来源 URL），不受网站反爬影响。
2. **When you need full content** / **需要全文时**：first use `web_search` to find a trusted source URL, then use `web_scraper` on **that specific article/page URL** to verify the body text. / 先用 `web_search` 找到可信来源 URL，再对**那个具体文章/页面 URL** 用 `web_scraper` 抓正文核对。

## What NOT to do / 不要做什么

- ❌ **Never use `web_scraper` on search-engine result pages** / **不要用 `web_scraper` 抓搜索引擎结果页**：`bing.com/search`, `google.com/search`, `baidu.com/s`, `duckduckgo.com/?q=` have anti-bot protection (captcha / 403 / empty shells) — fetching them always fails and wastes a turn. Search always goes through `web_search`. / 这类搜索 URL 都有反爬（验证页 / 403 / 空壳结果），抓取必然失败且浪费一轮。搜索一律走 `web_search`。
- ❌ **Never fabricate time-sensitive information** / **不要凭记忆编造会随时间变化的信息**：exam dates, cut-off scores, news, official-site content must be based on `web_search` results. / 考试安排、分数线、新闻、官网内容等，必须以 `web_search` 结果为准。

## Citations & context / 引用与场合

- Cite the sources returned by `web_search` (domain + title); mark anything uncertain as "needs verification". / 回答引用 `web_search` 返回的来源（域名 + 标题），不确定的标注"需进一步核实"。
- Physics-study context: check local sources first (worldbook, lecture retrieval, course pages); use `web_search` only for genuinely time-sensitive info (e.g. this year's exam schedule, new official rules). / 物理学习场景：先查本地（worldbook 知识库、讲义检索、课程页），确需实时信息（如今年考试安排、官网新规）才 `web_search`。

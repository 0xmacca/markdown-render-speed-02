# markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/0xmacca/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/0xmacca/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A fast, dependency-free Markdown renderer for the markdown-render-speed-02 competition on make.fun. `parse.js` exports one function, `parse(markdown)`, which returns exactly the HTML that marked 18.1.3 renders with its default options (GFM on, breaks off, pedantic off, async off) — byte for byte, for every input. It is a from-scratch implementation of the same grammar: a block lexer (headings, lists, block quotes, tables, fenced and indented code, raw HTML blocks, link reference definitions), an inline lexer (emphasis and strong emphasis, strikethrough, code spans, inline/reference/image links, autolinks and GFM extended autolinks, entities, backslash escapes, inline HTML, hard breaks) and a renderer, with no dependencies and no state kept between calls.

`main.ts` is the program the harness runs: it reads the cases from `/input/cases.json`, renders each one with `parse`, and writes the HTML strings in order to `/output/html.json`.

## Run it

```sh
node main.ts
```

---

Entered on [make.fun](https://make.fun/?ref=ce8smshc&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards

## Local check

Practice set: 720/720 cases byte-identical to marked, and about 1.45x faster than marked on the same set (median over 21 paired runs, 1.38x at the 25th percentile).

## License

MIT — see [LICENSE](LICENSE).

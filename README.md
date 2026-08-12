# Anki to Obsidian

本地 AnkiConnect 兼容端点：把外部客户端（漫画阅读工具/Anki 脚本）发来的卡片写入 Obsidian 笔记，配合 [obsidian-to-anki](https://github.com/Pseudonium/Obsidian_to_Anki) 同步回 Anki。

## 工作方式

```
addNote 请求 ──append──▶ 缓冲池 Pot/anki_card.md（原始卡）
                                │ 「整理缓冲池」命令
                                ▼
                  提取（【】标记 / LLM）→ 去重合并 → 分页文件 Pot/anki/anki_1.md…
```

- **缓冲池**（默认 `Pot/anki_card.md`）：addNote 原样追加，`Front #basic` + Back
- **整理**：命令面板「整理缓冲池」（或设置页按钮），提取学习卡写入分页文件，已处理卡从缓冲池删除
- **分页文件**（默认 `Pot/anki/`）：每 100 张一文件（`anki_1.md`、`anki_2.md`…），用 obsidian-to-anki 同步

## 提取规则

- **【】标记**：`WHAT 【ON EARTH：到底】 IS THIS?` → 卡 `On earth`，背面 `到底` + 例句 `What on earth is this?`；`【词：释义】` 中 `：` 后的释义写入背面，例句里保留被标记的词
- **整句无标记**：调 LLM（OpenAI 兼容 API）每句提取 1–2 个学习点（单词用原型、背面带词性/用法），并顺带修正拼写/标点（如 `IST` → `1st`）
- **单行单词卡**（如 `PRODIGAL` + 释义）：跳过 LLM 直接规范化
- **去重**：键 = 正面+释义（跨所有分页文件）；命中重复合并例句（上限 3 条，保留已有 `<!--ID: -->`）
- **失败处理**：LLM 失败的句子留在缓冲池，下次整理重试

## 设置

| 设置 | 默认 | 说明 |
|---|---|---|
| Port | 8766 | 监听 127.0.0.1 |
| Pot file | Pot/anki_card.md | 缓冲池路径 |
| LLM Base URL | https://api.deepseek.com/v1 | OpenAI 兼容地址（根地址或完整 /chat/completions 地址均可；DeepSeek/通义/Ollama 均支持） |
| LLM API Key | 空 | 不配置则整句跳过，可用【】标记手动提取 |
| LLM Model | deepseek-chat | 模型名 |
| Deck 目录 | Pot/anki | 分页文件目录 |
| 每页卡片数 | 100 | 超出另起新文件 |
| 例句上限 | 3 | 合并例句数量上限 |
| 每句提取数 | 2 | LLM 每句最多提取的学习点数 |

## 开发

```
npm install
npm run dev    # 监听构建
npm run build  # tsc 类型检查 + esbuild 打包
npm test       # esbuild 打包测试 + node --test（零新增依赖）
```

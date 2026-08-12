import { App, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import * as http from "http";
import { Card, CARD_SEP, parseCards, serializeCard } from "./lib/cards";
import { fixText, sentenceCase } from "./lib/normalize";
import { buildBack, extractMarked, stripMarkers } from "./lib/extract";
import { cardKey, mergeExample } from "./lib/dedup";
import { callLLM as libCallLLM, LLM_BATCH, LLMOut } from "./lib/llm";

interface AnkiToObsidianSettings {
  port: number;
  potFile: string;
  debug: boolean;
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  deckDir: string;
  cardsPerPage: number;
  maxExamples: number;
  extractCount: number;
}

const DEFAULT_SETTINGS: AnkiToObsidianSettings = {
  port: 8766,
  potFile: "Pot/anki_card.md",
  debug: false,
  llmBaseUrl: "https://api.deepseek.com/v1",
  llmApiKey: "",
  llmModel: "deepseek-chat",
  deckDir: "Pot/anki",
  cardsPerPage: 100,
  maxExamples: 3,
  extractCount: 2,
};

function deckIndex(path: string): number {
  const m = path.match(/anki_(\d+)\.md$/);
  return m ? parseInt(m[1], 10) : 0;
}

export default class AnkiToObsidianPlugin extends Plugin {
  settings: AnkiToObsidianSettings;
  server: http.Server | null = null;

  async onload() {
    await this.loadSettings();
    this.startServer();
    this.addSettingTab(new AnkiToObsidianSettingTab(this.app, this));
    this.addCommand({
      id: "consolidate-buffer",
      name: "整理缓冲池：提取到分页卡片",
      callback: () => {
        void this.consolidateBuffer();
      },
    });
  }

  onunload() {
    this.server?.close();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  startServer() {
    this.server = http.createServer((req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "*");
      if (req.method === "OPTIONS") {
        // ponytail: preflight, needed for browser-side callers
        res.writeHead(204);
        res.end();
        return;
      }
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        const reply = (result: unknown, error: string | null) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ result, error }));
        };
        try {
          const reqJson = JSON.parse(body);
          if (this.settings.debug) {
            await this.appendToFile(
              "```json\n" + JSON.stringify(reqJson, null, 2) + "\n```\n\n---\n\n"
            );
          }
          const { action, params } = reqJson;
          if (action === "version") {
            reply(6, null);
          } else if (action === "addNote") {
            const note = params?.note ?? {};
            const fields = note.fields ?? {};
            if (String(note.deckName ?? "").toLowerCase() === "pot") {
              // ponytail: pot deck -> obsidian-to-anki format; generalize when more decks need it
              await this.appendToFile(
                `${fields.Front ?? ""} #basic\n${fields.Back ?? ""}\n\n---\n\n`
              );
            } else {
              const text = Object.values(fields).join("\n\n") + "\n\n---\n\n";
              await this.appendToFile(text);
            }
            reply(Date.now(), null);
          } else {
            reply(null, "unsupported action");
          }
        } catch (e) {
          reply(null, String((e as Error)?.message ?? e));
        }
      });
    });
    this.server.on("error", (e) => console.error("anki-to-obsidian:", e));
    this.server.listen(this.settings.port, "127.0.0.1");
  }

  restartServer() {
    // ponytail: close waits for idle connections; fine for a local single-user server
    if (this.server) this.server.close(() => this.startServer());
    else this.startServer();
  }

  async appendToFile(text: string, path = this.settings.potFile?.trim() || "Pot/anki_card.md") {
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (dir && !(await this.app.vault.adapter.exists(dir))) {
      await this.app.vault.adapter.mkdir(dir);
    }
    if (!(await this.app.vault.adapter.exists(path))) {
      await this.app.vault.create(path, "");
    }
    await this.app.vault.adapter.append(path, text);
  }

  // ---- 整理：缓冲池 -> 分页卡片 ----

  async consolidateBuffer() {
    const adapter = this.app.vault.adapter;
    const bufferPath = this.settings.potFile?.trim() || "Pot/anki_card.md";
    const deckDir = this.settings.deckDir?.trim() || "Pot/anki";
    const stats = { added: 0, merged: 0, dropped: 0, failed: 0 };
    try {
      if (!(await adapter.exists(bufferPath))) {
        new Notice("缓冲池文件不存在：" + bufferPath);
        return;
      }
      const rawCards = parseCards(await adapter.read(bufferPath));
      if (rawCards.length === 0) {
        new Notice("缓冲池为空，无需整理");
        return;
      }

      // 分类：带【】标记 / 单行单词卡 / 整句
      const marked: { en: string; zh: string; tokens: { word: string; meaning: string }[] }[] = [];
      const words: Card[] = [];
      const sentences: { raw: Card; en: string; zh: string }[] = [];
      for (const c of rawCards) {
        const tokens = extractMarked(c.front);
        const zh = c.back.trim();
        if (tokens.length) marked.push({ en: sentenceCase(stripMarkers(c.front)), zh, tokens });
        else if (!/\s/.test(c.front)) words.push(c);
        else sentences.push({ raw: c, en: sentenceCase(c.front), zh });
      }

      // 整句走 LLM 批量提取；失败批次的句子留在缓冲池
      const results: (LLMOut | null)[] = sentences.map(() => null);
      if (sentences.length) {
        if (!this.settings.llmApiKey) {
          new Notice(
            "未配置 LLM API Key，" +
              sentences.length +
              " 句无法自动提取（留在缓冲池）；可用【】标记手动提取"
          );
        } else {
          for (let i = 0; i < sentences.length; i += LLM_BATCH) {
            const slice = sentences.slice(i, i + LLM_BATCH);
            try {
              const outs = await this.callLLM(slice.map((s, k) => ({ i: i + k, en: s.en, zh: s.zh })));
              for (const o of outs) {
                if (o.i >= 0 && o.i < sentences.length) results[o.i] = o;
              }
            } catch (e) {
              new Notice(
                "LLM 请求失败（第 " +
                  (i + 1) +
                  "~" +
                  (i + slice.length) +
                  " 句）：" +
                  String((e as Error)?.message ?? e)
              );
            }
          }
        }
      }

      // 组装提取卡（正面=学习点，背面=释义+例句）
      const pending: { card: Card; en: string; zh: string }[] = [];
      for (const m of marked) {
        for (const t of m.tokens) {
          pending.push({
            card: { front: sentenceCase(t.word), back: buildBack(t.meaning, m.en, m.zh) },
            en: m.en,
            zh: m.zh,
          });
        }
      }
      for (const w of words) {
        pending.push({
          card: {
            front: sentenceCase(w.front.replace(/[.!?,;:]+$/, "")),
            back: w.back.replace(/\n+/g, "<br>").trim(),
          },
          en: "",
          zh: "",
        });
      }
      for (let i = 0; i < sentences.length; i++) {
        const r = results[i];
        if (!r) {
          stats.failed++;
          continue;
        }
        const en = r.en && r.en.trim() ? fixText(r.en) : sentences[i].en;
        if (!r.points.length) {
          stats.dropped++;
          continue;
        }
        for (const p of r.points) {
          pending.push({
            card: {
              front: sentenceCase(p.front),
              back: buildBack(p.back.replace(/\n+/g, "<br>"), en, sentences[i].zh),
            },
            en,
            zh: sentences[i].zh,
          });
        }
      }

      // 加载分页文件并去重（键 = 正面 + 释义；命中则合并例句）
      const files: { path: string; cards: Card[]; dirty: boolean }[] = await this.loadDeckFiles(deckDir);
      const keyMap = new Map<string, { file: number; card: Card }>();
      for (let fi = 0; fi < files.length; fi++) {
        for (const card of files[fi].cards) keyMap.set(cardKey(card), { file: fi, card });
      }
      const newCards: Card[] = [];
      for (const item of pending) {
        const key = cardKey(item.card);
        const hit = keyMap.get(key);
        if (hit) {
          if (item.en && mergeExample(hit.card, item.en, item.zh, this.settings.maxExamples)) {
            stats.merged++;
            if (hit.file >= 0) files[hit.file].dirty = true;
          } else {
            stats.dropped++;
          }
        } else {
          keyMap.set(key, { file: -1, card: item.card });
          newCards.push(item.card);
          stats.added++;
        }
      }

      // 分页写入：先填满现有文件，再开新文件
      let idx = 0;
      for (const f of files) {
        if (idx >= newCards.length) break;
        if (f.cards.length >= this.settings.cardsPerPage) continue;
        while (f.cards.length < this.settings.cardsPerPage && idx < newCards.length) {
          f.cards.push(newCards[idx++]);
        }
        f.dirty = true;
      }
      while (idx < newCards.length) {
        const nf: { path: string; cards: Card[]; dirty: boolean } = {
          path: await this.nextDeckPath(deckDir, files),
          cards: [],
          dirty: true,
        };
        while (nf.cards.length < this.settings.cardsPerPage && idx < newCards.length) {
          nf.cards.push(newCards[idx++]);
        }
        files.push(nf);
      }
      for (const f of files) {
        if (!f.dirty) continue;
        await this.writeDeckFile(f);
      }

      // 缓冲池只保留失败的原始卡
      const failedCards: Card[] = [];
      for (let i = 0; i < sentences.length; i++) {
        if (!results[i]) failedCards.push(sentences[i].raw);
      }
      await adapter.write(bufferPath, failedCards.map(serializeCard).join(CARD_SEP));

      new Notice(
        "整理完成：新增 " +
          stats.added +
          "，合并 " +
          stats.merged +
          "，跳过 " +
          stats.dropped +
          "，失败留在缓冲池 " +
          stats.failed
      );
    } catch (e) {
      new Notice("整理失败：" + String((e as Error)?.message ?? e));
    }
  }

  // 薄封装：便于测试时替换
  async callLLM(sents: { i: number; en: string; zh: string }[]): Promise<LLMOut[]> {
    return libCallLLM(
      {
        baseUrl: this.settings.llmBaseUrl,
        apiKey: this.settings.llmApiKey,
        model: this.settings.llmModel,
        extractCount: this.settings.extractCount,
      },
      sents
    );
  }

  async loadDeckFiles(deckDir: string): Promise<{ path: string; cards: Card[]; dirty: boolean }[]> {
    const adapter = this.app.vault.adapter;
    const files: { path: string; cards: Card[]; dirty: boolean }[] = [];
    if (await adapter.exists(deckDir)) {
      const listed = await adapter.list(deckDir);
      const paths = listed.files
        .filter((p) => /anki_\d+\.md$/.test(p))
        .sort((a, b) => deckIndex(a) - deckIndex(b));
      for (const p of paths) {
        files.push({ path: p, cards: parseCards(await adapter.read(p)), dirty: false });
      }
    }
    return files;
  }

  async nextDeckPath(deckDir: string, files: { path: string }[]): Promise<string> {
    let max = 0;
    for (const f of files) max = Math.max(max, deckIndex(f.path));
    return deckDir + "/anki_" + (max + 1) + ".md";
  }

  async writeDeckFile(f: { path: string; cards: Card[] }) {
    const adapter = this.app.vault.adapter;
    const dir = f.path.slice(0, f.path.lastIndexOf("/"));
    if (dir && !(await adapter.exists(dir))) await adapter.mkdir(dir);
    await adapter.write(f.path, f.cards.map(serializeCard).join(CARD_SEP));
  }
}

class AnkiToObsidianSettingTab extends PluginSettingTab {
  plugin: AnkiToObsidianPlugin;

  constructor(app: App, plugin: AnkiToObsidianPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Port")
      .setDesc("Listen on 127.0.0.1:<port>. Changing it restarts the server.")
      .addText((text) =>
        text
          .setPlaceholder("8766")
          .setValue(String(this.plugin.settings.port))
          .onChange(async (value) => {
            const port = parseInt(value, 10);
            if (isNaN(port)) return;
            this.plugin.settings.port = port;
            await this.plugin.saveSettings();
            this.plugin.restartServer();
          })
      );

    new Setting(containerEl)
      .setName("Pot file")
      .setDesc("Vault-relative path all cards are appended to (created if missing). Empty falls back to Pot/anki_card.md.")
      .addText((text) =>
        text
          .setPlaceholder("Pot/anki_card.md")
          .setValue(this.plugin.settings.potFile)
          .onChange(async (value) => {
            this.plugin.settings.potFile = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Debug mode")
      .setDesc("Append every incoming request body as a ```json code block to the target file.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.debug)
          .onChange(async (value) => {
            this.plugin.settings.debug = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl).setName("LLM 自动提取").setHeading();

    new Setting(containerEl)
      .setName("LLM Base URL")
      .setDesc("OpenAI 兼容接口地址：根地址或完整 /chat/completions 地址均可，如 https://api.deepseek.com/v1")
      .addText((text) =>
        text
          .setPlaceholder("https://api.deepseek.com/v1")
          .setValue(this.plugin.settings.llmBaseUrl)
          .onChange(async (value) => {
            this.plugin.settings.llmBaseUrl = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("LLM API Key")
      .setDesc("整理时自动提取句子中的学习点使用；不配置则整句跳过留在缓冲池，可用【】标记手动提取")
      .addText((text) => {
        text
          .setPlaceholder("sk-...")
          .setValue(this.plugin.settings.llmApiKey)
          .onChange(async (value) => {
            this.plugin.settings.llmApiKey = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.type = "password";
      });

    new Setting(containerEl)
      .setName("LLM Model")
      .setDesc("如 deepseek-chat、gpt-4o-mini、qwen2.5 等")
      .addText((text) =>
        text
          .setPlaceholder("deepseek-chat")
          .setValue(this.plugin.settings.llmModel)
          .onChange(async (value) => {
            this.plugin.settings.llmModel = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl).setName("分页卡片").setHeading();

    new Setting(containerEl)
      .setName("Deck 目录")
      .setDesc("整理后的分页卡片目录（vault 相对路径），文件按 anki_1.md、anki_2.md 命名")
      .addText((text) =>
        text
          .setPlaceholder("Pot/anki")
          .setValue(this.plugin.settings.deckDir)
          .onChange(async (value) => {
            this.plugin.settings.deckDir = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("每页卡片数")
      .setDesc("单个文件超过该数量后另起一个新文件")
      .addText((text) =>
        text
          .setPlaceholder("100")
          .setValue(String(this.plugin.settings.cardsPerPage))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (isNaN(n) || n <= 0) return;
            this.plugin.settings.cardsPerPage = n;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("例句上限")
      .setDesc("同一张卡最多合并几条例句，超出丢弃（去重命中时合并例句）")
      .addText((text) =>
        text
          .setPlaceholder("3")
          .setValue(String(this.plugin.settings.maxExamples))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (isNaN(n) || n <= 0) return;
            this.plugin.settings.maxExamples = n;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("每句提取数")
      .setDesc("LLM 自动提取时每句最多提取几个学习点")
      .addText((text) =>
        text
          .setPlaceholder("2")
          .setValue(String(this.plugin.settings.extractCount))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (isNaN(n) || n <= 0) return;
            this.plugin.settings.extractCount = n;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl).setName("整理").setHeading();

    new Setting(containerEl)
      .setName("整理缓冲池")
      .setDesc("把缓冲池中的原始卡提取为学习卡（【】标记/LLM），去重合并后写入分页文件；已处理的卡从缓冲池删除")
      .addButton((button) =>
        button.setButtonText("立即整理").onClick(() => {
          void this.plugin.consolidateBuffer();
        })
      );
  }
}

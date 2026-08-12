import test from "node:test";
import assert from "node:assert";
import { parseCards, serializeCard } from "../src/lib/cards";
import { fixText, sentenceCase } from "../src/lib/normalize";
import { buildBack, extractMarked, stripMarkers } from "../src/lib/extract";
import { cardKey, exampleLinesOf, meaningOf, mergeExample } from "../src/lib/dedup";
import { parseLLMJson, chatCompletionsUrl } from "../src/lib/llm";
import AnkiToObsidianPlugin from "../src/main";

// ---------- 纯函数 ----------

test("parseCards: 提取 ID、跳过 debug 块、容忍尾部分隔符", () => {
  const sample = [
    "WHAT ON EARTH IS THIS TRAINEE HAN YOIL? #basic",
    "这练习生韩曜日到底是什么来头？",
    "<!--ID: 1784855769112-->",
    "",
    "",
    "---",
    "",
    "```json",
    '{"action":"addNote"}',
    "```",
    "",
    "",
    "---",
    "",
    "PRODIGAL #basic",
    "名词. 败家子<br>形容词. 放荡的; 浪费的",
    "",
    "",
    "---",
    "",
    "OBEDIENTLY. #basic",
    "顺从地。",
    "",
    "",
  ].join("\n");
  const cards = parseCards(sample);
  assert.strictEqual(cards.length, 3, "debug 块应被跳过");
  assert.deepStrictEqual(cards[0], {
    front: "WHAT ON EARTH IS THIS TRAINEE HAN YOIL?",
    back: "这练习生韩曜日到底是什么来头？",
    id: "1784855769112",
  });
  assert.strictEqual(cards[1].front, "PRODIGAL");
});

test("serializeCard: 带/不带 ID", () => {
  assert.strictEqual(
    serializeCard({ front: "Prodigal", back: "n. 败家子", id: "123" }),
    "Prodigal #basic\nn. 败家子\n<!--ID: 123-->"
  );
  assert.strictEqual(serializeCard({ front: "Prodigal", back: "n. 败家子" }), "Prodigal #basic\nn. 败家子");
});

test("fixText / sentenceCase", () => {
  assert.strictEqual(sentenceCase("TIED FOR IST PLACE.?"), "Tied for ist place?");
  assert.strictEqual(sentenceCase("WHAT ON EARTH IS THIS TRAINEE HAN YOIL?"), "What on earth is this trainee han yoil?");
  assert.strictEqual(sentenceCase("ARCADE!"), "Arcade!");
  assert.strictEqual(fixText("HI ,THERE."), "HI, THERE.");
  assert.strictEqual(fixText("OK. ?"), "OK?");
});

test("extractMarked / stripMarkers", () => {
  assert.deepStrictEqual(extractMarked("WHAT 【ON EARTH：到底】 IS THIS?"), [{ word: "ON EARTH", meaning: "到底" }]);
  assert.deepStrictEqual(extractMarked("【prodigal：n. 败家子】 #basic"), [{ word: "prodigal", meaning: "n. 败家子" }]);
  assert.deepStrictEqual(extractMarked("【HENCEFORTH ANNULLED】"), [{ word: "HENCEFORTH ANNULLED", meaning: "" }]);
  assert.deepStrictEqual(extractMarked("NO MARKER"), []);
  assert.strictEqual(stripMarkers("WHAT 【ON EARTH：到底】 IS THIS?"), "WHAT ON EARTH IS THIS?");
  assert.strictEqual(stripMarkers("【soaring：v. 翱翔】"), "soaring");
});

test("buildBack / meaningOf / exampleLinesOf", () => {
  const b1 = buildBack("n. 败家子", "The prodigal son came back.", "浪子回头了。");
  assert.strictEqual(b1, "n. 败家子<br>例：The prodigal son came back.<br>浪子回头了。");
  assert.strictEqual(meaningOf(b1), "n. 败家子");
  assert.deepStrictEqual(exampleLinesOf(b1), [["The prodigal son came back.", "浪子回头了。"]]);
  const b2 = buildBack("", "What is this?", "这是什么？");
  assert.strictEqual(meaningOf(b2), "");
  assert.strictEqual(exampleLinesOf(b2).length, 1);
});

test("cardKey: 正面+释义判重，例句不影响", () => {
  assert.strictEqual(
    cardKey({ front: "Prodigal", back: "n. 败家子<br>例：A.<br>a。" }),
    cardKey({ front: "prodigal", back: "n. 败家子<br>例：B.<br>b。" })
  );
  assert.notStrictEqual(
    cardKey({ front: "Prodigal", back: "n. 败家子" }),
    cardKey({ front: "Prodigal", back: "adj. 放荡的" })
  );
});

test("mergeExample: 合并例句、例句查重、上限", () => {
  const card = { front: "Prodigal", back: "n. 败家子<br>例：The prodigal son came back.<br>浪子回头了。" };
  assert.strictEqual(mergeExample(card, "What a waste!", "真浪费！", 3), true);
  assert.strictEqual(mergeExample(card, "THE PRODIGAL SON CAME BACK.", "浪子回头了。", 3), false, "重复例句应拒绝");
  const c2 = { front: "X", back: "释义" };
  mergeExample(c2, "A", "a", 3);
  mergeExample(c2, "B", "b", 3);
  mergeExample(c2, "C", "c", 3);
  assert.strictEqual(mergeExample(c2, "D", "d", 3), false, "超上限应拒绝");
  assert.strictEqual(exampleLinesOf(c2.back).length, 3);
});

test("parseLLMJson: 代码块包裹、多余文字、格式错误抛错", () => {
  const raw = '```json\n[{"i": 0, "en": "Tied for 1st place?", "points": [{"front": "tied", "back": "v. 并列"}]}]\n```';
  const outs = parseLLMJson(raw);
  assert.strictEqual(outs.length, 1);
  assert.strictEqual(outs[0].en, "Tied for 1st place?");
  assert.strictEqual(outs[0].points.length, 1);
  assert.throws(() => parseLLMJson("没有数组"));
});

test("chatCompletionsUrl: 根地址与完整接口地址均可", () => {
  assert.strictEqual(chatCompletionsUrl("https://api.deepseek.com/v1"), "https://api.deepseek.com/v1/chat/completions");
  assert.strictEqual(
    chatCompletionsUrl("https://api.deepseek.com/chat/completions"),
    "https://api.deepseek.com/chat/completions"
  );
  assert.strictEqual(chatCompletionsUrl("https://api.deepseek.com/chat/completions/"), "https://api.deepseek.com/chat/completions");
  assert.strictEqual(chatCompletionsUrl("https://api.deepseek.com"), "https://api.deepseek.com/chat/completions");
  assert.throws(() => chatCompletionsUrl("  "));
});

// ---------- 完整整理流程（内存 adapter + mock obsidian）----------

class MemAdapter {
  files = new Map<string, string>();
  exists(p: string): boolean {
    if (this.files.has(p)) return true;
    const prefix = p + "/"; // 目录视为存在
    return [...this.files.keys()].some((k) => k.startsWith(prefix));
  }
  read(p: string): string {
    return this.files.get(p) ?? "";
  }
  write(p: string, text: string): void {
    this.files.set(p, text);
  }
  append(p: string, text: string): void {
    this.files.set(p, (this.files.get(p) ?? "") + text);
  }
  mkdir(): void {}
  list(dir: string): { files: string[]; folders: string[] } {
    const prefix = dir + "/";
    return { files: [...this.files.keys()].filter((p) => p.startsWith(prefix)), folders: [] };
  }
}

const bufferText = (cards: [string, string][]): string =>
  cards.map(([f, b]) => f + " #basic\n" + b).join("\n\n---\n\n") + "\n\n---\n\n";

function makePlugin(overrides: Partial<AnkiToObsidianPlugin["settings"]> = {}) {
  const plugin = new AnkiToObsidianPlugin({ vault: { adapter: new MemAdapter() } }, {});
  plugin.settings = {
    port: 8766,
    potFile: "Pot/anki_card.md",
    debug: false,
    llmBaseUrl: "https://api.deepseek.com/v1",
    llmApiKey: "test-key",
    llmModel: "deepseek-chat",
    deckDir: "Pot/anki",
    cardsPerPage: 100,
    maxExamples: 3,
    extractCount: 2,
    ...overrides,
  };
  return plugin;
}

test("整理流程：标记+单词+LLM 提取，分页写入，缓冲池清理", async () => {
  const p = makePlugin({ cardsPerPage: 2 });
  const adapter = p.app.vault.adapter as MemAdapter;
  adapter.write(
    "Pot/anki_card.md",
    bufferText([
      ["WHAT 【ON EARTH：到底】 IS THIS?", "这到底是什么？"],
      ["TIED FOR IST PLACE.?", "并列第一？"],
      ["PRODIGAL", "名词. 败家子<br>形容词. 放荡的; 浪费的"],
      ["【soaring：v. 翱翔】", "他在翱翔。"],
    ])
  );
  // 注入 LLM 结果：TIED FOR... 是唯一整句（序号 0）
  p.callLLM = async () => [
    {
      i: 0,
      en: "Tied for 1st place?",
      points: [
        { front: "tied for 1st place", back: "phr. 并列第一" },
        { front: "tie", back: "v. 打成平手" },
      ],
    },
  ];

  await p.consolidateBuffer();

  const all = [1, 2, 3].map((n) => parseCards(adapter.read("Pot/anki/anki_" + n + ".md"))).flat();
  assert.strictEqual(all.length, 5, "应产出 5 张卡");
  const onEarth = all.find((c) => c.front === "On earth");
  assert.strictEqual(onEarth?.back, "到底<br>例：What on earth is this?<br>这到底是什么？");
  const tie = all.find((c) => c.front === "Tie");
  assert.strictEqual(tie?.back, "v. 打成平手<br>例：Tied for 1st place?<br>并列第一？");
  const prodigal = all.find((c) => c.front === "Prodigal");
  assert.strictEqual(prodigal?.back, "名词. 败家子<br>形容词. 放荡的; 浪费的");
  // 分页：每页 2 张
  assert.strictEqual(parseCards(adapter.read("Pot/anki/anki_1.md")).length, 2);
  assert.strictEqual(parseCards(adapter.read("Pot/anki/anki_2.md")).length, 2);
  assert.strictEqual(parseCards(adapter.read("Pot/anki/anki_3.md")).length, 1);
  // 缓冲池清空
  assert.strictEqual(adapter.read("Pot/anki_card.md"), "");
});

test("整理流程：重复卡合并例句保留 ID，LLM 失败留在缓冲池", async () => {
  const p = makePlugin();
  const adapter = p.app.vault.adapter as MemAdapter;
  // 已有分页文件：一张 On earth 卡（带 obsidian-to-anki 回写的 ID）
  adapter.write(
    "Pot/anki/anki_1.md",
    "On earth #basic\n到底<br>例：What on earth is this?<br>这到底是什么？\n<!--ID: 555-->"
  );
  // 缓冲池：同词不同例句的标记卡 + 一条需要 LLM 的整句
  adapter.write(
    "Pot/anki_card.md",
    bufferText([
      ["WHERE 【ON EARTH：到底】 ARE WE?", "我们到底在哪？"],
      ["A NEW SENTENCE HERE.", "新句子。"],
    ])
  );
  p.callLLM = async () => {
    throw new Error("网络炸了");
  };

  await p.consolidateBuffer();

  // 合并例句成功，已有 ID 保留
  const f1 = parseCards(adapter.read("Pot/anki/anki_1.md"));
  assert.strictEqual(f1.length, 1);
  assert.strictEqual(f1[0].id, "555", "已有 ID 应保留");
  assert.strictEqual(
    f1[0].back,
    "到底<br>例：What on earth is this?<br>这到底是什么？<br>例：Where on earth are we?<br>我们到底在哪？"
  );
  // 失败句留在缓冲池，已处理的标记卡被删除
  const buffer = adapter.read("Pot/anki_card.md");
  assert.ok(buffer.includes("A NEW SENTENCE HERE."), "失败句留在缓冲池");
  assert.ok(!buffer.includes("ON EARTH"), "已处理卡从缓冲池删除");
});

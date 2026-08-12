import test from "node:test";
import assert from "node:assert";
import { Notice } from "obsidian";
import { isDeleteMarker, parseCards, serializeCard } from "../src/lib/cards";
import { fixText, sentenceCase } from "../src/lib/normalize";
import { extractMarked, stripMarkers } from "../src/lib/extract";
import { cardKey, meaningOf } from "../src/lib/dedup";
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

test("parseCards: 折行句子以 #basic 行为正面结束，不再截断", () => {
  const wrapped = [
    "OTHERWISE, TO",
    "BE A SPARE, IN",
    "CASE SOMETHING",
    "HAPPENED TO",
    "THE KING. #basic",
    "换句话说，",
    "成为一个备用品，",
    "以防国王发生",
    "什么意外。",
    "<!--ID: 1786516913990-->",
  ].join("\n");
  const cards = parseCards(wrapped);
  assert.strictEqual(cards.length, 1);
  assert.deepStrictEqual(cards[0], {
    front: "OTHERWISE, TO\nBE A SPARE, IN\nCASE SOMETHING\nHAPPENED TO\nTHE KING.",
    back: "换句话说，\n成为一个备用品，\n以防国王发生\n什么意外。",
    id: "1786516913990",
  });
});

test("parseCards: 无 #basic 标记时取第一行为正面（DELETE 卡）", () => {
  const cards = parseCards("DELETE\n<!--ID: 123-->");
  assert.strictEqual(cards.length, 1);
  assert.deepStrictEqual(cards[0], { front: "DELETE", back: "", id: "123" });
  assert.ok(isDeleteMarker(cards[0]));
  assert.ok(!isDeleteMarker({ front: "Delete", back: "v. 删除" }), "带释义的 delete 卡不受影响");
  assert.ok(!isDeleteMarker({ front: "PRODIGAL", back: "n. 败家子" }));
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

test("meaningOf / cardKey: 正面+释义判重，忽略旧版例句", () => {
  assert.strictEqual(meaningOf("n. 败家子<br>例：The prodigal son came back.<br>浪子回头了。"), "n. 败家子");
  assert.strictEqual(meaningOf("n. 败家子"), "n. 败家子");
  assert.strictEqual(
    cardKey({ front: "Prodigal", back: "n. 败家子<br>例：A.<br>a。" }),
    cardKey({ front: "prodigal", back: "n. 败家子<br>例：B.<br>b。" })
  );
  assert.notStrictEqual(
    cardKey({ front: "Prodigal", back: "n. 败家子" }),
    cardKey({ front: "Prodigal", back: "adj. 放荡的" })
  );
  assert.strictEqual(
    cardKey({ front: "Otherwise to be a spare", back: "换句话说，成为一个备用品" }),
    cardKey({ front: " otherwise\nto   be a spare", back: "换句话说，成为一个备用品" })
  );
  assert.notStrictEqual(
    cardKey({ front: "To be a spare", back: "成为一个备用品" }),
    cardKey({ front: "To be a spare,", back: "成为一个备用品" }),
    "标点差异视为不同卡"
  );
});

test("parseLLMJson: 代码块包裹、多余文字、缺字段跳过、格式错误抛错", () => {
  const raw = '```json\n[{"i": 0, "en": "Tied for 1st place?", "zh": "并列第一？"}]\n```';
  const outs = parseLLMJson(raw);
  assert.strictEqual(outs.length, 1);
  assert.strictEqual(outs[0].en, "Tied for 1st place?");
  assert.strictEqual(outs[0].zh, "并列第一？");
  assert.strictEqual(parseLLMJson('[{"i": 0, "en": "A"}]').length, 0, "缺 zh 的条目应跳过");
  assert.strictEqual(parseLLMJson('[{"i": 0, "zh": "B"}]').length, 0, "缺 en 的条目应跳过");
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
    ...overrides,
  };
  return plugin;
}

test("整理流程：折行句子规范化为单卡（保留 ID），标记卡直通，分页写入，缓冲池清理", async () => {
  const p = makePlugin({ cardsPerPage: 2 });
  const adapter = p.app.vault.adapter as MemAdapter;
  adapter.write(
    "Pot/anki_card.md",
    [
      "OTHERWISE, TO",
      "BE A SPARE, IN",
      "CASE SOMETHING",
      "HAPPENED TO",
      "THE KING. #basic",
      "换句话说，",
      "成为一个备用品，",
      "以防国王发生",
      "什么意外。",
      "<!--ID: 1786516913990-->",
      "",
      "",
      "---",
      "",
      "WHAT 【ON EARTH：到底】 IS THIS? #basic",
      "这到底是什么？",
      "",
      "",
      "---",
      "",
      "PRODIGAL #basic",
      "名词. 败家子<br>形容词. 放荡的; 浪费的",
      "",
      "",
    ].join("\n")
  );
  // 注入 LLM 结果：整句（序号 0）与单词卡（序号 1）
  p.callLLM = async () => [
    {
      i: 0,
      en: "Otherwise, to be a spare, in case something happened to the king.",
      zh: "换句话说，成为一个备用品，以防国王发生什么意外。",
    },
    { i: 1, en: "Prodigal", zh: "名词. 败家子<br>形容词. 放荡的; 浪费的" },
  ];

  await p.consolidateBuffer();

  const all = [1, 2, 3].map((n) => parseCards(adapter.read("Pot/anki/anki_" + n + ".md"))).flat();
  assert.strictEqual(all.length, 3, "应产出 3 张卡");
  const sentence = all.find((c) => c.front.includes("Otherwise"));
  assert.strictEqual(
    sentence?.front,
    "Otherwise, to be a spare, in case something happened to the king.",
    "整句规范化为一张卡，不再拆学习点"
  );
  assert.strictEqual(sentence?.back, "换句话说，成为一个备用品，以防国王发生什么意外。");
  assert.strictEqual(sentence?.id, "1786516913990", "原卡 ID 应保留");
  const onEarth = all.find((c) => c.front === "What on earth is this?");
  assert.strictEqual(onEarth?.back, "这到底是什么？", "【】标记卡直通，标记去除");
  const prodigal = all.find((c) => c.front === "Prodigal");
  assert.strictEqual(prodigal?.back, "名词. 败家子<br>形容词. 放荡的; 浪费的");
  // 分页：每页 2 张
  assert.strictEqual(parseCards(adapter.read("Pot/anki/anki_1.md")).length, 2);
  assert.strictEqual(parseCards(adapter.read("Pot/anki/anki_2.md")).length, 1);
  // 缓冲池清空
  assert.strictEqual(adapter.read("Pot/anki_card.md"), "");
});

test("整理流程：重复卡跳过不写，LLM 失败/空正面留在缓冲池", async () => {
  const p = makePlugin();
  const adapter = p.app.vault.adapter as MemAdapter;
  // 已有分页文件：同句卡（带 obsidian-to-anki 回写的 ID）
  adapter.write(
    "Pot/anki/anki_1.md",
    "Otherwise, to be a spare. #basic\n换句话说，成为一个备用品。\n<!--ID: 555-->"
  );
  adapter.write(
    "Pot/anki_card.md",
    bufferText([
      ["OTHERWISE, TO BE A SPARE.", "换句话说，成为一个备用品。"],
      ["A NEW SENTENCE HERE.", "新句子。"],
      ["THIRD ONE.", "第三个。"],
    ])
  );
  p.callLLM = async () => [
    { i: 0, en: "Otherwise, to be a spare.", zh: "换句话说，成为一个备用品。" },
    { i: 1, en: "", zh: "" }, // 空正面 = 失败
    // i:2 缺失 = 失败
  ];

  await p.consolidateBuffer();

  const f1 = parseCards(adapter.read("Pot/anki/anki_1.md"));
  assert.strictEqual(f1.length, 1, "重复卡应跳过，不新增");
  assert.strictEqual(f1[0].id, "555", "已有 ID 保留");
  // 失败卡留在缓冲池，去重跳过的卡被移除
  const buffer = adapter.read("Pot/anki_card.md");
  assert.ok(buffer.includes("A NEW SENTENCE HERE."), "空正面卡留在缓冲池");
  assert.ok(buffer.includes("THIRD ONE."), "缺失条目卡留在缓冲池");
  assert.ok(!buffer.includes("OTHERWISE"), "已处理（去重跳过）的卡从缓冲池删除");
});

test("整理流程：分页文件里的 DELETE 标记卡被移除，不影响其他卡", async () => {
  const p = makePlugin();
  const adapter = p.app.vault.adapter as MemAdapter;
  adapter.write(
    "Pot/anki/anki_1.md",
    "On earth #basic\n到底\n<!--ID: 555-->\n\n---\n\nDELETE\n<!--ID: 999-->"
  );
  adapter.write("Pot/anki_card.md", "DELETE\n<!--ID: 999-->\n\n---\n\n");

  await p.consolidateBuffer();

  const f1 = parseCards(adapter.read("Pot/anki/anki_1.md"));
  assert.ok(!f1.some((c) => c.front === "DELETE"), "DELETE 标记卡应从分页文件移除");
  assert.strictEqual(f1.find((c) => c.front === "On earth")?.id, "555", "正常卡保留");
  assert.strictEqual(adapter.read("Pot/anki_card.md"), "", "标记卡从缓冲池清除");
});

test("整理流程：缓冲池 DELETE 标记按 ID 删除分页卡", async () => {
  const p = makePlugin();
  const adapter = p.app.vault.adapter as MemAdapter;
  adapter.write(
    "Pot/anki/anki_1.md",
    "On earth #basic\n到底\n<!--ID: 555-->\n\n---\n\nKEEP #basic\n保留卡\n<!--ID: 777-->"
  );
  adapter.write("Pot/anki_card.md", "DELETE\n<!--ID: 555-->\n\n---\n\n");

  await p.consolidateBuffer();

  const f1 = parseCards(adapter.read("Pot/anki/anki_1.md"));
  assert.strictEqual(f1.length, 1, "按 ID 删除对应卡");
  assert.strictEqual(f1[0].front, "KEEP", "其他卡不受影响");
  assert.strictEqual(adapter.read("Pot/anki_card.md"), "", "标记卡从缓冲池清除");
});

test("整理流程：背面为空的卡由 LLM 补中文翻译", async () => {
  const p = makePlugin();
  const adapter = p.app.vault.adapter as MemAdapter;
  adapter.write(
    "Pot/anki_card.md",
    bufferText([["TO BE A SPARE, IN CASE SOMETHING HAPPENED.", ""]])
  );
  p.callLLM = async () => [
    { i: 0, en: "To be a spare, in case something happened.", zh: "成为一个备用品，以防发生什么意外。" },
  ];

  await p.consolidateBuffer();

  const all = parseCards(adapter.read("Pot/anki/anki_1.md"));
  assert.strictEqual(all[0].front, "To be a spare, in case something happened.");
  assert.strictEqual(all[0].back, "成为一个备用品，以防发生什么意外。");
  assert.strictEqual(adapter.read("Pot/anki_card.md"), "");
});

test("整理流程：未配置 API Key 时普通卡留池，【】标记卡仍直通", async () => {
  const p = makePlugin({ llmApiKey: "" });
  const adapter = p.app.vault.adapter as MemAdapter;
  adapter.write(
    "Pot/anki_card.md",
    bufferText([
      ["A NEW SENTENCE HERE.", "新句子。"],
      ["WHAT 【ON EARTH：到底】 IS THIS?", "这到底是什么？"],
    ])
  );
  Notice.reset();
  await p.consolidateBuffer();

  const buffer = adapter.read("Pot/anki_card.md");
  assert.ok(buffer.includes("A NEW SENTENCE HERE."), "无 Key 时普通卡留在缓冲池");
  assert.ok(!buffer.includes("ON EARTH"), "【】标记卡无需 LLM，照常整理");
  const all = parseCards(adapter.read("Pot/anki/anki_1.md"));
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].front, "What on earth is this?");
  assert.ok(Notice.messages.some((m) => m.includes("API Key")), "应有未配置提示");
});

test("整理流程：开始/进行中/结束提示，进行中拒绝重复触发", async () => {
  const p = makePlugin();
  const adapter = p.app.vault.adapter as MemAdapter;
  adapter.write(
    "Pot/anki_card.md",
    bufferText([
      ["TIED FOR IST PLACE.?", "并列第一？"],
      ["A NEW SENTENCE HERE.", "新句子。"],
    ])
  );
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  p.callLLM = async () => {
    await gate; // 卡住第一轮，模拟长耗时
    return [
      { i: 0, en: "Tied for 1st place?", zh: "并列第一？" },
      { i: 1, en: "A new sentence here.", zh: "新句子。" },
    ];
  };
  Notice.reset();
  const first = p.consolidateBuffer(); // 第一轮进行中
  await p.consolidateBuffer(); // 第二轮应被拒绝
  assert.ok(Notice.messages.some((m) => m.includes("正在进行中")), "重复触发应有拒绝提示");
  release();
  await first;
  assert.ok(Notice.messages.some((m) => m.startsWith("整理开始")), "应有开始提示");
  assert.ok(Notice.messages.some((m) => m.includes("正在规范化")), "应有进行中提示");
  assert.ok(Notice.messages.some((m) => m.startsWith("整理完成")), "应有结束提示");
});

test("整理流程：无 ID 的 DELETE 标记不成为新卡", async () => {
  const p = makePlugin();
  const adapter = p.app.vault.adapter as MemAdapter;
  adapter.write("Pot/anki_card.md", bufferText([["DELETE", ""]]));
  p.callLLM = async () => [];

  await p.consolidateBuffer();

  assert.strictEqual(adapter.read("Pot/anki_card.md"), "", "缓冲池清空");
  assert.ok(!adapter.files.has("Pot/anki/anki_1.md"), "不产出 DELETE 卡");
});

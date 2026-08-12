// LLM 规范化（OpenAI 兼容 API，纯 Node 实现，无 obsidian 依赖）
import * as http from "http";
import * as https from "https";

export interface LLMOut {
  i: number;
  en: string; // 规范化后的英文正面
  zh: string; // 规范化后的中文背面
}

export interface LLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export const LLM_BATCH = 20;

// 容错：Base URL 可填根地址（https://api.deepseek.com/v1）或完整接口地址（https://api.deepseek.com/chat/completions）
export function chatCompletionsUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (!base) throw new Error("未配置 LLM Base URL");
  return base.endsWith("/chat/completions") ? base : base + "/chat/completions";
}

function postJson(
  url: string,
  payload: string,
  headers: Record<string, string>,
  timeoutMs = 90000
): Promise<{ status: number; body: string }> {
  const m = url.match(/^(https?):\/\/([^/:]+)(?::(\d+))?(\/[^#]*)?$/);
  if (!m) return Promise.reject(new Error("无效的接口地址: " + url));
  const scheme = m[1];
  const host = m[2];
  const port = m[3] ? parseInt(m[3], 10) : scheme === "https" ? 443 : 80;
  const path = m[4] || "/";
  const request = (scheme === "https" ? https.request : http.request) as typeof http.request;
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host,
        port,
        path,
        method: "POST",
        headers: { ...headers, "Content-Length": Buffer.byteLength(payload) },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("LLM 请求超时")));
    req.write(payload);
    req.end();
  });
}

export function parseLLMJson(content: string): LLMOut[] {
  const cleaned = content.replace(/```[a-z]*/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1) throw new Error("LLM 返回不是 JSON 数组");
  const parsed: unknown = JSON.parse(cleaned.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error("LLM 返回不是 JSON 数组");
  const out: LLMOut[] = [];
  for (const r of parsed) {
    if (!r || typeof r !== "object") continue;
    const i = (r as { i?: unknown }).i;
    const en = (r as { en?: unknown }).en;
    const zh = (r as { zh?: unknown }).zh;
    if (typeof i !== "number" || typeof en !== "string" || typeof zh !== "string") continue;
    out.push({ i, en, zh });
  }
  return out;
}

export async function callLLM(
  cfg: LLMConfig,
  sents: { i: number; en: string; zh: string }[]
): Promise<LLMOut[]> {
  if (!cfg.apiKey) throw new Error("未配置 LLM API Key");
  const endpoint = chatCompletionsUrl(cfg.baseUrl);
  const system =
    "你是英语学习卡片规范化助手。用户给你英文学习卡片的正面（en：英文句子或单词，可能折行、全大写、有拼写/标点错误）" +
    "和背面（zh：中文翻译，可能折行）。你把每张卡规范化成一张干净的学习卡。\n" +
    "规则：\n" +
    "1. en 返回规范化后的英文正面：合并断行成一句话，修正拼写/标点/大小写（首字母大写、其余小写，人名地名等专有名词保持大写），去除多余空格。en 是单词时保持单词形式。\n" +
    "2. zh 返回规范化后的中文背面：合并断行、修正明显错别字，多句之间用 <br> 分隔；若 zh 为空，把 en 翻译成中文填入。\n" +
    "3. 只做清理和措辞精简，不得改变句子含义、不得换成其他短语、不得新增释义、例句或学习点。\n" +
    "4. 无需修改的卡片原样返回。\n" +
    '5. 只返回 JSON 数组：[{"i": 序号, "en": "...", "zh": "..."}]，不要输出其他内容。';
  const { status, body } = await postJson(
    endpoint,
    JSON.stringify({
      model: cfg.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(sents) },
      ],
      temperature: 0.2,
    }),
    { "Content-Type": "application/json", Authorization: "Bearer " + cfg.apiKey }
  );
  if (status !== 200) throw new Error("LLM HTTP " + status + ": " + body.slice(0, 300));
  const json: { choices?: { message?: { content?: unknown } }[] } = JSON.parse(body);
  const content = json?.choices?.[0]?.message?.content ?? "";
  return parseLLMJson(String(content));
}

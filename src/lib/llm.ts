// LLM 提取（OpenAI 兼容 API，纯 Node 实现，无 obsidian 依赖）
import * as http from "http";
import * as https from "https";

export interface LLMPoint {
  front: string;
  back: string;
}

export interface LLMOut {
  i: number;
  en?: string; // 修正后的句子
  points: LLMPoint[];
}

export interface LLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  extractCount: number;
}

export const LLM_BATCH = 20;

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
    const points = (r as { points?: unknown }).points;
    const en = (r as { en?: unknown }).en;
    if (typeof i !== "number" || !Array.isArray(points)) continue;
    const pts: LLMPoint[] = [];
    for (const p of points) {
      if (!p || typeof p !== "object") continue;
      const front = (p as { front?: unknown }).front;
      if (typeof front !== "string" || !front) continue;
      pts.push({ front, back: String((p as { back?: unknown }).back ?? "") });
    }
    out.push({ i, en: typeof en === "string" ? en : undefined, points: pts });
  }
  return out;
}

export async function callLLM(
  cfg: LLMConfig,
  sents: { i: number; en: string; zh: string }[]
): Promise<LLMOut[]> {
  if (!cfg.apiKey) throw new Error("未配置 LLM API Key");
  const base = cfg.baseUrl.trim().replace(/\/+$/, "");
  if (!base) throw new Error("未配置 LLM Base URL");
  const n = Math.max(1, cfg.extractCount);
  const system =
    "你是英语学习卡片生成器。用户给你漫画对话中的英文句子（可能全大写、含拼写/标点错误）及其中文翻译，" +
    "你提取值得学习的单词或语法表达。\n" +
    "规则：\n" +
    "1. 修正每句的拼写/标点/大小写问题，作为 en 字段返回（首字母大写，其余小写）。\n" +
    "2. 每句最多提取 " +
    n +
    " 个学习点（points）；没有值得学的返回空数组。\n" +
    "3. 单词的 front 用原形（lemma），如 soaring → soar。\n" +
    "4. front 用句子大小写。\n" +
    "5. back 是中文释义：单词以词性开头（如 \"n. 练习生\"、\"v. 翱翔\"）；语法/表达标出类型（如 \"phr. 更不用说\"）并可加简短用法说明。\n" +
    '6. 只返回 JSON 数组：[{"i": 句子序号, "en": "修正后的句子", "points": [{"front": "...", "back": "..."}]}]，不要输出其他内容。';
  const { status, body } = await postJson(
    base + "/chat/completions",
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

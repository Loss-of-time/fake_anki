// 去重/合并（纯函数）
import { Card } from "./cards";

function normKey(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

// 背面格式契约：释义 + 例：例句，以 <br> 分隔
export function meaningOf(back: string): string {
  // 释义 = 第一条 "例：" 之前的内容
  const i = back.indexOf("例：");
  if (i === -1) return back.trim();
  return back.slice(0, i).replace(/<br>\s*$/, "").trim();
}

export function exampleLinesOf(back: string): string[][] {
  const lines: string[][] = [];
  const re = /例：([\s\S]*?)(?=<br>例：|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(back))) {
    const parts = m[1].split("<br>").map((s) => s.trim()).filter(Boolean);
    if (parts.length) lines.push(parts);
  }
  return lines;
}

// 去重键：正面 + 释义（词按原型/表达判重，释义不同视为不同卡）
export function cardKey(c: Card): string {
  return normKey(c.front) + "|" + normKey(meaningOf(c.back));
}

// 命中重复时合并例句；返回是否合并成功（例句重复或已达上限返回 false）
export function mergeExample(card: Card, en: string, zh: string, maxExamples: number): boolean {
  const lines = exampleLinesOf(card.back);
  for (const l of lines) {
    if (normKey(l[0]) === normKey(en)) return false;
  }
  if (lines.length >= maxExamples) return false;
  card.back = card.back + "<br>例：" + en + (zh ? "<br>" + zh : "");
  return true;
}

// 去重/判键（纯函数）
import { Card } from "./cards";

function normKey(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

// 背面释义 = 第一条 "例：" 之前的内容（旧版例句合并在背面上，判重时忽略例句）
export function meaningOf(back: string): string {
  const i = back.indexOf("例：");
  if (i === -1) return back.trim();
  return back.slice(0, i).replace(/<br>\s*$/, "").trim();
}

// 去重键：正面 + 释义（内容不同视为不同卡）
export function cardKey(c: Card): string {
  return normKey(c.front) + "|" + normKey(meaningOf(c.back));
}

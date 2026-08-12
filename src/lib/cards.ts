// 卡片解析/序列化（纯函数，无 obsidian 依赖）

export interface Card {
  front: string; // 正面文本（不含 #basic 标签）
  back: string;
  id?: string; // 已有 <!--ID: ...--> 注释（合并时保留）
}

export const CARD_SEP = "\n\n---\n\n";

export function parseCards(text: string): Card[] {
  const cards: Card[] = [];
  for (const block of text.split(/\n---\n/)) {
    const b = block.trim();
    if (!b || b.startsWith("```")) continue; // 跳过 debug 代码块
    let body = b;
    let id: string | undefined;
    const idMatch = body.match(/<!--ID: (\d+)-->/);
    if (idMatch) {
      id = idMatch[1];
      body = body.replace(/<!--ID: \d+-->/, "").trim();
    }
    const lines = body.split("\n");
    const front = lines[0].replace(/\s*#basic\s*$/, "").trim();
    const back = lines.slice(1).join("\n").trim();
    if (!front && !back) continue;
    cards.push({ front, back, id });
  }
  return cards;
}

export function serializeCard(c: Card): string {
  const idLine = c.id ? "\n<!--ID: " + c.id + "-->" : "";
  return c.front + " #basic\n" + c.back + idLine;
}

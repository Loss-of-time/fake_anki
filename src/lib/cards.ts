// 卡片解析/序列化（纯函数，无 obsidian 依赖）

export interface Card {
  front: string; // 正面文本（不含 #basic 标签）
  back: string;
  id?: string; // 已有 <!--ID: ...--> 注释（合并时保留）
}

export const CARD_SEP = "\n\n---\n\n";

// obsidian-to-anki 删除约定：首行 DELETE + <!--ID: ...--> 注释 = 标记该卡删除
// 精确匹配大写 DELETE，避免误删小写 delete 单词卡
export function isDeleteMarker(c: Card): boolean {
  return c.front.trim() === "DELETE";
}

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
    // 正面 = 从开头到 #basic 标记行为止的所有行（折行的句子不再被截断）；无标记时取第一行
    let frontEnd = 0;
    for (let i = 0; i < lines.length; i++) {
      if (/#basic\s*$/.test(lines[i])) {
        frontEnd = i;
        break;
      }
    }
    const front = lines.slice(0, frontEnd + 1).join("\n").replace(/\s*#basic\s*$/, "").trim();
    const back = lines.slice(frontEnd + 1).join("\n").trim();
    if (!front && !back) continue;
    cards.push({ front, back, id });
  }
  return cards;
}

export function serializeCard(c: Card): string {
  const idLine = c.id ? "\n<!--ID: " + c.id + "-->" : "";
  return c.front + " #basic\n" + c.back + idLine;
}

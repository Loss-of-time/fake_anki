// 【】标记提取（纯函数）

export function extractMarked(front: string): { word: string; meaning: string }[] {
  const tokens: { word: string; meaning: string }[] = [];
  const re = /【([^】]+)】/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(front))) {
    const content = m[1].trim();
    const ci = content.indexOf("：");
    const word = (ci === -1 ? content : content.slice(0, ci)).trim();
    const meaning = ci === -1 ? "" : content.slice(ci + 1).trim();
    if (word) tokens.push({ word, meaning });
  }
  return tokens;
}

export function stripMarkers(s: string): string {
  // 例句中保留被标记的词，去掉括号和【词：释义】中的释义部分
  return s
    .replace(/【([^】：]+)：[^】]*】/g, "$1")
    .replace(/【([^】]+)】/g, "$1");
}

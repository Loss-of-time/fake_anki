// 文本规范化（纯函数）

export function fixText(s: string): string {
  return s
    .replace(/\s+([,.?!;:])/g, "$1 ") // 标点前的空格
    .replace(/\.([?!,])/g, "$1") // ".?" 这类错标点
    .replace(/\s+/g, " ")
    .trim();
}

export function sentenceCase(s: string): string {
  const t = fixText(s).toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

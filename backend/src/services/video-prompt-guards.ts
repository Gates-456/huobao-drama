/**
 * 视频提示词全局负向约束（代码级默认，幂等追加）
 * 目标：无论 LLM 拆镜写了什么、用户手写什么，最终提交给视频模型的提示词都带上：
 *   1. 禁止任何字幕/屏幕文字/水印
 *   2. 禁止旁白、画外音、解说等额外配音
 *   3. 仅提示词明确写出的台词允许发声，无台词镜头保持安静（防乱讲话）
 * 双层收口：generation.ts（generateVideo 落库前）与 comfyui-video.ts（工作流组装兜底）都调用本模块，
 * 由 hasVideoNegativeGuard 幂等去重，不会重复追加。
 */

/** 幂等检测标记：追加文本中的固定短语 */
const GUARD_MARKER = '画面保持纯净'

/**
 * 负向约束注入策略（2026-11-05 实测教训）：
 * 直接写「严禁出现字幕」等否定句会被 H3 当作字幕内容渲染到画面上（task-477 事故）。
 * 因此后缀只写正向诉求（画面纯净、无文字元素、安静），避开「字幕」等否定句式关键词；
 * 强禁令由提示词规范层（L1/L2，写入 LLM instructions）在生成阶段就拦住，不进视频 prompt。
 */
const GUARD_SUFFIX = '。画面保持纯净：无任何文字元素、无符号标注、无印章图形；'
  + '声音只包含画面人物自然说出的台词与环境音，台词之外保持安静；'
  + '人物面部清晰锐利、对焦准确，动作细节清楚。'

export function hasVideoNegativeGuard(prompt: string | null | undefined): boolean {
  return String(prompt || '').includes(GUARD_MARKER)
}

/** 幂等追加负向约束；空提示词原样返回（不改变上游空值校验行为） */
export function appendVideoNegativeGuard(prompt: string | null | undefined): string {
  const text = String(prompt || '')
  if (!text.trim()) return text
  if (hasVideoNegativeGuard(text)) return text
  return text + GUARD_SUFFIX
}

/**
 * 台词引号剥离（2026-11-05 第二次教训，task-500 事故）：
 * 「赌客甲说：「又跌了！…」」中的直角引号会被 H3 连同台词文本一起渲染成画面底部字幕
 * （字幕上原样带「」符号）。「说：「…」」格式是字幕渲染的强触发模式。
 * 修复：提交前把台词引号替换为逗号引导（赌客甲说，又跌了！…。），语义不变、触发消失。
 * 仅剥离引号符号本身，不动台词文字。
 *
 * 「说：」冒号归一（2026-11-05 第三次教训，task-509 事故）：
 * 剥引号后字幕仍出现（无引号版）——「说：」冒号+文本块是独立触发模式，
 * 冒号会被理解为「引出展示文本」。归一为逗号：赌客甲说，又跌了！…。
 */
const QUOTE_CHARS = /["'「」『』“”«»]/g

export function stripQuoteMarks(prompt: string): string {
  return prompt.replace(QUOTE_CHARS, '')
}

/** 「说：」「道：」等冒号引导统一归一为逗号（防冒号+文本块触发字幕渲染） */
export function normalizeDialogueColon(prompt: string): string {
  return prompt
    .replace(/(说|道|喊|问|答|念|嘀咕|低语|嘶吼|呐喊|冷笑道|苦笑道|自嘲道)：/g, '$1，')
    .replace(/(says?|said|shouts?|asks?|replies?)\s*:\s*/gi, '$1, ')
}

/** 生成前完整归一化：引号剥离 + 冒号归一 + 守卫追加 */
export function sanitizeVideoPrompt(prompt: string | null | undefined): string {
  let text = String(prompt || '')
  if (!text.trim()) return text
  text = stripQuoteMarks(text)
  text = normalizeDialogueColon(text)
  return appendVideoNegativeGuard(text)
}

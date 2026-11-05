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

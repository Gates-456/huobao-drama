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
 *
 * 2026-11-09 静默句式修正（乱说台词根因之二）：
 * 旧句「声音只包含画面人物自然说出的台词与环境音」在无台词镜暗示「会有台词」，
 * 诱导模型即兴开口。改用官方旁白示例的正向静默机制（base-en.txt §4.4）：
 * `while his lips remain completely closed` —— 人物嘴唇保持闭合 + 只有环境音。
 *
 * 2026-11-11 音景声明（项目21全量38镜筛查后定稿，无台词镜吟诵/群像配音根因）：
 * 22 个无台词镜中 10 镜出现旁白腔吟诵人声（空镜被配解说腔）、群像镜出现即兴
 * 对话声（t634 帧证张嘴+nsr=0.01 真人声）——根因是 H3 `audio_mode: native`
 * 对未声明音景的镜头自由发挥。官方 §4.6 要求 overall_soundscape 显式声明。
 *
 * 2026-11-11 四轮定稿（官方三字段机制，task-642 残余吟诵根因）：
 * 官方指南 §2.2 明文提示词三字段结构：integrated_multimodal_description /
 * overall_soundscape / non_diegetic_music。环境音必须写在 `overall_soundscape:`
 * 独立字段（模型把它路由到音频条件器）；内联在正文里的环境音描述会被当
 * 旁白稿吟出（t642「终合检承摩」≈「衣料摩擦」被吟，帧证 2.4s 幻现人脸）。
 * 定稿守卫句：正文只保留画面诉求；音景走官方字段；§4.4 不说话角色不配
 * speaker ID；§4.6 允许非语言人声（远处人群嗡嗡属合法音景）。
 */
const GUARD_SUFFIX = '。画面保持纯净：无任何文字元素、无符号标注、无印章图形；'
  + '画内人物嘴唇保持自然闭合、神情专注，人物面部清晰锐利、对焦准确，动作细节清楚。'
  + ' overall_soundscape：风声掠过石墙，脚步落在石板上，衣料摩擦声。non_diegetic_music：N/A'

/**
 * 台词禁项（终解 2026-11-09，替代 533 形态）：
 * 533 实证：禁止项贴近台词才对字幕有效（全局后缀远离台词无效，500/509/510/511 四连出字幕）。
 * 但 533 形态把禁止项放进 <d> 标签内部——官方指南 §4.4 明文「Inside <d>, include only
 * the language tag and the actual user-provided spoken content」，标签内全部文字会被 TTS
 * 念出 → 配音会念「不要字幕、不要水印…」（新事故）。
 * 官方旁白示例给出标签外指令区机制：`...says in an off-screen voiceover: <d>[English]...</d>
 * while his lips remain completely closed.` —— </d> 之后紧邻文字是发声指令区，不被念出。
 * 因此把禁止项移到每个 </d> 之后紧邻位置：保留「贴近台词」的有效距离属性，又不进发声通道。
 */
const D_TAIL_PROHIBITION = '。画面纯净：无文字元素、无水印、五官保持稳定不变。'

/**
 * 将禁项注入到每个 </d> 闭合标签之后（紧邻，标签外指令区）。
 * 幂等：闭合标签后已带禁项则跳过；块内已有【禁止项】（533 旧形态）则先移出标签再落位。
 */
export function injectInDProhibition(prompt: string): string {
  if (!prompt.includes('</d>')) return prompt
  const PROH = '【禁止项】'
  let out = ''
  let i = 0
  while (i < prompt.length) {
    if (prompt.startsWith('<d>', i)) {
      const close = prompt.indexOf('</d>', i)
      if (close === -1) { out += prompt.slice(i); break }
      let body = prompt.slice(i + 3, close)
      // 533 旧形态清洗：标签内的【禁止项】…段必须移出（否则被 TTS 念出）
      const prohIdx = body.indexOf(PROH)
      let legacy = ''
      if (prohIdx !== -1) {
        legacy = body.slice(prohIdx)
        body = body.slice(0, prohIdx)
        // 清掉残留的旧句尾标点，保持台词体干净
        body = body.replace(/[。，,]\s*$/, '')
      }
      out += '<d>' + body + '</d>'
      i = close + 4
      // 闭合后若已带新禁项（幂等）则原样；否则注入（旧残留 legacy 丢弃，统一归一为新句式）
      if (!prompt.startsWith(D_TAIL_PROHIBITION, i)) out += D_TAIL_PROHIBITION
      continue
    }
    out += prompt[i]
    i++
  }
  return out
}

export function hasVideoNegativeGuard(prompt: string | null | undefined): boolean {
  return String(prompt || '').includes(GUARD_MARKER)
}

/** 幂等追加负向约束；空提示词原样返回（不改变上游空值校验行为）。
 * 追加前归一接缝叠标点（台词/禁项句终+守卫句首产生「。。」「！。」）。 */
export function appendVideoNegativeGuard(prompt: string | null | undefined): string {
  let text = String(prompt || '')
  if (!text.trim()) return text
  text = text.replace(/([。！？.!?])[。]+\s*$/g, '$1')
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

/** 「说：」「道：」等冒号引导统一转成官方 <d> 对话通道（引号与冒号+文本块都会触发字幕渲染）。
 * 2026-11-09 多 cue 闭合：第 2 条及以后的 cue 前先补 </d> 闭合上一台词体——
 * 否则上一 <d> 到段尾才闭合，cue 之间的叙事与后续台词全被卷进同一台词体被 TTS 念出（乱说台词根因）。
 * 动词短语整体捕获（含前缀修饰，如「大喊」「冷笑说」「压低声说」≤4字）：只匹配动词本身会把
 * 「大喊」拆成「大」+「喊」，残字被卷进上一台词体。台词体保持完整：整句台词
 * （含句终标点，如「又跌了！今天谁买谁赔死！」）留在同一 <d> 块内（task-533 验证形态）。 */
export function normalizeDialogueColon(prompt: string): string {
  let cueOpen = false
  return prompt
    .replace(/([^。！？；\n:：]{0,4}[说道喊问答念])[：:](?! *<d>)/g, (_m, phrase: string) => {
      const close = cueOpen ? '</d>' : ''
      cueOpen = true
      return `${close}${phrase}: <d>[中文]`
    })
    .replace(/([^.!?\n:]{0,30}\b(?:says?|said|shouts?|asks?|replies?|whispers?|mutters?)\b)\s*:\s*(?! *<d>)/gi, (_m, phrase: string) => {
      const close = cueOpen ? '</d>' : ''
      cueOpen = true
      return `${close}${phrase}: <d>[English] `
    })
}

/**
 * 台词 <d> 标签收口（官方规范，2026-11-05 网络调研后落地）：
 * H3 官方提示词指南（h3-prompt-writing base-en.txt §4.4/§4.5）：
 *  - 引号内文字 = 官方指定的「上屏文字」通道（sign/subtitle/neon 一律用引号包裹让模型画出来）
 *  - 台词唯一正确通道是 <d>[语言]...</d> 标签（纯语音，不上屏）
 * 我们此前用「」引号包台词，恰好踩进上屏通道 → 三次字幕事故的官方解释。
 * 本函数在冒号归一后，为段尾仍打开的台词体补闭合 </d>。
 * 多 cue 之间的闭合已由 normalizeDialogueColon 在每条新 cue 前完成；
 * 2026-11-09 修复：显式 </d> 出现后若段内还有未配对的 <d>，状态机正确推进（旧实现 index 步进错位）。
 */
export function closeDialogueTags(prompt: string): string {
  if (!prompt.includes('<d>')) return prompt
  // 台词体结束边界：叙事连接词 + 群像描写起始（周围人/众人/人群/人们+动作描写出现在
  // 台词体内 = 台词已说完，后面是叙事——不切会把群像叙述卷进台词体被 TTS 念出）。
  // cue 间闭合已由 normalizeDialogueColon 注入 </d> 保证；遇未闭合 <d> 再开新 cue
  // 时由下方状态机就地补闭合。注意不得用「画面/镜头」等常见词——会撞上禁项正文与
  // 叙事描述，把台词体拦腰截断。
  const CONNECTIVE = /(随后|接着|然后|紧接着|与此同时|周围[^，。；]{0,6}(说|喊|议论|笑)|众人|人群|人们)/
  let out = ''
  let i = 0
  let inTag = false
  while (i < prompt.length) {
    if (prompt.startsWith('<d>', i)) {
      if (inTag) out += '</d>'
      out += '<d>'
      inTag = true
      i += 3
      continue
    }
    if (prompt.startsWith('</d>', i)) {
      out += '</d>'
      inTag = false
      i += 4
      continue
    }
    if (inTag) {
      const rest = prompt.slice(i)
      // 边界必须出现在下一个标签记号之前（否则交给标签状态机处理）
      const nextTagIdx = [rest.indexOf('<d>'), rest.indexOf('</d>')].filter(n => n >= 0).sort((a, b) => a - b)[0] ?? -1
      const m = rest.slice(0, nextTagIdx === -1 ? undefined : nextTagIdx).match(CONNECTIVE)
      if (m && m.index !== undefined && m.index > 0) {
        out += rest.slice(0, m.index) + '</d>'
        inTag = false
        i += m.index
        continue
      }
    }
    out += prompt[i]
    i++
  }
  if (inTag) out += '</d>'
  return out
}

/**
 * 台词体提纯（官方 §4.4 标签纯度要求：Inside <d>, include only the language tag
 * and the actual spoken content）：
 * 保守清理——整句多句台词是合法形态（task-533 验证：「又跌了！今天谁买谁赔死！」单块两叹句），
 * 不得按句终标点截断；只做三件事：
 *  1. 保留/规范开头语言标签 [中文]/[English]…
 *  2. 去除首尾空白
 *  3. 剔除标签内 533 旧形态残留的【禁止项】…段（会被 TTS 念出，由 injectInDProhibition 统一在标签外重注）
 */
export function purifyDialogueBodies(prompt: string): string {
  if (!prompt.includes('<d>')) return prompt
  let out = ''
  let i = 0
  while (i < prompt.length) {
    if (prompt.startsWith('<d>', i)) {
      const close = prompt.indexOf('</d>', i)
      if (close === -1) { out += prompt.slice(i); break }
      let body = prompt.slice(i + 3, close).trim()
      const lang = body.match(/^\s*(\[[^\]]{1,20}\])/)
      if (lang) body = body.slice(lang[0].length).trim()
      // 533 旧形态残留：标签内【禁止项】…整段剔除（injectInDProhibition 会在标签外重注归一版）
      const prohIdx = body.indexOf('【禁止项】')
      if (prohIdx !== -1) body = body.slice(0, prohIdx).trim()
      out += '<d>' + (lang ? lang[1] : '') + body + '</d>'
      i = close + 4
      continue
    }
    out += prompt[i]
    i++
  }
  return out
}

/**
 * 无台词镜人声诱因清除（2026-11-11 第三轮，task-640/641 残余根因）：
 * ① 「环境声热闹」「笑声回响」是热闹暗示（H3 照着配人声）；② 「无角色开口」「画面
 * 无人说话」仍是否定句（H3 对否定句的处理是把被否定对象念出来——task-477/636 同源）；
 * ③ 人群嗡嗡句在无人群镜被误注入（「目光送走远去的少年们」是叙事不是画面人群）。
 * 修复：热闹/笑声词直接替换为环境音描述；否定人声句整体删除（守卫的嘴唇闭合+正向
 * 音景句已覆盖其职能）；嗡嗡句只在画面真正描述人群聚集时注入（收紧正则）。
 * 只处理无台词镜；台词镜的引导词已先被 normalizeDialogueColon 转走。
 */
export function demoteCrowdVocals(prompt: string): string {
  if (prompt.includes('<d>')) return prompt
  let out = prompt
  // 发声动词（说笑/说闹/交谈低语/议论/低喝/齐喝/呐喊/应喝/喧哗/念叨）→ 无声神态/背景嗡嗡声
  out = out
    .replace(/说笑/g, '相互笑语神态')
    .replace(/谈笑/g, '相互笑语神态')
    .replace(/低喝/g, '发力呼气神态')
    .replace(/齐喝/g, '齐声呼气神态')
    .replace(/应喝/g, '呼气回应神态')
    .replace(/议论/g, '交换眼色神态')
    .replace(/喧哗/g, '热闹走动')
    .replace(/念叨/g, '低声神态')
  // 热闹暗示 → 中性环境音（「环境声热闹」会诱导 H3 配人声垫底）
  out = out
    .replace(/环境声热闹/g, '画面安静')
    .replace(/笑声回响/g, '衣袂飘动')
    .replace(/，笑声不断/g, '')
    .replace(/笑声阵阵/g, '衣袂飘动')
  // 否定人声句整体删除：守卫后缀已有正向嘴唇闭合+音景句，这些否定句只会诱导念白
  out = out
    .replace(/[，。]?无角色开口/g, '')
    .replace(/[，。]?画面无人说话/g, '')
    .replace(/[，。]?无人说话/g, '')
    .replace(/[，。]?画面安静无台词/g, '画面安静')
    .replace(/[，。]?无人物无台词/g, '')
    .replace(/[，。]?无台词/g, '')
    .replace(/[，。]?无角色开口说话/g, '')
  // 人群嗡嗡句：官方 §4.6 允许音景含非语言人声；只在画面明确出现成群人群聚集时
  // 注入（「少年们三两成队」才扩大化误伤「目光送走远去的少年们」这类叙事），
  // 且落在 overall_soundscape 语义内（远处=不可辨词=合法非语言人声）
  if (/(少年们|众人|人群|人们|弟子们|族人)[^。]{0,12}(三两成队|列成方阵|成群|聚集|围在|簇拥)/.test(out) && !out.includes('嗡嗡')) {
    out += '。远处人群的轻微嗡嗡声混入风声。'
  }
  return out
}

/** 生成前完整归一化：引号剥离 → 冒号转 <d> 对话通道 → 闭合标签 → 台词体提纯 → 群像配音降级 → 标签外禁项 → 守卫追加 */
export function sanitizeVideoPrompt(prompt: string | null | undefined): string {
  let text = String(prompt || '')
  if (!text.trim()) return text
  text = stripQuoteMarks(text)
  text = normalizeDialogueColon(text)
  text = closeDialogueTags(text)
  text = purifyDialogueBodies(text)
  text = demoteCrowdVocals(text)
  text = injectInDProhibition(text)
  return appendVideoNegativeGuard(text)
}

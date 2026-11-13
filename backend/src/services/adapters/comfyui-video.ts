/**
 * ComfyUI 视频 Adapter（MiniMax H3 本地工作流）
 * 适用于本地 ComfyUI 标准协议：
 * - 提交: POST /prompt { prompt: <API格式节点图>, client_id } -> { prompt_id }
 * - 轮询: GET  /history/{prompt_id} -> { [prompt_id]: { status, outputs } }
 * - 结果: GET  /view?filename=&subfolder=&type=output
 *
 * 工作流基于 minimax-h3-gguf-q8-opt 项目的 api_i2v_5s_seg.json / api_t2v_5s_seg.json：
 * - firstFrameUrl（首帧）: LoadImage -> node8.first_frame，task_type 自动变 I2VA/hybrid
 * - referenceImageUrls（角色/场景/道具参考图）: LoadImage -> node8.ref_images_N，
 *   task_type 自动变 Ref2VA/hybrid（conditioning.py resolve_task_type auto 模式）
 *   prompt 中可用 <Picture N> 标签引用（1-based，首帧占第1个）
 * - 分辨率 720p 档：1280x704（32 倍数，接近 16:9）
 * - 时长 -> length：24fps，17n+5 网格（如 5s=125? 实际 snap：n*17+5）
 *   5s -> length=121（5.04s 官方 5s 档），10s -> 241
 * 仅支持 MiniMax-H3 系列模型名（与其它 adapter 的校验约定一致）。
 */
import type {
  VideoProviderAdapter,
  ProviderRequest,
  AIConfig,
  VideoGenerationRecord,
  VideoGenResponse,
  VideoPollResponse,
} from './types'
import { joinProviderUrl } from './url'
import { sanitizeVideoPrompt } from '../video-prompt-guards'

const H3_MODEL_PREFIX = 'minimax-h3'
const DEFAULT_MODEL = 'MiniMax-H3'

/** H3 turbo 工作流固定参数。
 *  fps=24（2026-10-29 定稿）：H3 模型原生 24fps，音频 latent 长度 = length/24 秒（core.py 硬编码）。
 *  之前 15fps/151帧 方案：视频播放 10s 但音频只覆盖 151/24=6.29s，尾部 3.7s 静音（音画"不同步"实为音频提前结束）。
 *  改回 24fps + duration 5s（length=125）：音频覆盖 125/24=5.21s ≥ 视频 5.0s，全程有声；
 *  且 video_latent_t=37 < 151 帧的 42，显存更安全（1024x576 峰值 ~8GB）。 */
const WORKFLOW_PARAMS = {
  unet: 'MiniMax-H3-FL2VA-Pruned-Q8_0.gguf',
  clip: 'qwen3vl_32b_minimax_h3_int8_convrot.safetensors',
  videoVae: 'minimax_h3_video_vae_fp16.safetensors',
  audioVae: 'minimax_h3_audio_vae_fp32.safetensors',
  lora: 'minimax_h3_turbo_v4_step600_ema.safetensors',
  fps: 24,
  // steps 6→8（2026-11-05）：turbo v4 lora 支持 4~8 步，加步改善高频收敛，
  // 缓解人脸/动作模糊（实测 325s/步 → 8 步约 44 分钟/镜，用户已确认接受 6-7 分钟级耗时）
  steps: 8,
  splitDevices: 'cuda:0,cuda:1',
  splitAtBlock: 25,
  blockCounts: '25,25',
  clipDevice: 'cuda:2',
  vaeDevice: 'cuda:3',
}

/** 分辨率档位（宽高均需 32 倍数）。默认 1024x576（2026-10-28 实测通过的稳定档，16:9）。
 *  1080p 档 1152x640 实测：采样 157s/步（较 1024 档 ~80s/步 翻倍）、显存 14.5+13.3GB 逼近上限，
 *  且无帧率提升余量 —— 仅作记录，勿批量使用。 */
const RESOLUTIONS: Record<string, { width: number; height: number }> = {
  '768p': { width: 1024, height: 576 },
  '720p': { width: 1024, height: 576 },
  '1080p': { width: 1152, height: 640 },
}

const REF_LIMIT = 9

let clientIdCounter = 0

function nextClientId(): string {
  clientIdCounter += 1
  return `huobao-${Date.now()}-${clientIdCounter}`
}

function parseDataUrl(dataUrl: string): { mime: string; base64: string } | null {
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(dataUrl.trim())
  if (!m) return null
  return { mime: m[1], base64: m[2] }
}

/** 参考图防渗入后缀：明确参考图仅用于身份/风格，禁止白底设定图、多视图排版出现在成片 */
function refLeakGuard(): string {
  return ('。参考图片仅用于人物身份与场景光照参考。'
    + '画面必须是真实连续的实拍镜头：电影质感场景，严禁出现白色背景、'
    + '角色设定图、三视图排版、多视角拼图、画中画、描边线稿等任何参考图元素。')
}

/**
 * 参考图身份过滤与 <Picture N> 绑定句生成（修复双角色镜串脸）：
 * - labels: 参考图 URL -> 主体名（角色名或「场景 xxx」）
 * - 场景图一律保留（提供光照/环境参考，且常被转作首帧）；
 *   角色图仅在提示词明确提及该角色名时保留 —— 防止不在画内的主角图干扰单人特写镜。
 * - 返回过滤后的 refs 与形如「柜台伙计的外貌与服装严格按照<Picture 3>呈现。」的绑定句。
 *   Picture 序号 1-based：首帧（若有）为 <Picture 1>，ref_images 依次递增。
 */
function filterRefsByIdentity(
  prompt: string,
  refs: string[],
  labels: Record<string, string> | null | undefined,
  hasFirstFrame: boolean,
): { refs: string[]; identityHints: string[] } {
  if (!labels || !Object.keys(labels).length || !refs.length) return { refs, identityHints: [] }
  const kept: string[] = []
  const identityHints: string[] = []
  for (const ref of refs) {
    const name = labels[ref]
      ?? labels[ref.replace(/^\/+/, '')]
      ?? labels[`static/${ref.split('/').slice(-2).join('/')}`]
      ?? Object.entries(labels).find(([k]) => ref.endsWith(k.split('/').pop() || ''))?.[1]
    const isScene = !!name && name.startsWith('场景')
    if (!name || isScene) {
      kept.push(ref) // 无标签或场景图：保留，维持原行为
      continue
    }
    // 角色图：提示词必须提及该角色名（去掉 @ 前缀匹配）才保留
    if (!prompt.includes(name)) continue
    // <Picture 序号> = 首帧占 1（若有）+ kept 中已确定的 ref 数 + 1
    const ordinal = (hasFirstFrame ? 1 : 0) + kept.length + 1
    identityHints.push(`${name}的外貌与服装严格按照<Picture ${ordinal}>呈现，画面中不出现其他人物的脸。`)
    kept.push(ref)
  }
  return { refs: kept, identityHints }
}

/** 生成时长 -> H3 length（帧数）。24fps: 5s=121→snap 125（17n+5 网格，音频覆盖 125/24=5.21s ≥ 5s） */
function lengthForDuration(seconds: number): number {
  const fps = WORKFLOW_PARAMS.fps
  return Math.min(725, Math.max(25, Math.round(seconds * fps) + 1))
}

/**
 * 官方三字段结构转译（2026-11-11，空镜吟诵根治——官方指南 §2.2/§5.3）：
 * H3 官方最终 prompt 是固定三字段英文结构（字段名为英文原文）：
 *   integrated_multimodal_description: [Shot 1] ...
 *   overall_soundscape: ...
 *   non_diegetic_music: ...
 * 我们此前的中文正文+「overall_soundscape：」中文标签是形似——模型对非官方
 * 格式的遵循度弱，正文中的环境音词（风声/衣料摩擦）仍被当旁白稿吟出（t683）。
 * 本函数在 sanitize 之后执行，把中文 prompt 重排为官方结构：
 *  - 正文（去掉守卫尾巴）→ integrated_multimodal_description: 字段
 *  - 守卫句中的音景句剔除，音景统一写入 overall_soundscape: 字段（§4.6 要求写
 *    具体环境音 1-4 句，只有用户明确要求全程静默才写 N/A——上一版 N/A 是误用）
 *  - 末尾补 non_diegetic_music: N/A（无配乐需求）
 * @param prompt sanitize 后的完整 prompt（可能含「画面保持纯净…overall_soundscape：…」守卫段）
 * @param hasRefImages 是否挂参考图（Ref2VA 场景补 <Picture 1> 锚定句，官方 §5.3：
 *        the shot begins from <Picture 1> —— 告诉模型参考图是画面锚而非旁白素材，
 *        直击「场景图带匾额文字→脑补叙述者」的空镜吟诵根因）
 */
export function toOfficialFields(prompt: string, hasRefImages: boolean): string {
  const GUARD_HEAD = '画面保持纯净'
// 台词时机提示（2026-11-13 台词截断根治）：ep23 实测 H3 有效语速 ~3.2 字/s，
// 晚开口（长动作铺垫后）= 台词顶满 5.0s 被硬切。官方 §4.4 台词跟在动作后，
// 时间轴上越早开始越可能说完。仅台词镜（含 <d>）注入。
const DIALOGUE_TIMING_HINT = 'The character begins speaking as early as the action allows, with at most a brief one-second lead-in gesture before the dialogue starts, and the spoken line finishes comfortably before the video ends. '
  // 拆守卫段：正文 = 守卫头之前；守卫段里的 overall_soundscape 中文版丢弃（重写为官方英文段）
  const guardIdx = prompt.indexOf(GUARD_HEAD)
  const body = guardIdx >= 0 ? prompt.slice(0, guardIdx).replace(/[，,。]\s*$/, '') : prompt
  // 正文剔除残留音景词句（由官方字段接管）
  const bodyClean = body
    .replace(/画面纯净：无文字元素、无水印、五官保持稳定不变。?/g, '')
    .replace(/环境音只有[^；。]*[；。]?/g, '')
    .replace(/overall_soundscape：[^]*$/g, '')
    .replace(/[，,]\s*$/, '')
  const anchor = hasRefImages
    ? 'The shot begins from <Picture 1>, which defines the scene composition, palette, and set dressing; on-screen signage in the reference is background texture only, with no narrator and no spoken commentary. '
    : ''
  const timingHint = bodyClean.includes('<d>') ? DIALOGUE_TIMING_HINT : ''
  const bodyField = `integrated_multimodal_description: [Shot 1] Live-action, cinematic. ${anchor}${timingHint}${bodyClean.trim()}`
  const soundscape = 'overall_soundscape: Wind sweeps across stone ramparts and drifts through the valley; footsteps press on worn flagstones; fabric sways and brushes softly. No dialogue, no narration, and no vocal tones occur anywhere in the video.'
  return `${bodyField}\n\n${soundscape}\n\nnon_diegetic_music: N/A`
}

/** 构建工作流节点图（API 格式） */
function buildGraph(opts: {
  prompt: string
  seed: number
  durationSeconds: number
  width: number
  height: number
  firstFrameName?: string
  refImageNames: string[]
  prefix: string
}): { graph: Record<string, any>; uploads: Array<{ filename: string; base64: string }> } {
  const { prompt, seed, durationSeconds, width, height, firstFrameName, refImageNames, prefix } = opts
  const graph: Record<string, any> = {
    '1': { class_type: 'UnetLoaderGGUF', inputs: { unet_name: WORKFLOW_PARAMS.unet } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: WORKFLOW_PARAMS.clip, type: 'minimax', device: 'default' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: WORKFLOW_PARAMS.videoVae } },
    '4': { class_type: 'VAELoader', inputs: { vae_name: WORKFLOW_PARAMS.audioVae } },
    '5': { class_type: 'MiniMaxH3ModelParallel', inputs: {
      model: ['1', 0], split_devices: WORKFLOW_PARAMS.splitDevices, split_at_block: WORKFLOW_PARAMS.splitAtBlock,
      clip_device: WORKFLOW_PARAMS.clipDevice, vae_device: WORKFLOW_PARAMS.vaeDevice, clip: ['2', 0],
      vae: ['3', 0], token_refiner_device: 'cuda:0', block_counts: WORKFLOW_PARAMS.blockCounts,
    } },
    '6': { class_type: 'MiniMaxH3TurboLoRA', inputs: {
      // low_vram=true（merge 路径）：LoRA 增量 fold 进 Q8 权重，画质略软但与
      // MiniMaxH3ModelParallel 双卡拆分（cuda:0/cuda:1 各 25 blocks）兼容。
      // 实测 bypass(low_vram=false) 虽更锐利，但 bypass hook 与双卡 tensor 拆分冲突，
      // 9/9 失败：Expected all tensors to be on the same device (cuda:1 vs cuda:0)。
      // 若未来上单卡大显存机型可试 false 换取锐度。
      model: ['5', 0], lora_name: WORKFLOW_PARAMS.lora, strength: 1.0, low_vram: true,
    } },
    '7': { class_type: 'MiniMaxH3SigmaShift', inputs: { model: ['6', 0], shift_video: 12.0, shift_audio: 3.0 } },
    '8': { class_type: 'MiniMaxH3AudioConditioningT8', inputs: {
      clip: ['5', 1], video_vae: ['3', 0], audio_vae: ['4', 0],
      prompt,
      width, height, length: lengthForDuration(durationSeconds),
      task_type: 'auto', audio_mode: 'native', audio_denoise_strength: 0.15,
      add_source_as_reference: false, prompt_primary_audio_ordinal: 1,
      strict_prompt_tags: true, ref_image_size: 'match', reference_video_policy: 'official_2_to_15s',
    } },
    '9': { class_type: 'RandomNoise', inputs: { noise_seed: seed } },
    '10': { class_type: 'BasicGuider', inputs: { model: ['7', 0], conditioning: ['8', 0] } },
    '11': { class_type: 'MiniMaxH3TurboSampler', inputs: {} },
    '12': { class_type: 'BasicScheduler', inputs: { model: ['7', 0], scheduler: 'simple', steps: WORKFLOW_PARAMS.steps, denoise: 1.0 } },
    '13': { class_type: 'SamplerCustomAdvanced', inputs: {
      noise: ['9', 0], guider: ['10', 0], sampler: ['11', 0], sigmas: ['12', 0], latent_image: ['8', 1],
    } },
    '14': { class_type: 'MiniMaxH3AVDecodeT8', inputs: { av_latent: ['13', 0], video_vae: ['3', 0], audio_vae: ['4', 0] } },
    '15': { class_type: 'MiniMaxH3OutputTrimT8', inputs: {
      frames: ['14', 0], audio: ['14', 1], start_seconds: 0.0, duration_seconds: durationSeconds, fps: WORKFLOW_PARAMS.fps,
    } },
    '16': { class_type: 'VHS_VideoCombine', inputs: {
      images: ['15', 0], audio: ['15', 1], frame_rate: WORKFLOW_PARAMS.fps,
      loop_count: 0, filename_prefix: prefix, format: 'video/h264-mp4', pingpong: false, save_output: true,
    } },
  }

  const uploads: Array<{ filename: string; base64: string }> = []
  let nextNodeId = 20

  // 首帧: node18 -> node8.first_frame（exact frame 0）
  if (firstFrameName) {
    graph['8'].inputs.first_frame = ['18', 0]
    graph['18'] = { class_type: 'LoadImage', inputs: { image: firstFrameName } }
  }

  // 参考图: node20+ -> node8["ref_images.ref_image_N"]（Autogrow API 键名为 {输入id}.{模板名}，0-based）
  refImageNames.forEach((name, i) => {
    const nodeId = String(nextNodeId + i)
    graph[nodeId] = { class_type: 'LoadImage', inputs: { image: name } }
    graph['8'].inputs[`ref_images.ref_image_${i}`] = [nodeId, 0]
  })

  return { graph, uploads }
}

export class ComfyUIVideoAdapter implements VideoProviderAdapter {
  provider = 'comfyui'

  private currentBaseUrl = ''

  private viewUrl(baseUrl: string, filename: string, subfolder: string, type: string): string {
    const qs = `filename=${encodeURIComponent(filename)}&subfolder=${encodeURIComponent(subfolder)}&type=${encodeURIComponent(type)}`
    const base = (baseUrl || '').replace(/\/+$/, '')
    return `${base}/view?${qs}`
  }

  buildGenerateRequest(config: AIConfig, record: VideoGenerationRecord): ProviderRequest {
    this.currentBaseUrl = config.baseUrl
    const model = (record.model || config.model || DEFAULT_MODEL).toLowerCase()
    if (!model.startsWith(H3_MODEL_PREFIX)) {
      throw new Error(`ComfyUI 工作流仅支持 MiniMax H3 系列模型（MiniMax-H3*），当前: ${record.model || config.model}`)
    }

    const prompt = (record.prompt || '').trim()
    if (!prompt) throw new Error('ComfyUI 工作流要求必须提供提示词')

    // 参考图只用于角色身份/场景光照参考，禁止其内容（白底设定图、多视图排版等）出现在成片中
    const antiLeak = refLeakGuard()

    /** 需要上传的 dataURL 图片（generation.ts 在提交前逐个 POST /upload/image） */
    const uploads: Array<{ field: string; filename: string; base64: string }> = []
    const toUploadable = (raw: string, field: string, filename: string): string | undefined => {
      if (!raw) return undefined
      if (raw.startsWith('data:image/')) {
        const parsed = parseDataUrl(raw)
        if (!parsed) return undefined
        uploads.push({ field, filename, base64: parsed.base64 })
        return filename
      }
      return raw // 已是 ComfyUI input 目录中的文件名
    }

    // 首帧（显式指定优先）
    const firstFrameRaw = (record.firstFrameUrl || record.imageUrl || '').trim()
    let firstFrameName = toUploadable(firstFrameRaw, 'first', `huobao_i2v_${record.id}.png`)

    // 参考图（角色/场景/道具，保持身份）
    let refNames: string[] = []
    try {
      const refs = JSON.parse(record.referenceImageUrls || '[]')
      if (Array.isArray(refs)) {
        refNames = refs.slice(0, REF_LIMIT)
          .map((r: any) => String(r || '').trim())
          .filter(Boolean)
      }
    } catch { /* 忽略非法 JSON */ }

    // 身份过滤（labels 就绪时）：先按原始 URL 过滤出提示词提及的角色图，再走首帧/上传流程
    const identityPass = filterRefsByIdentity(
      prompt,
      refNames,
      record.referenceImageLabels,
      Boolean((record.firstFrameUrl || record.imageUrl || '').trim()),
    )
    refNames = identityPass.refs

    // 无显式首帧时，用第一张参考图（前端顺序=场景图优先，纯空镜）作 first_frame：
    // Ref2VA 多参考会把所有参考块铺在初始 latent 上造成首帧混叠，
    // 场景空镜做首帧+角色图做 ref_images 可同时获得干净开场与身份保持
    if (!firstFrameName && refNames.length > 0) {
      firstFrameName = toUploadable(refNames[0], 'first', `huobao_i2v_${record.id}.png`)
      refNames = refNames.slice(1)
    }
    // 转成可上传文件名
    refNames = refNames
      .map((r, i) => toUploadable(r, `ref_${i}`, `huobao_ref_${record.id}_${i}.png`))
      .filter((n): n is string => !!n)
      .slice(0, REF_LIMIT - 1)

    const seed = Number.isFinite(Number(record.seed)) && Number(record.seed) > 0
      ? Number(record.seed) : (Math.floor(Math.random() * 2_147_483_647) + 1)
    // 统一 10 秒（用户指定）：720p 10s=241帧。
    // 实测：GPU0(V100 16GB) 720p+12s OOM、8s OOM。10s 若 OOM 需降分辨率档或升级并行策略
    const duration = Math.min(5, Math.max(2, Number(record.duration) || 5))
    const res = RESOLUTIONS[(record.resolution || '720p').toLowerCase()] || RESOLUTIONS['720p']

    const built = buildGraph({
      prompt: toOfficialFields(
        sanitizeVideoPrompt(prompt + identityPass.identityHints.join('') + antiLeak),
        refNames.length > 0 || Boolean(firstFrameName),
      ),
      seed,
      durationSeconds: duration,
      width: res.width,
      height: res.height,
      firstFrameName,
      refImageNames: refNames,
      prefix: `huobao_task_${record.id}`,
    })

    return {
      url: joinProviderUrl(config.baseUrl, '', '/prompt'),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        prompt: built.graph,
        client_id: nextClientId(),
        // 自定义负载：generation.ts 提交前移除并执行上传（ComfyUI 忽略未知字段前先删）
        ...(uploads.length ? { __huobao_uploads: uploads } : {}),
      },
    }
  }

  parseGenerateResponse(result: any): VideoGenResponse {
    const promptId = result.prompt_id ?? result.task_id
    if (result.error) {
      const msg = result.error?.message || JSON.stringify(result.error)
      throw new Error(`ComfyUI 提交失败: ${msg}`)
    }
    if (promptId != null) return { isAsync: true, taskId: String(promptId) }
    throw new Error('No prompt_id in ComfyUI response')
  }

  buildPollRequest(config: AIConfig, taskId: string): ProviderRequest {
    this.currentBaseUrl = config.baseUrl
    return {
      url: joinProviderUrl(config.baseUrl, '', `/history/${taskId}`),
      method: 'GET',
      headers: {},
      body: undefined,
    }
  }

  parsePollResponse(result: any): VideoPollResponse {
    // /history/{id} 返回 { [id]: { status: { completed, status_str }, outputs } }
    const entry = result && typeof result === 'object' ? Object.values(result)[0] as any : null
    if (!entry) return { status: 'processing' }
    const status = entry.status || {}
    if (status.status_str === 'error') {
      const msgs = Array.isArray(status.messages)
        ? status.messages.filter((m: any[]) => m[0] === 'execution_error').map((m: any) => JSON.stringify(m[1] || m)).join('; ')
        : ''
      return { status: 'failed', error: msgs || 'ComfyUI execution error' }
    }
    const outputs = entry.outputs || {}
    // VHS_VideoCombine 输出键名为 gifs
    for (const nodeOut of Object.values(outputs) as any[]) {
      const videos = nodeOut?.gifs || nodeOut?.videos || nodeOut?.images
      if (Array.isArray(videos) && videos.length) {
        const v = videos.find((x: any) => /\.(mp4|webm|mov)$/i.test(x.filename || '')) || videos[0]
        if (v?.filename) {
          return {
            status: 'completed',
            videoUrl: this.viewUrl(this.currentBaseUrl || '', v.filename, v.subfolder || '', v.type || 'output'),
            duration: undefined,
          }
        }
      }
    }
    if (status.completed) {
      return { status: 'failed', error: 'ComfyUI completed but no video output found' }
    }
    return { status: 'processing' }
  }

  extractVideoUrl(result: any): string | null {
    const entry = result && typeof result === 'object' ? Object.values(result)[0] as any : null
    const outputs = entry?.outputs || {}
    for (const nodeOut of Object.values(outputs) as any[]) {
      const videos = nodeOut?.gifs || nodeOut?.videos || nodeOut?.images
      if (Array.isArray(videos) && videos.length) {
        const v = videos.find((x: any) => /\.(mp4|webm|mov)$/i.test(x.filename || '')) || videos[0]
        if (v?.filename) {
          return this.viewUrl(this.currentBaseUrl || '', v.filename, v.subfolder || '', v.type || 'output')
        }
      }
    }
    return null
  }
}

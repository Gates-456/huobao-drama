/** 视频成片负向约束运行时注入（代码级默认，设置页编辑/重置提示词文件也删不掉）。
 * Shared by first-time breakdown and single/batch video prompt generation,
 * appended AFTER base prompt file + skills so it overrides any legacy
 * narration guidance in older prompt/skill texts.
 */
const instructions: Record<string, string> = {
  zh: `## 视频成片负向约束（最高优先级，覆盖上文所有台词/旁白写法描述）
生成 video_prompt 时必须同时遵守：
1. 严禁字幕：画面中不得出现任何字幕、标题、屏幕文字、水印或文字元素；提示词中也不要提出字幕类诉求。
2. 严禁旁白配音：「旁白」只作为剧本信息保留在 description 里，绝不写入 video_prompt；成片不得有任何旁白、画外音、解说声。上文任何「旁白写『旁白：内容』」的描述对本约束无效。
3. 无台词必须安静：只有 video_prompt 中以「角色名说：「…」」明确写出的台词才允许发声；未写台词的镜头只保留环境音，严禁角色即兴开口、乱加对白、自言自语或哼唱。
4. 台词红线不变：台词仍从 description 提取，一字不增不减；只是旁白不再进入 video_prompt。`,
  en: `## Negative constraints for generated video (highest priority, overrides all dialogue/narration wording above)
1. No subtitles: the frame must contain no subtitles, titles, on-screen text, watermarks or any text elements; never request subtitles in the prompt.
2. No narration audio: narration stays only as script information in description and must NEVER enter video_prompt; the video must contain no voice-over, off-screen narration or commentary. Any earlier "write narration as ..." wording is void under this rule.
3. Silent unless scripted: only dialogue explicitly written as Character says: "..." in video_prompt may be spoken; shots without dialogue keep ambient sound only — no improvised speech, extra lines or humming.
4. Dialogue red line unchanged: dialogue still comes from description verbatim; only narration is excluded from video_prompt.`,
  ja: `## 動画生成のネガティブ制約（最優先・上記の台詞/ナレーション記述を全て上書き）
1. 字幕禁止：字幕・タイトル・画面内テキスト・透かし等の文字要素は一切禁止。プロンプトにも字幕関連の要求を書かない。
2. ナレーション音声禁止：ナレーションは description の脚本情報のみに留め、video_prompt には絶対に書かない。完成映像にナレーション・解説音声を含めてはならない。
3. 台詞なき shots は静かに：video_prompt に「キャラ名が「…」と言う」と明記された台詞のみ発話可。台詞のない shots は環境音のみで、即興の発話・追加台詞・ハミングを禁止。
4. 台詞の赤線は不変：台詞は description から一字一句そのまま抽出し、ナレーションのみ video_prompt から除外する。`,
  ko: `## 영상 네거티브 제약(최우선, 위의 모든 대사/내레이션 서술을 덮어씀)
1. 자막 금지: 자막, 제목, 화면 텍스트, 워터마크 등 문자 요소 일절 금지. 프롬프트에 자막 관련 요구를 쓰지 않는다.
2. 내레이션 음성 금지: 내레이션은 description의 대본 정보로만 남기고 video_prompt에 절대 쓰지 않는다. 완성 영상에 내레이션·해설 음성을 포함해서는 안 된다.
3. 대사 없으면 정적: video_prompt에 「캐릭터가 "…"라고 말한다」로 명시된 대사만 발화 가능. 대사 없는 숏은 환경음만 유지하고 즉흥 발화·추가 대사·허밍을 금지한다.
4. 대사 레드라인 불변: 대사는 description에서 한 글자도 바꾸지 않고 추출하되, 내레이션만 video_prompt에서 제외한다.`,
}

export function getVideoNegativeInstructions(agentType: string, language?: string | null): string {
  if (agentType !== 'prompt_generator' && agentType !== 'storyboard_breaker') return ''
  return instructions[language || 'zh'] || instructions.zh
}

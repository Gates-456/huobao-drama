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
3. 台词必须走 <d> 标签通道（H3 官方规范）：台词写成「角色名说: <d>[中文]台词</d>」，整句台词完整包裹在 <d>...</d> 内，不得省略闭合标签。
4. <d> 标签纯度（⚠️ 配音念禁令事故根因，H3 官方 §4.4 明文）：标签内只允许「[语言标签]+台词原文」，任何其他文字（禁止项、画面约束、说明性指令）写在标签内都会被 TTS 念出来。画面约束写在该台词 </d> 闭合标签之后、紧邻位置（官方旁白示例形态：...</d> while his lips remain completely closed）。
5. 无台词镜音景走官方字段（⚠️ 空镜吟诵/群像配音/守卫句被念/内联音景被吟四类事故根因，官方 §2.2 三字段结构）：无台词镜头的正文（integrated_multimodal_description）不写任何环境音/声音描述——H3 会把正文里的声音词当旁白稿吟出来；声音交给管线追加的 overall_soundscape 字段。严禁发声/喧闹词（说笑、低喝、议论、低语、念叨、热闹），严禁否定句（无角色开口、无人说话、没有对白、没有任何X——会被当内容念出来甚至烧成字幕）；群像动作只写神态/姿态，不写声音；按官方 §4.4，不说话的角色不配说话人 ID。
6. 严禁引号包裹台词（⚠️ 三次字幕事故根因）：H3 官方机制（提示词指南 §4.5）——prompt 中引号（「」『』""''）内的文字会被渲染到画面上（官方用于招牌/霓虹灯/字幕等屏幕文字）。用引号包台词 = 直接画出字幕。video_prompt 中不得出现任何引号包裹的台词或展示文本；屏幕道具文字（如黑板报价）只描述「写满数字的黑板」形态，不写具体引号文本。
7. 台词红线不变：台词仍从 description 提取，一字不增不减；只是旁白不再进入 video_prompt、台词改走 <d> 通道。
官方依据：github.com/MiniMax-AI/MiniMax-H3 → skills/h3-prompt-writing/references/base-en.txt §4.4（台词 <d> 标签）/ §4.5（引号上屏文字）。`,
  en: `## Negative constraints for generated video (highest priority, overrides all dialogue/narration wording above)
1. No subtitles: the frame must contain no subtitles, titles, on-screen text, watermarks or any text elements; never request subtitles in the prompt.
2. No narration audio: narration stays only as script information in description and must NEVER enter video_prompt; the video must contain no voice-over, off-screen narration or commentary. Any earlier "write narration as ..." wording is void under this rule.
3. Dialogue must use the official <d> channel: write dialogue as 'Character says: <d>[English] line</d>' with the whole line wrapped in <d>...</d>; never omit the closing tag.
4. <d> tag purity (root cause of the TTS-reads-prohibition incident, official §4.4): inside <d> include ONLY the language tag plus the verbatim spoken line; any other text (prohibitions, visual constraints, instructions) inside the tag gets spoken aloud by TTS. Visual constraints go immediately AFTER the closing </d> tag (official voiceover pattern: ...</d> while his lips remain completely closed).
5. No-dialogue shots keep ALL sound out of the body text (official §2.2 three-field structure): never write ambient/sound descriptions inside integrated_multimodal_description — H3 chants body-text sound words as narration; the pipeline appends the official overall_soundscape field instead. NEVER write vocal/crowd-noise words (chat, laugh, murmur, mutter, lively) and NEVER write negations ('no one speaks', 'no dialogue', 'no X of any kind' — negations get spoken aloud or burned in as subtitles). Crowd actions are posture/expression only. Per official §4.4, characters who never vocalize receive no speaker ID.
6. NEVER wrap dialogue in quotes (root cause of three subtitle incidents): per the official H3 prompting guide §4.5, text inside quotation marks (" " ' ' 「」) is rendered ON SCREEN (the official mechanism for signs/neon/subtitles). Quoted dialogue = burned-in subtitles. No quoted display text of any kind in video_prompt; describe on-screen prop text by form only (e.g. 'a blackboard covered in numbers'), never quote it.
7. Dialogue red line unchanged: dialogue still comes from description verbatim; narration is excluded and dialogue moves to the <d> channel.
Official reference: github.com/MiniMax-AI/MiniMax-H3 → skills/h3-prompt-writing/references/base-en.txt §4.4 (<d> dialogue tag) / §4.5 (quoted on-screen text).`,
  ja: `## 動画生成のネガティブ制約（最優先・上記の台詞/ナレーション記述を全て上書き）
1. 字幕禁止：字幕・タイトル・画面内テキスト・透かし等の文字要素は一切禁止。プロンプトにも字幕関連の要求を書かない。
2. ナレーション音声禁止：ナレーションは description の脚本情報のみに留め、video_prompt には絶対に書かない。完成映像にナレーション・解説音声を含めてはならない。
3. 台詞は公式 <d> チャンネル必須：台詞は「キャラ名: <d>[日本語]台詞</d>」の形で全体を <d>...</d> で囲み、閉じタグの省略は禁止。
4. <d> タグの純度（TTS が禁則文を読み上げる事故の根本原因、公式 §4.4）：タグ内には「言語タグ＋台詞本文」のみ。禁止項・画面制約・指示文など他のテキストをタグ内に書くと音声として読み上げられる。画面制約は閉じタグ </d> の直後に書く（公式ナレーション例：...</d> while his lips remain completely closed）。
5. セリフなしカットの本文（integrated_multimodal_description）に環境音・音声描写を一切書かない（公式 §2.2 三フィールド構造。本文中の音語はナレーションとして朗詠される）。発声/喧騒語（笑い合う・ささやく・つぶやく・にぎやか等）厳禁、否定文（誰も話さない・対白なし・～がない等）も厳禁（そのまま読み上げ・字幕焼き付けされる）。群衆の動きは表情・姿勢のみ。公式 §4.4 により、発話しないキャラに話者IDを付けない。音響はパイプラインが追加する overall_soundscape フィールドへ。
6. 台詞を引用符で囲まない（字幕事故の根本原因）：H3 公式ガイド §4.5 により、引用符（「」『』""）内のテキストは画面に描画される（看板/ネオン/字幕用の公式仕様）。引用符付き台詞＝字幕の焼き付け。video_prompt に引用符付きの表示テキストを書かない。画面内の小道具テキストは形のみ記述する。
7. 台詞の赤線は不変：台詞は description から一字一句そのまま抽出し、ナレーションのみ除外し台詞は <d> チャンネルへ。
公式依据：github.com/MiniMax-AI/MiniMax-H3 → skills/h3-prompt-writing/references/base-en.txt §4.4/§4.5.`,
  ko: `## 영상 네거티브 제약(최우선, 위의 모든 대사/내레이션 서술을 덮어씀)
1. 자막 금지: 자막, 제목, 화면 텍스트, 워터마크 등 문자 요소 일절 금지. 프롬프트에 자막 관련 요구를 쓰지 않는다.
2. 내레이션 음성 금지: 내레이션은 description의 대본 정보로만 남기고 video_prompt에 절대 쓰지 않는다. 완성 영상에 내레이션·해설 음성을 포함해서는 안 된다.
3. 대사는 공식 <d> 채널 필수: 대사는 「캐릭터: <d>[한국어]대사</d>」 형태로 전체를 <d>...</d>로 감싸고 닫는 태그 생략 금지.
4. <d> 태그 순도(TTS가 금지문을 읽는 사고의 근본 원인, 공식 §4.4): 태그 안에는 「언어 태그＋대사 본문」만 허용. 금지 항목·화면 제약·지시문 등 다른 텍스트를 태그 안에 쓰면 음성으로 읽힌다. 화면 제약은 닫는 태그 </d> 바로 뒤에 쓴다(공식 내레이션 예시: ...</d> while his lips remain completely closed).
5. 대사 없는 컷의 본문(integrated_multimodal_description)에는 환경음·소리 묘사를 일절 쓰지 않는다(공식 §2.2 3-필드 구조. 본문의 소리 단어는 낭송된다). 발성/소란어(웃으며 떠들다·속삭이다·중얼거리다·북적이다 등) 엄금, 부정문(아무도 말하지 않는다·대사 없음·~이 없다 등)도 엄금(그대로 읽히거나 자막으로 각인됨). 군중 동작은 표정/자세로만. 공식 §4.4에 따라 발화하지 않는 캐릭터에게 화자 ID를 부여하지 않는다. 음향은 파이프라인이 추가하는 overall_soundscape 필드로.
6. 대사를 따옴표로 감싸지 말 것(자막 사고의 근본 원인): H3 공식 가이드 §4.5에 따라 따옴표("" '' 「」) 안의 텍스트는 화면에 렌더링된다(간판/네온/자막용 공식 사양). 따옴표 대사 = 자막 각인. video_prompt에 따옴표 표시 텍스트를 쓰지 않는다.
7. 대사 레드라인 불변: 대사는 description에서 한 글자도 바꾸지 않고 추출하되, 내레이션은 제외하고 대사는 <d> 채널로.
공식 근거: github.com/MiniMax-AI/MiniMax-H3 → skills/h3-prompt-writing/references/base-en.txt §4.4/§4.5.`,
}

export function getVideoNegativeInstructions(agentType: string, language?: string | null): string {
  if (agentType !== 'prompt_generator' && agentType !== 'storyboard_breaker') return ''
  return instructions[language || 'zh'] || instructions.zh
}

import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('comfyui adapter detects lost upstream records via /queue', () => {
  const adapter = read('src/services/adapters/comfyui-video.ts')

  // history 为空 + 不在队列 → 丢失；任一请求失败不下结论
  assert.match(adapter, /async isTaskLost\(config: AIConfig, taskId: string\)/)
  assert.match(adapter, /`\$\{base\}\/history\/\$\{encodeURIComponent\(taskId\)\}`/)
  assert.match(adapter, /`\$\{base\}\/queue`/)
  assert.match(adapter, /if \(Object\.keys\(history\)\.length > 0\) return false/)
  assert.match(adapter, /queue\.queue_running/)
  assert.match(adapter, /queue\.queue_pending/)
  assert.match(adapter, /if \(!history \|\| !queue\) return false/)
})

test('video poll fails fast with upstream_lost instead of polling 12h', () => {
  const svc = read('src/services/generation.ts')

  // 连续 history 为空才判定，避免首发排队被误杀
  assert.match(svc, /let historyMisses = 0/)
  assert.match(svc, /historyMisses\+\+/)
  assert.match(svc, /historyMisses >= 6/)
  assert.match(svc, /'upstream_lost'/)
  // 恢复入口不再放行已丢记录的任务
  assert.match(svc, /record\.errorCode === 'upstream_lost'/)
})

test('frontend treats upstream_lost as regenerate-only and batches without per-shot confirm', () => {
  const vue = readFileSync(new URL('../frontend/app/views/drama/episode.vue', root), 'utf8')

  assert.match(vue, /task\.error_code !== 'upstream_lost'/)
  // 批量生成已在确认弹窗统一确认，silent 调用不再逐镜 confirm
  assert.match(vue, /if \(forceNew && !opts\.silent && !window\.confirm/)
})

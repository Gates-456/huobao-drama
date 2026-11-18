# ComfyUI（MiniMax-H3）服务运维与 OOM 恢复

本地视频管线（ComfyUI + MiniMax-H3 GGUF）跑在同一台机器上，与生图/生视频之外的批处理作业（如 YOLO 视频流水线）共享内存。本文记录 2026-11-16 的服务中断事故、恢复步骤与已上线的看护机制。

## 部署拓扑

| 组件 | 端口 | 说明 |
| --- | --- | --- |
| 剧集后端（Hono/tsx） | 8192 | `backend/src/index.ts`，`PORT`/`PUBLIC_BASE_URL` 见 `backend/.env` |
| ComfyUI（MiniMax-H3 GGUF） | 8193 | 后端适配器 `comfyui` 的 `baseUrl` 指向该端口 |

ComfyUI 工作目录 `/mnt/sda/vlm/minimax-h3-gguf-q8-opt-20260915`，`ComfyUI/` 软链到 `/mnt/sda/vlm/ComfyUI`：

- `start_gguf.sh` — 前台启动脚本，含 GPU 预检（`cuda:0/cuda:1` 必须是双 V100-SXM2-16GB，不满足则自动重载 `nvidia_uvm` 后复检，仍失败即中止）、线程数与显存分配参数，最终 `exec python main.py --port 8193 ...`。
- `start_gguf_tmux.sh` — 在 tmux 会话 `minimax-h3-q8-opt` 里跑 `start_gguf.sh`，日志 `tee -a server_runtime.log`。
- `watchdog_gguf.sh` — 2026-11-16 新增的看护脚本（见下）。
- `outputs/` — 生成产物；`comfyui_gguf.db` — ComfyUI 自身资产库。

## 显存预算与参考图上限

### 8 GiB 并不等于 8 GiB 可用

GPU 规格写 8192 MiB，但 CUDA 报出的可用容量是 **7.66 GiB ≈ 7844 MiB**，差的约 348 MiB 被 CUDA 上下文与驱动占掉，应用完全拿不到。OOM 报错里的每个数字都是同一时刻的账本，可以直接对账（2026-11-18 案例）：

| 项目 | 数值 |
| --- | --- |
| 卡标称 | 8192 MiB（8.00 GiB） |
| CUDA 可用容量 | 7.66 GiB（7844 MiB） |
| PyTorch **已分配** | 6.82 GiB（6984 MiB） |
| PyTorch 已预留未使用（碎片） | 143 MiB |
| 非 PyTorch 占用（CUDA context 等） | 195 MiB |
| **实际空闲** | **449.62 MiB** |
| 本次申请 | **500 MiB** |
| 缺口 | **50.38 MiB** |

所以「6G 多为什么还会炸」不是矛盾：`6.82 GiB allocated` 表示**已经用掉**的量，不是可用量。真实余量 = 7.66 − 6.82 − 0.14（碎片）− 0.19（非 PyTorch）≈ 0.44 GiB。而 PyTorch 要的是**连续**的 500 MiB，那 143 MiB 碎片拼不出来，`expandable_segments:True` 也救不了。

### 瓶颈在放 CLIP 的那块 8GB 卡

工作流把三类模型分到不同卡（`CUDA_VISIBLE_DEVICES=4,5,3,2,1,0` 下的 logical 编号）：

| logical | 物理卡 | 承载 | 典型占用 |
| --- | --- | --- | --- |
| `cuda:0` / `cuda:1` | 双 V100-16GB | 主模型 50 blocks 对半拆 | 8.0 GB / 7.1 GB |
| `cuda:2` | RTX 3070 8GB | **Qwen3VL 32B 文本编码器** | 6.0 GB（lowvram 满装） |
| `cuda:3` | RTX 3060 Ti 8GB | 视频 VAE | 4.97 GB |

32B 编码器权重约 26 GB，lowvram 按「当前空闲减 819 MiB 余量」的策略把 6042–6092 MiB 塞进 8GB 卡，**留给编码阶段激活的只剩 342–449 MiB**。参考图会变成图像 token 送进同一个编码器，图越多激活越高，于是踩线。

### 参考图张数与 OOM 的关系

全量历史（`sys_task.params.referenceImageUrls` × 报错文本 `out of memory`）：

| 参考图 | CUDA OOM | 任务数 | 说明 |
| --- | --- | --- | --- |
| 0–2 张 | 0 | 646 | 稳定 |
| 3 张 | 7 | 218 | 偶发（3.2%） |
| 4 张 | 5 | 36 | 明显变差（14%） |
| 5 张 | 7 | 8 | 基本必炸（87.5%） |
| 8 张 | 0 | 1 | 该次失败另有原因 |

**这不是「参考图多了就用不成」**：3 张成功 106 次、4 张成功 14 次，都能跑通，只是失败概率随张数上升——余量越薄，编码阶段的峰值越容易越界。真正的实际门槛在 **5 张以上**。

### `--reserve-vram 0.8` 的作用与代价

修复方式是在 `start_gguf.sh` 里加 `--reserve-vram 0.8`：让 ComfyUI 在每张卡上主动少装约 800 MiB 权重（`EXTRA_RESERVED_VRAM` 会进 `minimum_inference_memory()`，进而压低 lowvram 的装载上限）。

| | 修复前 | 修复后 |
| --- | --- | --- |
| lowvram 自估可用 | 6388 MB | 6015 MB |
| CLIP 实际装上卡 | 6092 MB | **5652 MB** |
| 留给编码 | 449 MB（要 500 → OOM） | 约 720 MB（够） |

代价仅吞吐：CPU 侧多卸载约 420 MB，实测 step 从约 50 s/it 升到 70–96 s/it。**数值路径完全不变**——`steps=8`、`sigmas=[1.0, 0.9882, 0.973, 0.9524, 0.9231, 0.878, 0.8, 0.6316, 0.0]`、LoRA `strength=1.0` merge、`split 50 blocks = cuda:0:25 / cuda:1:25`、`lowvram patches: 0`、`audio_denoise 0.15`、`strict_prompt_tags: true` 全部与修复前一致，因此不影响此前修复的台词/禁项/空镜吟诵等提示词层缺陷（那一层改的是 prompt 文本与发送字段，不涉显存）。

### 关于「软限制」

代码侧**没有**新增任何参考图数量限制。上限仍由两处既有逻辑决定：

- 前端 `refImageLimit`：Wan 3.0 为 10，其余模型为 9（`getShotReferenceImages` 按「场景 → 角色 → 道具」顺序取，去重并截断）；
- 硬件余量：当前配置下 4 张以内基本稳定，5 张以上风险显著。

若要提高天花板，可选方向（均未实施）：

1. 把 CLIP 拆到两张 8GB 卡（见下节，需要改代码）；
2. 降低编码器精度或换更小的文本编码器；
3. 在镜头绑定层限制素材数量（例如场景 1 + 角色 2 封顶），从源头控制参考图张数。

> ⚠️ **V100 不能承载 CLIP**：`fix_cuda_smem.py` 顶部注明 int8/convrot 的 CUDA kernel 只编到 sm86+（3070/3060Ti），V100 是 sm70，跑起来会 `no kernel image`；而 eager 后端对这个 32B 编码器数值不可用（BOS 隐藏态爆到 ~15400，DiT 直接忽略提示词，输出糊成一片）。所以「把 CLIP 挪到 16GB V100」这条路走不通，能加显存的只有另外两张空闲的 8GB sm86 卡。

### CLIP 能否拆到两张 8GB 卡

**现状：直接配置做不到。** 两点约束：

- ComfyUI 的 `ModelPatcher` 只有单个 `load_device`（`comfy/model_patcher.py:357`），lowvram 的「装载一部分 + 其余逐层从 CPU 流式搬运」是**单卡**内的一次装载决策；
- 本仓库的 `MiniMaxH3ModelParallel` 对 CLIP 也只做 `clip.patcher.load_device = cdev`（`minimax_model_parallel.py:512`），`clip_device` 解析出来就是一个 `torch.device`；
- 自带的 `ComfyUI-MultiGPU/CLIPLoaderMultiGPU` 同样只接受**一个** `cuda:N`，且其 `type` 列表只有 `stable_diffusion / stable_cascade / sd3 / stable_audio`，不含 `minimax`，对 H3 这条链不可用。

**规模参考**（日志实测）：CLIP 权重总量约 **25.3 GB**（`5390 MB loaded + 20493 MB offloaded`），单张 8GB 卡最多常驻约 5.4–5.7 GB，其余约 20 GB 每帧编码都从 CPU 逐层搬 —— 这也是编码慢、且激活余量被压到 450 MB 的原因。

**要做到需要改代码**，可行路径是照搬 DiT 已经验证的做法（`MiniMaxH3ModelParallel` 把 50 个 block 分给两张 V100，forward 时按 block 搬 hidden states）：

1. 在自定义节点里把 CLIP 的 transformer layers 按层切成两段，分别 `.to()` 到两张 sm86 的 8GB 卡（当前空闲的是逻辑 `cuda:4` = 物理1 RTX 3070、逻辑 `cuda:5` = 物理0 3060Ti）；
2. 包一层 forward，在两段交界处把 hidden states / attention mask 搬到下一张卡；
3. int8/convrot 的 backend 覆盖（`fix_cuda_smem.py` 的 `_cuda_clip_ctx`）需要按层判断设备，而不是只看 `patcher.load_device` 的 capability。

收益：两张卡各常驻约 5.4 GB → 常驻权重翻倍到 ~10.8 GB，CPU 流式量从 20 GB 降到 ~14.5 GB，单卡激活余量明显变宽，参考图张数的天花板随之抬高。
代价：属于自研改动，需要处理量化权重跨卡搬运与显存碎片，并有回归风险；**目前尚未实施**，现有稳定方案仍是 `--reserve-vram 0.8` + 控制参考图张数。

## 2026-11-16 中断事故

### 现象

前端分镜 #1113–#1115 显示「无法连接服务器，请检查网络或服务是否已启动」，`sys_task` 中对应记录 `error_msg = fetch failed`。端口探测：8192 返回 200，**8193 无进程监听**。

### 根因

`journalctl` 时间线（均为 11:46–11:49）：

1. `11:46:57` 全局 OOM，杀掉 ComfyUI 的 python 主进程（PID 802346，`anon-rss` 9.5GB）。
2. `11:47:46` 起 `cuda-EvtHandlr`、`actix-rt|system` 反复触发 oom-killer，连带杀掉 ToDesk、`pt_main_thread` 等桌面进程。
3. 同时段另一批处理作业（`/mnt/sda/yolo/mosquito_v12` 的 `run_video_v12.py`）以 `--workers 20` 拉起 21 个进程，实测合计 RSS ≈ 52GB；机器总内存 62GB，被彻底耗尽。

也就是说：**不是人为关闭，也没有崩溃栈，而是被内核 OOM killer 杀掉**。而这台机器此前**没有任何自启动或守护机制**——无 systemd unit、无常驻 tmux、crontab 里也没有看护脚本，所以进程一死就彻底消失。

### 连带影响（数据面）

ComfyUI 的 `/history` 只存在进程内存里，重启后即清空。因此中断瞬间处于 `processing / polling` 的任务，其 `task_id` 在重启后查询 `/history/{id}` 全部返回 `{}`：

- **125 条** `processing + polling` 成为僵尸任务（无法 recover，只能重新生成）。
- **30 条** `failed + submitting / submission_unknown`（提交阶段就没成功）。
- 后端轮询上限是 `attempts 4320 × 10s ≈ 12h`，僵尸任务在被判定超时前会一直显示「生成中」。

> 该批历史数据由业务侧核对产出后处理；本文只记录机制与恢复手段，不做数据订正。

### 二次故障：僵尸任务把「批量生成」堵死

2026-11-18 重启后暴露了上面这条影响的另一面。剧集 3 有 18 个镜头没有成片，但各自挂着一条 11-16 遗留的 `processing` 任务（上游记录早已丢失），于是：

1. 任务列表接口把这些镜头的状态算成「生成中」→ 前端 `isPendingVideo()` 为真；
2. 「批量生成」的候选池先取「没有成片的镜头」，再过滤掉「生成中」的，池子被清空；
3. 点击后只弹一句「没有可生成的镜头」，用户既无法生成也无法恢复。

根因是**轮询不会对「上游已丢」下结论**：`/history/{id}` 返回 `{}` 时一律按 `processing` 处理，一直空转到 12h 上限。修复分两处：

| 位置 | 改动 |
| --- | --- |
| `adapters/comfyui-video.ts` | 新增 `isTaskLost()`：`/history/{id}` 为空 **且** 该 prompt 不在 `/queue` 的 running/pending 中 → 判定上游已丢；任一请求异常都返回 false，交给下一轮 |
| `services/generation.ts` | 轮询侧连续 6 轮（约 1 分钟）history 为空才探测；确认丢失即落 `failed / upstream_lost`，不再等 12h。`recoverVideoTask` 对 `upstream_lost` 直接拒绝恢复 |
| 前端 `episode.vue` | `canRecoverVideo()` 排除 `upstream_lost`（不再显示必然失败的「恢复」按钮，只留「重新生成」）；批量生成已在确认弹窗统一确认过，`silent` 调用不再逐镜弹 `confirm` |

判定为什么必须带 `/queue` 这一半：任务提交后、开始执行前，`/history` 本来就是空的，此时它一定在队列里。只凭「history 为空」会误杀正常排队的镜头。

线上效果（同一批 18 条）：重启后端后约 1 分钟，全部自动落为 `failed / upstream_lost`，剧集 3 的「批量生成」恢复可用，无需手工改库。


## 恢复步骤

```bash
# 1. 确认端口状态
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8193/

# 2. 确认内存余量（ComfyUI 走 CPU offload，需要 GB 级空闲）
awk '/MemAvailable/{printf "%.1f GB\n",$2/1048576}' /proc/meminfo

# 3. 清理残留会话（若存在且 pane 已死）
tmux ls
tmux kill-session -t minimax-h3-q8-opt

# 4. 启动
bash /mnt/sda/vlm/minimax-h3-gguf-q8-opt-20260915/start_gguf_tmux.sh

# 5. 校验（加载节点约需 30–60s）
curl -s http://127.0.0.1:8193/system_stats
curl -s http://127.0.0.1:8193/queue   # running / pending
```

启动后后端会自动继续轮询仍在队列中的任务；`/history` 已丢失的旧任务不会自愈，需业务侧重提。

## 看护机制（watchdog_gguf.sh）

crontab 每 3 分钟执行一次：

```cron
*/3 * * * * MIN_MEM_MB=12000 /mnt/sda/vlm/minimax-h3-gguf-q8-opt-20260915/watchdog_gguf.sh >> /mnt/sda/vlm/minimax-h3-gguf-q8-opt-20260915/watchdog.cron.log 2>&1
```

设计目标是**能自愈、但绝不刷重启**。三重闸门：

| 闸门 | 变量 | 默认 | 作用 |
| --- | --- | --- | --- |
| 内存门槛 | `MIN_MEM_MB` | `12000` | `MemAvailable` 不足时只记日志不重启，避免 OOM ↔ 重启死循环 |
| 启动宽限 | `BOOT_GRACE` | `600` | 刚重启后的 10 分钟内不判定为再次死亡（模型初始化较慢） |
| 连续失败计数 | `MAX_STRIKES` / `STRIKE_RESET` | `6` / `3600` | 连续 6 次重启仍未健康即抑制重启并提示人工介入；健康后计数归零，或间隔超 1 小时自动重置 |

完整分支：

| 情况 | 行为 |
| --- | --- |
| 端口返回 200 | 静默退出；若有 strikes 则归零并记一行日志 |
| 端口不通且内存 < 门槛 | 跳过重启并记日志 |
| 重启后未满 `BOOT_GRACE` | 等待，不重复重启 |
| strikes ≥ `MAX_STRIKES` | 抑制重启，提示查看 `server_runtime.log` |
| tmux 会话存在但 pane 已死 | 清理会话后重启 |
| tmux 会话存活但端口未就绪 | 等待下一轮 |
| 其余（确实挂了且资源充足） | 计数 +1 并调用 `start_gguf_tmux.sh` |

实现细节：

- `flock -n /tmp/watchdog_gguf.lock` 单实例互斥，重叠执行直接退出。
- 状态写在 `$ROOT/.watchdog_state`（`<last_restart_epoch> <strikes>`）。
- 日志写 `$ROOT/watchdog.log`；cron 的 stdout/stderr 写 `watchdog.cron.log`。
- 支持 `DRY_RUN=1`、`ROOT`/`PORT`/`SESSION` 覆盖，便于在临时目录做分支回归。

### 验证记录（2026-11-16）

在临时 `ROOT` + 假 `start_gguf_tmux.sh` 下逐条回归：

| 用例 | 期望 | 结果 |
| --- | --- | --- |
| 服务健康 | 不动作、不写日志 | 通过 |
| 内存不足 | 记录跳过原因 | 通过 |
| 首次重启 | strike 1/6，写状态文件 | 通过 |
| 宽限期内再探测 | 等待，不计 strike | 通过 |
| 宽限后仍不通 | strike 2/6 | 通过 |
| 达到上限 | 抑制重启并提示人工 | 通过 |
| 恢复健康 | strikes 2 → 0 | 通过 |

生产环境实测：`cron` 每 3 分钟正常触发（`/var/log/syslog` 可见 `CRON[...] CMD (MIN_MEM_MB=12000 ...watchdog_gguf.sh)`），服务健康时保持静默。

## 注意事项

- **ComfyUI 的 `/history` 不持久化**：服务重启即丢，中断期间的在途任务无法恢复。要降低损失，只能减少中断概率（内存门槛 + 与批处理作业错峰）。
- **僵尸任务会自我了结**：`upstream_lost` 检测在重启后约 1 分钟内把这类记录落成 `failed`，因此不会再出现「批量生成提示没有可生成的镜头、手工改库才能继续」的情况。若发现任务长期停在 `processing` 超过 2 分钟且 ComfyUI 队列为空，先查 `server_runtime.log` 与后端 `poll-request` 日志。
- **与批处理作业共存**：ComfyUI 常驻约 32GB RSS（模型 offload 到内存）。同机跑 `--workers 20` 级别的视频批处理会直接打爆 62GB 总量。跑批时应限制并发，或等 ComfyUI 空闲窗口。
- **GPU 侧通常不是瓶颈**：双 V100 在空闲时各占 8MiB，ComfyUI 被 OOM 杀掉后显存会自动释放。
- **CLIP 卡是唯一显存瓶颈**：`cuda:2` 那块 8GB 卡常年贴顶（实测 7375/8192 MiB used，剩余 466 MiB 长时间不动），参考图 5 张以上极易 OOM。判据与预算明细见上文「显存预算与参考图上限」。
- 修改 `start_gguf.sh` 里的 GPU 预检会直接影响能否启动（它会在 V100 不在 `cuda:0/1` 时主动中止），排障时先看 `server_runtime.log` 开头的 `[gpu-check]` 段。

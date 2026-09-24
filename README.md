# dsh-plugin-jev-effort-selector

中文 | [English](README.en.md) · [设计细节](DESIGN.md)

让 [Jev](https://typesafe.ai) System One 模型替你决定每条消息该用多深的推理。

[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 的推理等级只能手动切换：聊天问候浪费了 high，复杂重构又忘了从 low 调上来。这个插件在每轮首次模型调用前问一次 Jev——一个专做分类、不做生成的小模型——由它判断这条消息值多少思考量，然后改写这次调用的推理等级。

Jev 不是对话模型，单次判断约 500–800 token、一两秒，成本可以忽略。

```
你好                                    → Jev Off 100%
帮我把这段代码改成异步                    → Jev Medium 99%
设计一个支持百万并发的分布式消息队列        → Jev High 100%
```

判断结果显示在输入框右侧，紧挨模型选择器。

> 想知道每一处**为什么这样做**——什么落盘、信封为何是这个形状、那条规则怎么来的、哪些方案被否掉了——见 [设计细节](DESIGN.md)。

## 特性

- 🎚️ **按模型推导档位**：读取每个模型自己声明的推理等级，取最低档 / `medium` / `high`；不支持关闭思考的模型永远拿不到 `off`，`max`、`xhigh` 也不会被自动用掉
- 🧭 **上下文信封**：把上一轮的事实讲给 Jev——用了什么等级、用户说了什么、助手说到哪、干了多少活、有没有干完。约 500–800 token，不发对话历史
- 🔁 **一次问两件事**：这条消息该用几档，以及它是不是在延续上一个任务。后者是「几点了」和「继续」的分水岭——两句一样短，只有一句要继承正在干的活的深度
- ⚓ **只有一条硬规则**：活没干完（上一轮非正常结束，或待办里还有没完成的项）且这条消息在延续它，就不低于上一轮。其余一切听 Jev 的——复杂重构后问「几点了」照样直接到 `off`
- 🎯 **一轮一决策**：一轮里的每一步、每一次失败重试都用同一个等级，Jev 每轮只问一次
- ✋ **尊重手动选择**：你在选择器里改了等级，这一轮 Jev 不插手
- 🧩 **不管子代理**：Jev 只替你发的消息选档。子代理的等级由主代理指定或沿用主对话，Jev 不参与，也不多花一次调用
- 💾 **重启不失忆**：信封的记忆来自会话日志，不靠插件内存。重启、闲置回收之后，「继续」照样知道上一轮在做什么
- ⬆️ **低置信度向上取**：概率低于阈值时在最可能的两档里选更高的——多想只费几个 token，少想可能直接答错
- 🛡️ **失败静默降级**：缺密钥、网络不通、超时、返回异常、等级不被支持，任何一种都沿用调用方已解析出的等级，不报错、不阻塞
- ⚙️ **配置由 DSH 保存**：设置界面与配置文件双入口，改动热生效，插件不自带存储（DSH 0.1.5 存在 `settings.yaml`，0.1.7 起存在 profile 的 `cordis.patch.yml`）
- 🔁 **新旧 DSH 通用**：同一个版本同时支持 DSH 0.1.5 与 0.1.7
- 🏷️ **芯片说人话**：`Jev · High · 87%`，悬停看原因。它只活在进程里——重启后消失，下一轮决策后再出现，和它描述的那个决定同寿
- 🔘 **本会话开关**：点芯片可以只关掉这个会话的 Jev，不影响别的会话；重启后回到全局设置
- 🔀 **天然会话隔离**：决策、开关、投影全部按会话 id 键控，切换会话不串值；插件不往会话日志写任何东西
- 🎛️ **档位可自定义**：设置卡片里「按模型设置档位」逐个勾选（也可直接写 `levels`），2~5 档任意，提示文案随档位数自动适配

## 安装

前置：已安装 [DSH](https://github.com/deepseek-ai/deepseek-harness) 且 `pnpm` 在 PATH 上。

```sh
# 从 GitHub 安装（本插件零构建步骤，无需 allowBuilds 配置）
dsh plugin --profile web add github:justhalfbit/dsh-plugin-jev-effort-selector

# 重启 dsh web 生效
```

`web` 是 `dsh web`（浏览器界面）对应的 profile 名；用其他 profile（如 `tui`）时把 `web` 换成对应名字即可。
`dsh plugin add` 会自动把包写入 profile 依赖并追加到 `dsh.profile.bundles`，无需手工编辑。

重启后打开设置页，填 API 地址和 API 密钥即可。设置页的位置随 DSH 版本不同：

- **DSH 0.1.5**：**设置 → 插件 → 插件配置**，列表第一张「Jev 推理选择」卡片，点开编辑；
- **DSH 0.1.7 起**：侧栏 **插件** → 已安装里的 **dsh-plugin-jev-effort-selector**，详情页里直接就是表单。

卸载：`dsh plugin --profile web remove dsh-plugin-jev-effort-selector`，重启生效；配置会保留（0.1.5 在 `~/.dsh/settings.yaml` 的 `jev-effort-selector` 段落，0.1.7 起在 `~/.dsh/profiles/web/cordis.patch.yml` 里 `id: jev-effort-selector` 的条目），可手动删除。

本地开发安装：克隆本仓库后 `pnpm install`，再 `dsh plugin --profile web add link:/绝对路径/dsh-plugin-jev-effort-selector`。

### 界面支持

| 运行形态 | 决策核心（拦截 / 判断 / 改写等级） | 输入框芯片 |
|---|---|---|
| `dsh web`（浏览器 GUI） | ✅ | ✅ |
| `tui` / `headless` | ✅ 全部可用 | ❌ 决策照常生效，只是没有可视指示 |

host 半与界面无关；client 半（芯片）声明 `platform: "web"`，仅在浏览器界面加载。

## 配置

所有配置项都可以在设置界面里改，也可以直接编辑文件：DSH 0.1.5 是 `~/.dsh/settings.yaml` 的 `jev-effort-selector` 段落，0.1.7 起是 `~/.dsh/profiles/web/cordis.patch.yml` 里 `id: jev-effort-selector` 条目的 `config:`。字段完全相同：

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `enabled` | `true` | 关掉后完全不干预，保持你手动选的等级 |
| `apiUrl` | 空 | Jev System One API 地址，需要自己填写；为空时不调用 Jev，芯片显示「未配置 Jev API 地址」 |
| `apiKey` | `''` | 字面量密钥逃生口；标了 `role('secret')`，永不随设置外发。常规情况留空 |
| `apiKeyEnv` | `JEV_API_KEY` | 凭据引用名，API 密钥以此名存放在凭据服务中。设置界面不显示此项，要改名请写 `settings.yaml` |
| `model` | `jev-latest` | Jev 模型路由 |
| `confidenceThreshold` | `0.6` | 低于该置信度时，在概率最高的两档里选更高的那档 |
| `timeoutMs` | `5000` | 超时后放弃 Jev，本次调用沿用调用方已解析出的等级 |
| `useContext` | `true` | 发送上下文信封，让「继续」这类追问继承话题深度 |
| `levels` | `{}` | 每个模型的档位映射，键为 `provider/model` |

### API 密钥存在哪

密钥**不进 `settings.yaml`**，走的是 DSH 的凭据服务，与官方「设置 → 模型」里自定义提供方的密钥完全同一条链路。设置卡片里的「API 密钥」框只做两件事：写入（`set`）和读状态（`describe`）——状态里只有「配没配、来自哪一层、能不能改」，**没有任何字段能装下密钥本身**，所以它永远不会回传到浏览器。

解析顺序（由凭据服务本身分层，最信任的优先）：

```
启动时继承的进程环境        只读，最高优先级
> ~/.dsh/.credentials.yaml  设置界面写入这里，权限 0600
> <启动目录>/.env           只读兜底
> ~/.dsh/.env               只读兜底
```

所以这三种方式都可以，任选其一：

```bash
# 1. 设置界面里填（落到 ~/.dsh/.credentials.yaml）
# 2. 导出到环境（优先级最高，界面会显示为只读）
export JEV_API_KEY=sk-...
# 3. 写进 ~/.dsh/.env
```

上层被占用时（例如已 export 环境变量），界面会如实显示「该层只读，请在其来源处修改」，而不是接受一个写完也不生效的保存。

## 档位是怎么定的

不同模型支持的推理等级不一样——有的不支持关闭思考，有的没有 `xhigh`。插件默认**读取每个模型自己声明的等级列表**，取最低档、`medium`、`high` 三档：

```
claude-opus-4-6   off · low · medium · high · max   →  off / medium / high
claude-opus-5     off · low · medium · high · xhigh · max  →  off / medium / high
claude-fable-5    low · medium · high · xhigh · max →  low / medium / high
```

最高档**刻意不取列表里最强的那个**：模型若提供 `max` 或 `xhigh`，自动档位用上它意味着每条被判为复杂的消息都花最贵的代价。这两档留给你在 `levels` 里显式指定。

不满意就在设置卡片的**「按模型设置档位」**里改：列出所有支持多档推理的模型，每个默认「自动」并高亮推导出的档位；切到「自定义」后点选 2~5 档，和其他字段一起由卡片底部的「保存」写入 `levels`，切回「自动」即删除该模型的条目。卡片不认识的条目（比如已下线模型）原样保留。

也可以直接在 `settings.yaml` 的 `levels` 里指定，2~5 档都行，描述文案会自动适配（每档都需要一句独立的判定描述，所以超过 5 档会自动收敛到首、尾与均匀分布的 5 档——否则多出来的档位只能共用同一句描述，Jev 根本分不开）：

```yaml
jev-effort-selector:
  levels:
    host-llm-gateway/claude-opus-4-6:
      - "off"
      - medium
      - high
    host-llm-gateway/claude-fable-5:
      - low
      - high
```

没在 `levels` 里出现的模型继续走自动推导。声明的等级会先和模型实际广播的等级求交集：写错或该模型不支持的档位被直接剔除，剩下不足 2 档就退回自动推导。这一步是必须的——底层对不支持的等级是**在发请求前直接拒绝**，不做钳制也不做别名，所以一个手误若不拦住，会让每轮的第一步都失败，而不是被忽略。

## 上下文信封

孤立地看，「继续」就是一句琐碎的话——Jev 会判成 `off`，哪怕上一轮正在设计分布式事务引擎。「扫」更甚：一个字，含义完全取决于助手刚才问了什么。

所以 `useContext` 打开时，插件把**上一轮的事实**讲给 Jev：

```
Context: an ongoing conversation with an AI coding assistant.
Session topic: 排查代码报错原因
Previous turn:
- reasoning effort used: high
- user said: "帮我看下为什么 dsh 启动报错"
- earlier the user said: "动手吧"
- assistant ended with: "…已修复两个会话。要我把剩下 22 个会话也全部扫一遍分帧吗？"
- activity: 14 steps, 9 tool calls
- previous turn outcome: completed
- unfinished todos: 0
```

然后才是当前这条消息。不发对话历史、不发工具输出、不发代码。用户消息各截 300 字，助手结尾取 500 字，整体约 500–800 token。

这些事实**全部来自 harness 自己的会话日志**（`user/message`、`assistant/message`、`step/start`、`tool/call`、`todo/write`、`turn/end`、`request/header`）。插件用一个 host 侧投影把它们折出来，不保存任何东西——所以重启后第一轮，Jev 拿到的信封和重启前一模一样。

## 两个问题，一条规则

同一次调用里，Jev 回答两个问题：

1. **该用几档**（在这个模型的档位里选）
2. **这条消息和上一轮是什么关系**：`continues`（延续、追问、确认、回答助手的问题）还是 `new`（无关的新请求）

插件拿到答案后只做一件事：

> 如果是 `continues`，**且**上一轮的活还没干完，那就不低于上一轮。其他情况，Jev 说几档就几档。

「活没干完」两个判据任一成立：上一轮不是正常结束（被打断、报错、超长度），或者上一轮结束时待办里还有没完成的项（未开始或进行中都算）。

对照实测：

| 上一轮 | 这一条 | 关系 | 活干完了？ | 结果 |
|---|---|---|---|---|
| High，复杂重构 | 几点了 | new | — | **Off** |
| High，被打断 | 继续 | continues | 没 | **High** |
| High，干完了 | 谢谢 | continues | 完了 | **Off** |
| High，助手问「要扫吗」 | 扫 | continues（等级置信度仅 0.16） | 完了 | 低置信取强 → **High** |

规则不看消息文字。「几点了」「现在啥时候」「what time」以及无穷多种说法，全部交给 Jev 分类；插件只看三个变量：Jev 的两个答案，加日志里的完成状态。

## 低置信度往高了选

Jev 返回概率分布。当最高概率低于 `confidenceThreshold` 时，插件在概率最高的两档里选**更高**的那个；关系问题拿不准时按 `continues` 处理——它触发的锚定只会保深度，不会减。

多想一点只是多花几个 token，少想一点可能直接答错。

→ 信封每一行的取舍、为什么当前消息不能来自投影、规则为什么不看文字：[DESIGN.md §3–4](DESIGN.md#3-信封给-jev-看什么)

## 失败时会怎样

密钥缺失、网络不通、超时、返回格式不对、模型不支持选中的等级——任何一种情况都直接沿用会话当前的推理等级，不报错、不阻塞对话。

失败会显示出来：芯片变灰、不显示置信度，悬停说明是超时、调用失败还是没配密钥。灰色表示这一档不是 Jev 这一轮定的。下一轮成功后恢复正常。→ [DESIGN.md §11](DESIGN.md#11-失败行为)

## 工作原理

```
会话日志（harness 自己写的事件）
   ├─ user/message · assistant/message · step/start · tool/call · turn/end · request/header
   ↓
jevContext 投影（host 侧，不下发浏览器）   折出上一轮：说了什么、做到哪、干了多少、干完没
   ↓
agent/pre-step（每轮第 1 步）     抓住当前这条用户消息——决策时它还没进日志
   ↓
agent/request（每轮第 1 步）
   ① 你在选择器里动过等级（新的 model/selection）且模型未换 → 手动选择，跳过 Jev
   ② 解析当前模型支持的等级 → 档位
   ③ 组装信封 → 调 Jev → 两个答案
   ④ 应用那条规则 → 本轮等级
   ⑤ 改写 LlmCallConfig.reasoningEffort，并缓存到本轮
agent/request（第 2+ 步、重试）  直接复用本轮等级，不再调 Jev
   ↓
request/header                harness 记下这次请求实际用的 config（仅在变化时）
user/message                  harness 提交本步消息——在决策之后
   ↓
jevTurn 投影（下发浏览器）      每轮恰好动一次，只当触发器：它一动，芯片就去拉最新决策
   ↓
芯片 ←── connection.rpc ──→ jevEffortSelector Remote（host 内存：决策 + 本会话开关）
```

插件**不往会话日志里写任何东西**。持久化的读路径会拒绝加载含有 harness 词汇表（`KNOWN_SESSION_EVENT_TYPES`）之外事件类型的会话——除非 envelope 带 `ignorable: true`，而 `Session.append()` 根本没有设置该标记的入口。于是插件自定义的会话事件在写它的那个进程里一切正常，却会在下次冷读时让整个会话永久打不开。

**什么落盘、什么不落盘：**

| | 在哪 | 重启后 |
|---|---|---|
| 信封的记忆（上一轮） | 会话日志 → 投影 | ✅ 在 |
| 芯片显示的决策（等级、置信度、原因） | host 内存 | ❌ 空，下一轮重现 |
| 本会话开关 | host 内存 | ❌ 回到全局设置 |
| 手动选择的判定基准 | host 内存 | ❌ 第一轮不判定 |

`jevContext` 投影的状态会进 `~/.dsh/storages/session_projcache`，含用户消息与助手结尾的明文片段。它是日志的派生物，但多了一份副本。

Remote 是手写 JS，没有 typert 生成产物，靠 gateway 的 SRC fallback 被发现；浏览器端走 `connection.rpc.call`，因为 `ctx.remote.*` 只挂载生成的命名空间。参数校验因此退化为「按名字传 JSON」，Host 端自己判类型。

设置的接法分两代，插件运行时自动识别：

- **DSH 0.1.5**：Host 半边向 `settings` 服务注册 schema（落 `settings.yaml`）；浏览器半边经 `settingsScope` 读写，在 `settings.plugin.item` 上注册设置卡片。
- **DSH 0.1.7 起**：Host 半边导出 Cordis `Config`（字段都标 `.volatile()`，落 profile 的 `cordis.patch.yml`），`apply` 收到的是实时引用；浏览器半边经 `configForms` 读写，在 `plugins.bundle.config` 上注册插件详情页的表单。

浏览器半边不把这两个服务写进 `inject`（Cordis 没有「可选依赖」，写了会在缺它的版本上永远等待），而是各用一个 `ctx.inject` 分支等待，缺的那个分支永远不启动。

→ 芯片为什么不持久、本会话开关的边界、SRC 通道是怎么造出来的、为什么不写会话日志：[DESIGN.md §7–10](DESIGN.md#7-芯片的生命周期)

## 已知行为

- 如果你的 provider 配了 `compat.forceAdaptiveThinking: true`，`off` 档不会真正关闭思考，只会降到最低——这是 gateway 的行为，不是插件能覆盖的。
- **Jev 开着时，模型选择器会跟着 Jev 的决策变。** 插件只改发给 LLM 的参数，但选择器显示的是「这个会话当前在用的等级」，它是从日志里记录的实际请求推算出来的。所以关掉 Jev 后，会话会停在 Jev 最后选的那一档；想换就在选择器里手动选一下。原理见 [DESIGN.md §6](DESIGN.md#模型选择器会跟着-jev-变)。
- 手动选择的判定依赖上次决策时 `model/selection` 事件的计数，这个计数在内存里；重启后的第一轮没有基准，会正常走 Jev。
- 切换模型不算手动改等级：新模型由 Jev 重新决策。

## 许可

MIT

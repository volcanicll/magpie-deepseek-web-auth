# DeepSeek (Web) — Magpie 非官方插件

**非官方声明**：本项目是 [Magpie](https://github.com/yetone/magpie) 的第三方供应商插件，**不是 DeepSeek 官方产品**，也尚未收录进 [magpie-community/plugins](https://github.com/magpie-community/plugins) 官方市场。实现遵循该社区仓库的插件规范，结构对齐其包约定，欢迎上游收录。

它把你在浏览器里**已登录的 [chat.deepseek.com](https://chat.deepseek.com) 账号**接入 Magpie：读取网页会话令牌，按网页端自己的协议（会话 + 工作量证明 + 补丁式流）发起对话——不消耗 DeepSeek 平台 API 额度，走的是网页账号本身。

包名 **`magpie-deepseek-web-auth`**，供应商 id **`deepseek-web`**。

> **使用前必读**：请完整阅读下方「[免责声明](#免责声明)」与「[合规风险说明](#合规风险说明)」。**下载、克隆、安装或以任何方式使用本项目，即表示你已阅读、理解并接受其全部内容；如无法接受，请立即停止并删除本项目。**

| 模型 | 网页端对应 | 思考 |
|---|---|---|
| `deepseek-chat` | default | 关 |
| `deepseek-reasoner` | expert | 开 |

两个模型都默认带网页端的联网搜索；单次请求在请求体里传 `"search_enabled": false` 可关闭。带附件的轮次由网页端服务端规则关闭思考与搜索，见「[联网搜索与附件](#联网搜索与附件)」。

## 免责声明

本项目是独立的非官方实现，与 DeepSeek（深度求索）官方、Magpie（yetone）官方及 magpie-community 社区不存在隶属或合作关系，也不代表获得其授权、认可或背书。"DeepSeek" 及相关名称与商标属于各自权利人；本仓库与包名中出现相关字样，仅为描述本项目所连接或适配的对象（描述性使用），不构成任何关联或背书的暗示。本仓库（github.com/volcanicll/magpie-deepseek-web-auth）为唯一发布渠道，自其他渠道获取的副本与本作者无关，请谨防仿冒与捆绑。

本项目旨在供个人学习、研究和开发交流。使用者应自行确认并遵守适用法律法规、DeepSeek 的服务条款及账号使用规则，仅使用本人拥有并已登录的账号，不得用于违法活动、向第三方转供服务或侵害他人权益。

本项目仅应在**本人拥有使用权力的设备与账号**上使用。浏览器登录方式会读取本机浏览器配置文件中已登录 chat.deepseek.com 的会话令牌：在共用设备上，这可能触及他人的登录凭证——请务必确认所读取与使用的令牌属于你本人；无法确认时，请改用粘贴令牌的方式并仅粘贴本人令牌。使用他人账号或任何未经授权的凭证所产生的一切后果，由使用者自行承担。

会话令牌（`userToken`）属于敏感登录凭证，请妥善保管：不要公开、提交到仓库或分享 Magpie 配置目录中的 `plugin-auth.json`。你发送的对话内容（prompt）会提交至 DeepSeek 的服务；涉及他人个人信息、客户资料、公司机密或受保护内容时，请自行确认具备必要的处理与提交权限，并评估隐私、保密、版权与数据传输要求。

本项目以开源代码形式发布，**不是服务**：作者不运营任何服务器，不提供在线服务、客户支持或可用性承诺（SLA）。本项目不包含任何遥测、统计或数据上报代码——除使用者主动发送给 DeepSeek 的对话内容外，本插件不与 chat.deepseek.com 之外的任何地址通信；会话令牌仅保存在本机 Magpie 的配置目录（`plugin-auth.json`）中，请勿分享该文件。

软件按 [MIT 许可证](LICENSE)以"现状"提供，不保证接口持续可用、回复准确、账号安全或适用于特定用途。网页接口与风控策略变更、账号受限或封禁、令牌泄露、服务中断、回复错误及其他使用风险，均由使用者自行评估并承担；重要内容请自行核验。

在适用法律允许的最大范围内，作者和贡献者不对因使用或无法使用本项目产生的任何直接或间接损失、索赔或其他责任负责。使用者因违反本声明、平台服务条款或适用法律，或以任何不当方式使用本项目，导致任何第三方向作者或贡献者主张权利、索赔或投诉的，由使用者自行处理并承担全部责任（在适用法律允许的范围内）。

本免责声明与合规风险说明的任何条款被认定无效或不可执行的，不影响其余条款的效力。本声明及风险说明以本仓库的最新版本为准，并可能随项目更新而修订；继续使用本项目，视为接受修订后的内容。下载、安装或使用前，请阅读本声明及 [MIT 许可证](LICENSE)；如无法接受上述任何条款或风险，请勿安装和使用本项目。

## 合规风险说明

本插件通过复用网页端会话令牌调用 chat.deepseek.com 的内部接口（含其工作量证明机制），**不是 DeepSeek 官方开放 API**。本项目未取得也未核实 DeepSeek 对此调用方式的专项授权，不保证该方式符合其当前服务条款。以下说明列出需要使用者自行核实的风险，并不表示平台已明确禁止所有此类调用，也不构成对具体使用场景合法性的认定。

- **账号授权不等于接口使用授权。** 即使使用本人已登录的账号，也不代表平台允许自动化访问、把网页服务封装为 API 或向第三方提供服务。使用前请核实 DeepSeek 当前关于自动化访问、凭证使用与服务转供的规定。
- **个人使用、学习研究不自动免除责任。** 免费、开源、低频或仅供个人使用，都不能作为符合服务条款或适用法律的保证。若调用方式不被平台允许，可能面临访问受限、功能降级、账号停用或服务终止，以及视具体情况产生的合同争议或其他责任。
- **不得用于绕过平台限制。** 本插件不绕过验证码、访问控制、付费墙或账号处罚：工作量证明（PoW）是网页客户端自身同样执行的计算，本项目的求解器只是对该公开协议的独立实现；本插件发出的请求与网页端一样受平台限流与风控约束。如平台拒绝访问、限流或提出停止要求，应停止相关调用，不要尝试规避。
- **提交内容前确认权限。** 对话文本会发送至 DeepSeek 及其服务方。不得提交违法违规内容；涉及第三方权利的内容时，应确认具备必要的授权。
- **商业使用或对外服务需单独评估。** 将本插件用于收费服务、企业业务或向第三方提供能力前，应核实平台是否允许该用途，并评估授权、数据处理与合同要求。MIT 许可证仅授予本项目代码的使用权，不授予 DeepSeek 服务、账号、接口或其内容的使用权。
- **接口随时可能变更。** 本项目基于对网页端当前协议的独立逆向理解实现；DeepSeek 更新接口、协议或风控策略即可能导致插件失效，作者不承诺任何维护周期或兼容性承诺。

本免责声明、合规风险说明与 [MIT 许可证](LICENSE)不能替代平台授权，也不能免除适用法律规定的责任。对合规要求较高的业务，建议使用明确授权该用途的 DeepSeek 官方开放平台（api.deepseek.com）或服务，并按实际使用场景取得必要许可。

## 安装

三种方式任选其一，无需编译、无需 `npm install`：

```sh
# ① 从 GitHub 直接安装（推荐）
magpie plugin add github:volcanicll/magpie-deepseek-web-auth

# ② 克隆后从本地目录安装（目录需保持固定）
git clone https://github.com/volcanicll/magpie-deepseek-web-auth.git
magpie plugin add ./magpie-deepseek-web-auth

```

也可以在 Magpie 的 **插件（Plugins）** 页面添加本地目录并启用。

**从旧版（本地开发目录）迁移**：先移除旧安装再添加新包，供应商 id 不变，已登录的账号自动沿用，无需重新登录：

```sh
magpie plugin remove /path/to/magpie-plugins/packages/deepseek
magpie plugin add github:volcanicll/magpie-deepseek-web-auth
```

## 登录

两种方式（`magpie plugin login deepseek-web` 或在插件页点击登录）：

- **浏览器登录（推荐）**：自动读取本机 Chromium 系浏览器（Chrome / Chromium / Brave / Edge / Vivaldi / Arc）配置文件中已登录 chat.deepseek.com 的会话令牌，并先向 DeepSeek 验证有效性再保存。只读取令牌，不写入浏览器。**仅限在本人使用的设备上使用**：共用设备上可能读取到他人的登录凭证，请改用下述粘贴方式，且只使用本人账号的令牌。
- **粘贴令牌**：在其他机器或浏览器无法读取时，在已登录的 chat.deepseek.com 标签页控制台执行下面这行，把输出粘贴给插件：

  ```js
  JSON.parse(localStorage.getItem("userToken")).value
  ```

令牌长期有效；DeepSeek 侧退出登录或改密会使它失效，届时重新登录网页再登录一次插件即可。

## 连续对话如何工作

一个 Magpie 会话对应 **一个** chat.deepseek.com 聊天：

- 插件通过 `chat.headers` 钩子拿到 agent 的会话 id，把同一会话的后续轮次**接续**到同一个网页聊天里：每轮只发送新增的用户消息，并用 `parent_message_id` 链到上一轮回复——与网页端行为一致，历史不重发。
- 标题请求（magpie 生成会话标题的内置提示词）不属于对话内容：它在**一次性临时聊天**里应答，标题返回后**即删除**该临时聊天，以避免与对话无关的会话残留在账号的聊天列表中。
- 会话失效（被删除、过期）自动开新聊天并携带全量标注历史重试一次，上下文不丢。

## 联网搜索与附件

- **联网搜索默认开启**：每次对话都带上网页端的搜索（`search_enabled: true`），与网页端打开搜索开关的行为一致；请求体传 `"search_enabled": false` 可对单次请求关闭。搜索过程（页面上的检索进度）以 `reasoning_content` 形式流出，不混入正文。
- **附件上传已接入**（按网页端 2.5.0 实测协议）：消息里的图片（`image_url`）与文件（`file`）分片先走网页端自己的上传——multipart 到 `/api/v0/file/upload_file`，带它自己的工作量证明和网页端的 `x-thinking-enabled` / `x-model-type` / `x-file-size` 三个头——再轮询 `/api/v0/file/fetch_files` 等解析完成，以 `ref_file_ids` 引用。服务端自行给文件分类（图片标 VISION，由 default 模型的视觉能力读取），无需 fork。
- **服务端规则：附件与思考互斥**。带附件的那一轮自动关闭思考（`thinking_enabled: false`），改由 default 模型应答；联网搜索不受影响，保持默认开启。下一轮无附件时恢复原模型。
- **失败的附件不阻塞回复**：上传或解析被 DeepSeek 拒绝的附件会被略过，并在提示里附一行说明，回复照常返回。
- 只接受 Magpie 这类客户端透传的附件：Magpie 的网关只把**图片**分片转发给 chat 协议上游，其他文件会被替换成占位文本，字节不出 Magpie——文档内容请直接粘贴。

## 工具调用

网页端协议本身没有 `tools` 字段，插件的工具调用是**提示词层面的桥接**（思路同 deeperseeker）：

- 声明了 `tools` 的请求，其提示词会先注入一段调用协议，教模型用 `<tool_call>{"name":"…","arguments":{…}}</tool_call>` 的形状发起调用；
- 回复里的 `<tool_call>` 块被解析为 OpenAI `tool_calls`（每个调用一条完整 delta），该轮以 `finish_reason: "tool_calls"` 结束；下一轮的工具结果按 `Tool result (name): …` 回填进提示词；
- **双格式兼容**：模型既可能按协议输出 `<tool_call>`，也可能在 agent 语境下输出它原生的 DSML 标记（`<｜｜DSML｜｜ invoke …>`）——两者都会被解析为 `tool_calls`；解析失败的块折入 `reasoning_content`，永不混进正文；
- 代价在模型侧：调用质量取决于模型对协议的遵守程度；`tool_choice: "none"` 或无 `tools` 的请求完全不走这套机制。

## 限制

- 带附件的轮次不能同时开思考（网页端服务端规则），该轮自动改由 default 模型应答，见「[联网搜索与附件](#联网搜索与附件)」。
- 网页端没有可读的额度接口，用量卡片不显示窗口。
- 法律、合规与账号相关风险，见顶部「[免责声明](#免责声明)」与「[合规风险说明](#合规风险说明)」——安装或使用前请完整阅读。

## 工作量证明（PoW）

`src/pow.mjs` 是零依赖的 `DeepSeekHashV1` 实现：SHA3-256 海绵构造、KECCAK-p[1600] 只跑第 1–23 轮，在 `salt_expireAt_nonce` 上从 0 搜索到 `difficulty-1`。测试双重锚定：

- 24 轮时与 `node:crypto` 的 SHA3-256 逐字节一致（钉死置换、填充、多块吸收）；
- 23 轮时与 DeepSeek 官方 `test/fixtures/pow_solver.wasm`（随包附带）逐字节一致，并用官方 `wasm_solve` 反向求解验证。

144000 难度在 Bun 下约 2–5 秒解出（实测值，随设备、负载与运行时版本而异）；搜索受难度约束，可中止。

## 开发

```sh
bun test                    # 全部测试（fake 假服务器，不触网）
bun run check               # 以宿主方式加载插件并校验钩子
npm pack --dry-run          # 预览发布内容
```

结构：运行时源码在 `src/`——`index.mjs`（入口：导出 `server` 与测试用的 `_internal`）、`config.mjs`（供应商 id、模型与页面常量）、`browser-token.mjs`（浏览器登录：读取 profile 令牌并校验）、`api.mjs`（网页 API：请求头、应答信封、工作量证明挑战、会话增删、标题请求识别）、`stream.mjs`（SSE 补丁流与 DSML 折叠）、`openai.mjs`（OpenAI 兼容分片与消息扁平化）、`attachments.mjs`（附件上传与解析）、`turn.mjs`（单轮补全与续写）、`plugin.mjs`（`server` 钩子组装）、`pow.mjs`（哈希与求解）；测试在 `test/`（含从真实账号抓取的逐字 SSE 帧回归用例），假服务器为 `test/fake.mjs`，官方求解器基准 `pow_solver.wasm` 在 `test/fixtures/`。

## 许可

MIT，见 [LICENSE](LICENSE)。第三方资源见 [THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt)：`pow_solver.wasm` 取自 DeepSeek 网页端自身，仅作测试基准分发；`assets/deepseek-color.svg` 取自 yetone/magpie（MIT）。

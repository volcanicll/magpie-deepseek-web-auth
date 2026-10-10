# DeepSeek (Web) — Magpie 非官方插件

**非官方声明**：本项目是 [Magpie](https://github.com/yetone/magpie) 的第三方供应商插件，**不是 DeepSeek 官方产品**，也尚未收录进 [magpie-community/plugins](https://github.com/magpie-community/plugins) 官方市场。实现遵循该社区仓库的插件规范，结构对齐其包约定，欢迎上游收录。

它把你在浏览器里**已登录的 [chat.deepseek.com](https://chat.deepseek.com) 账号**接入 Magpie：读取网页会话令牌，按网页端自己的协议（会话 + 工作量证明 + 补丁式流）发起对话——不消耗 DeepSeek 平台 API 额度，走的是网页账号本身。

包名 **`magpie-deepseek-web-auth`**，供应商 id **`deepseek-web`**。

| 模型 | 网页端对应 | 思考 |
|---|---|---|
| `deepseek-chat` | default | 关 |
| `deepseek-reasoner` | expert | 开 |

## 免责声明

- 本项目为**独立的第三方非官方实现**，与 DeepSeek（深度求索）官方、Magpie（yetone）官方及 magpie-community 社区均**无任何隶属或授权关系**；"DeepSeek" 及相关名称的一切权利归其所有者。
- 本插件通过逆向网页端协议、复用你**本人已登录**的会话调用 DeepSeek。此举可能违反 DeepSeek 的服务条款，存在账号被限流、风控或封禁的风险；**是否使用以及后果，由你自行判断并自行承担**。
- 本项目按"现状"提供，**不附带任何明示或默示的担保**。作者与贡献者不对因使用本项目导致的任何损失负责，包括但不限于账号封禁、对话数据丢失、服务不可用。
- 仅供个人学习与研究使用；请勿用于商业服务、转售、批量滥用或任何违法违规用途，请遵守你所在地区的法律法规与 DeepSeek 的服务条款。
- 网页端接口随时可能变更导致插件失效，作者不承诺维护周期；欢迎 issue 与 PR。
- **隐私**：会话令牌仅保存在本机 Magpie 的插件认证文件中，本项目不收集、不上传任何数据；安装请认准本仓库，谨防仿冒。
- `pow_solver.wasm` 来自 DeepSeek 网页端自身，仅作为测试基准随仓库分发，版权归 DeepSeek 所有。

## 安装

三种方式任选其一，无需编译、无需 `npm install`：

```sh
# ① 从 GitHub 直接安装（推荐）
magpie plugin add github:volcanicll/magpie-deepseek-web-auth

# ② 克隆后从本地目录安装（目录需保持固定）
git clone https://github.com/volcanicll/magpie-deepseek-web-auth.git
magpie plugin add ./magpie-deepseek-web-auth

# ③ npm 包（发布后可用）
magpie plugin add magpie-deepseek-web-auth
```

也可以在 Magpie 的 **插件（Plugins）** 页面添加本地目录并启用。

**从旧版（本地开发目录）迁移**：先移除旧安装再添加新包，供应商 id 不变，已登录的账号自动沿用，无需重新登录：

```sh
magpie plugin remove /path/to/magpie-plugins/packages/deepseek
magpie plugin add github:volcanicll/magpie-deepseek-web-auth
```

## 登录

两种方式（`magpie plugin login deepseek-web` 或在插件页点击登录）：

- **浏览器登录（推荐）**：自动扫描本机 Chromium 系浏览器（Chrome / Chromium / Brave / Edge / Vivaldi / Arc）的 Local Storage，找到已登录 chat.deepseek.com 的会话令牌，并先向 DeepSeek 验证有效性再保存。只读取令牌，不写入浏览器。
- **粘贴令牌**：在其他机器或浏览器无法读取时，在已登录的 chat.deepseek.com 标签页控制台执行下面这行，把输出粘贴给插件：

  ```js
  JSON.parse(localStorage.getItem("userToken")).value
  ```

令牌长期有效；DeepSeek 侧退出登录或改密会使它失效，届时重新登录网页再登录一次插件即可。

## 连续对话如何工作

一个 Magpie 会话对应 **一个** chat.deepseek.com 聊天：

- 插件通过 `chat.headers` 钩子拿到 agent 的会话 id，把同一会话的后续轮次**接续**到同一个网页聊天里：每轮只发送新增的用户消息，并用 `parent_message_id` 链到上一轮回复——与网页端行为一致，历史不重发。
- 标题请求（magpie 生成会话标题的内置提示词）不属于对话内容：它在**一次性临时聊天**里应答，标题返回后**立即删除**该聊天，账号聊天列表不留痕。
- 会话失效（被删除、过期）自动开新聊天并携带全量标注历史重试一次，上下文不丢。

## 限制

- **不支持工具调用（function calling）**：网页端协议本身没有开放 `tools` 字段（响应里的 `TOOL_*` 片段是它内置的联网搜索）。需要工具的 agent 会以纯文本模式降级；需要真正的 function calling 请使用 DeepSeek 平台 API（`api.deepseek.com` 的付费 key），两者可并存。
- 纯文本；网页端的文件上传与联网搜索暂未接入。
- 网页端没有可读的额度接口，用量卡片不显示窗口。
- 使用网页账号调用非官方客户端存在被风控的可能，仅供个人学习与个人账号使用；请自行评估并遵守 DeepSeek 的服务条款。

## 工作量证明（PoW）

`pow.mjs` 是零依赖的 `DeepSeekHashV1` 实现：SHA3-256 海绵构造、KECCAK-p[1600] 只跑第 1–23 轮，在 `salt_expireAt_nonce` 上从 0 搜索到 `difficulty-1`。测试双重锚定：

- 24 轮时与 `node:crypto` 的 SHA3-256 逐字节一致（钉死置换、填充、多块吸收）；
- 23 轮时与 DeepSeek 官方 `pow_solver.wasm`（随包附带）逐字节一致，并用官方 `wasm_solve` 反向求解验证。

144000 难度在 Bun 下约 2–5 秒解出；搜索受难度约束，可中止。

## 开发

```sh
bun test                    # 全部测试（fake 假服务器，不触网）
bun run check               # 以宿主方式加载插件并校验钩子
npm pack --dry-run          # 预览发布内容
```

结构：`index.mjs`（插件本体：登录、模型、OpenAI 兼容 fetch、会话映射）、`pow.mjs`（哈希与求解）、`pow_solver.wasm`（官方求解器，测试基准）、`fake.mjs`（chat.deepseek.com 假服务器）、`tests/`（含从真实账号抓取的逐字 SSE 帧回归用例）。

## 许可

MIT。`pow_solver.wasm` 来自 DeepSeek 网页端自身，仅作测试基准随包分发，版权归原主所有。

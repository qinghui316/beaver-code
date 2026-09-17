<div align="center">

<img src="./docs/assets/readme/beaver-code.png" width="120" alt="Beaver Code 图标" />

# Beaver Code

**本地优先的 Agent 开发桌面工作台**

*A local-first desktop workspace for agentic software development.*

[![Windows x64](https://img.shields.io/badge/Windows-x64-111111?logo=windows11&logoColor=white)](https://github.com/qinghui316/beaver-code/releases/latest)
[![Latest release](https://img.shields.io/github/v/release/qinghui316/beaver-code?label=release&color=111111)](https://github.com/qinghui316/beaver-code/releases/latest)
[![ISC License](https://img.shields.io/badge/license-ISC-111111)](./LICENSE)

[下载 Windows 版](https://github.com/qinghui316/beaver-code/releases/latest) · [查看安全说明](./SECURITY.md)

</div>

Beaver Code 把 Codex、项目对话、文件、Terminal 和 Git 放进同一个桌面工作台。你可以直接和 Agent 一起开发，也可以切换到 AHO 模式，让多个 Agent 按规划、开发、测试和审查流程协作，并在关键步骤保留人工确认。

它面向希望把 AI 编程真正放进日常开发流程的个人开发者：从一句需求开始，查看 Agent 正在做什么，在同一个窗口里检查代码、命令和 Git 变化，再决定下一步。

---

## 两种工作方式

| 模式 | 适合什么任务 | 工作方式 |
| --- | --- | --- |
| **Agent** | 快速修改、调试和连续对话 | 直接与 Agent 协作，选择模型和推理强度，实时查看思考、回复、工具调用与文件变化。 |
| **AHO** | 需要规划、分工和检查的复杂任务 | 让多个 Agent 按流程协作，在规划、开发、测试、审查和关键决定之间保留清晰的进度与人工确认。 |

两个模式共用同一套项目、对话、文件、Terminal 和 Git 工作区，但各自保留独立的会话、草稿和执行状态。

## 你可以用它做什么

### 和 Agent 一起开发

- 用自然语言描述需求、补充上下文并连续追问。
- 引用项目文件、添加附件和技能，让本次任务获得需要的材料。
- 用户消息立即进入对话，随后原位展示正在思考、正在回复和完成状态。
- 在 Agent 工作时停止当前任务，或把下一条需求加入待发送列表。

### 在一个窗口里完成开发工作

- 浏览项目文件并查看代码变化。
- 打开内置 Terminal，运行真实项目命令。
- 查看 Git 状态、Diff、Branch 和 Commit。
- 发起代码审查，从当前节点创建新会话，并查看上下文使用情况。

### 让多 Agent 协作过程可见

- AHO 模式把规划、开发、测试和审查组织成可检查的协作过程。
- Agent Office 展示当前真实 Agent 的角色、活动和交接状态。
- 需要输入、授权或确认时，Beaver Code 会停下来等待你的决定。
- 历史会话、草稿和待发送内容会保存在本机，重新启动后可以继续工作。

## 下载与安装

当前公开版本面向 **Windows x64**，仍处于 1.0 前的持续完善阶段。

1. 前往 [GitHub Releases](https://github.com/qinghui316/beaver-code/releases/latest)。
2. 下载最新的 `Beaver-Code-Setup-*-win-x64.exe`。
3. 运行安装程序并启动 Beaver Code。

当前安装包尚未使用 Windows Authenticode，因此系统可能显示“未知发布者”。Beaver Code 的应用内更新会校验产品自己的发布签名；完整说明见 [SECURITY.md](./SECURITY.md)。

安装后的稳定版会从 GitHub Releases 检查更高版本。更新下载完成后，由你选择何时重新启动并安装。

## 快速开始

1. 安装并启动 Beaver Code。
2. 选择一个本地 Git 项目。
3. 确认本机可以使用 Codex。
4. 选择 Agent 或 AHO 模式，输入任务并发送。

如果只是想快速修改和调试，先从 Agent 模式开始；如果任务需要明确规划、多人分工、测试和审查，切换到 AHO 模式。

## 数据与隐私

Beaver Code 是本地优先的桌面应用：

- 项目登记、会话、草稿、待发送内容和应用设置默认保存在 `~/.agent-harness`。
- 更新或卸载 Beaver Code 时，不会默认删除该目录。
- Beaver Code 不会把整个本地数据目录上传到自己的服务。
- 当你运行 Agent 时，本次请求所需的内容会发送给你当前使用的 AI 服务，并遵循该服务的账户、配置和隐私条款。

发送敏感内容前，请检查当前选择的文件、附件、技能和其他上下文。更多信息见 [PRIVACY.md](./PRIVACY.md)。

## 本地开发

需要 [Node.js 20+](https://nodejs.org/) 和 npm。

```powershell
git clone https://github.com/qinghui316/beaver-code.git
cd beaver-code
npm ci
npm run dev:desktop
```

提交修改前运行：

```powershell
npm run typecheck
npm run lint
npm run test:fast
```

完整的桌面构建、原生模块、安装包和发布说明见 [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md)。

## 项目文档

- [产品定位](./docs/PRODUCT.md)
- [开发指南](./docs/DEVELOPMENT.md)
- [隐私说明](./PRIVACY.md)
- [安全说明](./SECURITY.md)

## License

[ISC](./LICENSE)

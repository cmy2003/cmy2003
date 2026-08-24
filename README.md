# dsh-plugin-k8s-sdk

DSH (DeepSeek Harness) Kubernetes SDK 插件，基于 Cordis 框架开发，使用 `@kubernetes/client-node` 官方 SDK 直连 Kubernetes APIServer。

## 特性

- 无需安装或调用 `kubectl` 二进制
- 不依赖 `child_process`，所有 K8s 操作均通过官方 Node.js SDK 完成
- 支持 DSH Agent 调用三个内置工具：
  - `k8s_list_nodes`：列出集群节点名称、内网 IP、Ready 状态
  - `k8s_list_pods`：列出指定命名空间下的 Pod 名称和运行阶段
  - `k8s_get_pod_log`：获取指定 Pod 最新日志，默认返回最近 100 行
- 所有工具返回 JSON 字符串，包含 `success`、`data` 或 `error` 字段
- 统一错误分类：`KCFG_*`、`NET_*`、`AUTH_*`、`API_*`
- 不输出任何证书或敏感信息到日志与返回结果

## 目录结构

```text
dsh-plugin-k8s-sdk/
├── src/
│   ├── index.ts          # 主入口
│   └── self-test.ts      # 自检脚本
├── dist/                 # tsc 编译输出（CommonJS）
├── cordis.patch.yml      # Cordis/DSH 插件清单
├── package.json          # 含 dsh.bundle.patch 配置
├── tsconfig.json         # TypeScript 编译配置
├── README.md
├── LICENSE
├── .gitignore
└── .github/workflows/build.yml
```

## 前置准备

1. 准备可用的 kubeconfig：
   - Windows：`%USERPROFILE%\.kube\config`
   - Linux/macOS：`~/.kube/config`
2. 确保当前 `current-context` 指向目标集群：
   ```bash
   kubectl config get-contexts
   kubectl config use-context <your-context>
   ```
3. 确保 DSH 所在机器能够直接访问 Kubernetes APIServer：
   - 默认端口通常为 `6443`
   - 若 DSH 运行在宿主机，K8s 集群在 VMware 虚拟机中，使用 **NAT 网络**时，请确保 VMware NAT 端口转发已将宿主机的某个端口映射到虚拟机 APIServer 的 `6443`，并在 kubeconfig 中使用宿主机可达的地址。
   - 若 DSH 与 K8s 集群都在 VMware 虚拟机内部，请确认虚拟机之间网络互通，且防火墙放行 `6443`、`10250` 等必要端口。
   - 若使用云厂商集群，请将 kubeconfig 中的 server 地址替换为公网或内网可达的 API 端点。

## 一键安装

将本项目推送到 GitHub 后，使用以下命令安装：

```bash
dsh plugin --profile web add github:你的GitHub用户名/dsh-plugin-k8s-sdk
```

安装后重启 DSH 或刷新 WebUI 即可看到三个工具。

## DSH WebUI 调用示例

在 DSH WebUI 中直接使用自然语言即可：

- “查看当前 Kubernetes 集群有哪些节点，并告诉我它们的 Ready 状态。”
- “帮我列出 default 命名空间下所有 Pod 及运行阶段。”
- “查看 nginx-deployment-xxxxx 这个 Pod 最近 100 行日志。”
- “查看 myapp 命名空间下 pod-api-12345 的最后 200 行日志。”

## 本地开发调试

```bash
# 1. 安装依赖
npm install

# 2. 编译
npm run build

# 3. 自检：加载本机 kubeconfig 并尝试列出节点
npm run self-test

# 4. 通过 DSH 加载本地插件（以本地目录方式调试）
dsh plugin --profile web add local:.
# 或按 DSH 实际本地插件加载语法执行，例如：
# dsh plugin --profile web add file:///D:/DSH/dsh-plugin-k8s-sdk
```

修改 `src/index.ts` 后重新执行：

```bash
npm run build
```

然后重启 DSH 或重新加载插件。

## 自检命令

```bash
npm run self-test
```

该命令会：

1. 使用默认 kubeconfig 路径加载配置；
2. 创建 `@kubernetes/client-node` 客户端；
3. 调用 `listNode()` 获取集群节点列表；
4. 输出诊断 JSON，包含 `success`、`currentContext`、`nodeCount` 和节点信息。

若 kubeconfig 缺失、网络不通或权限不足，会输出对应的标准化错误 JSON。

## 错误码说明

| 错误码前缀 | 含义 |
| --- | --- |
| `KCFG_*` | kubeconfig 文件不存在、格式错误、无上下文或插件未初始化 |
| `NET_*` | APIServer 网络连接失败、超时、DNS 解析失败 |
| `AUTH_*` | 认证失败（401）或权限不足（403） |
| `API_*` | API 404、HTTP 异常或其他业务错误 |

## 协议

本项目使用 [MIT License](./LICENSE) 开源，允许自由使用、修改、分发和商用，需保留原始版权声明。

## 发布说明

- 发布前请执行 `npm run prepublishOnly`，确保自动完成 TypeScript 编译。
- 项目已配置 `.github/workflows/build.yml`，推送后自动运行 `npm install && npm run build && npm run self-test`（自检步骤仅作为构建验证，若环境无 kubeconfig 会失败，可按需调整）。

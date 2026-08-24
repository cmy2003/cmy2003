import { CoreV1Api, KubeConfig } from '@kubernetes/client-node';
import { z } from 'zod';

/**
 * DSH/Cordis Context 的最小结构定义。
 * 运行时由 @deepseek-ai/dsh 提供，这里仅做类型兼容，避免构建依赖未发布的 peer 包。
 */
export interface Context {
  on(event: string, listener: () => void): void;
  logger: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
  registerTool(definition: any): void;
}

let runtime: { kc: KubeConfig; api: CoreV1Api } | null = null;

interface KubeErrorInfo {
  code: string;
  message: string;
}

function kubeconfigError(err: unknown): KubeErrorInfo {
  const raw = err instanceof Error ? err.message : String(err);
  if (/no such file|ENOENT|not exist|找不到/i.test(raw)) {
    return { code: 'KCFG_NOT_FOUND', message: '未找到 kubeconfig 文件，请检查 ~/.kube/config 是否存在。' };
  }
  if (/current context|no context|context/i.test(raw)) {
    return { code: 'KCFG_NO_CONTEXT', message: 'kubeconfig 中没有可用的 current-context，请先执行 kubectl config use-context。' };
  }
  if (/parse|invalid|yaml|格式/i.test(raw)) {
    return { code: 'KCFG_PARSE_ERROR', message: 'kubeconfig 文件解析失败，请检查 YAML 格式是否正确。' };
  }
  return { code: 'KCFG_LOAD_FAILED', message: `kubeconfig 加载失败：${raw}` };
}

function apiError(err: unknown): KubeErrorInfo {
  const raw = err as any;
  const code: string = raw?.code || raw?.cause?.code || '';
  const status: number | undefined = raw?.statusCode || raw?.response?.statusCode || raw?.status;

  if (code === 'ECONNREFUSED') {
    return { code: 'NET_CONNECTION_REFUSED', message: '无法连接 Kubernetes APIServer，请确认 apiserver 地址与端口可达。' };
  }
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') {
    return { code: 'NET_TIMEOUT', message: '连接 Kubernetes APIServer 超时，请检查网络和防火墙规则。' };
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return { code: 'NET_DNS_NOT_FOUND', message: '无法解析 Kubernetes APIServer 域名，请检查 DNS 或 hosts 配置。' };
  }
  if (code === 'ECONNRESET' || code === 'EPIPE') {
    return { code: 'NET_CONNECTION_RESET', message: '与 Kubernetes APIServer 的连接被重置，请检查网络稳定性。' };
  }

  if (status === 401) {
    return { code: 'AUTH_UNAUTHORIZED', message: 'Kubernetes 认证失败（401），请检查 kubeconfig 中的 token 或客户端证书。' };
  }
  if (status === 403) {
    return { code: 'AUTH_FORBIDDEN', message: 'Kubernetes 权限不足（403），当前账号无权执行该操作。' };
  }
  if (status === 404) {
    return { code: 'API_NOT_FOUND', message: '请求的 Kubernetes 资源不存在（404）。' };
  }
  if (status) {
    return { code: `API_HTTP_${status}`, message: `Kubernetes API 返回 HTTP ${status}：${raw?.message || raw?.body || ''}` };
  }
  return { code: 'API_UNKNOWN', message: `Kubernetes API 调用失败：${raw?.message || String(raw)}` };
}

function ok(data: unknown): string {
  return JSON.stringify({ success: true, data });
}

function fail(code: string, message: string, ctx?: Context, op?: string, err?: unknown): string {
  if (ctx && op && err) {
    const stack = (err as any)?.stack || String(err);
    ctx.logger.error(`[${op}] ${message}\n${stack}`);
  }
  return JSON.stringify({ success: false, error: { code, message } });
}

function requireRuntime(ctx: Context, op: string): { ok: true; api: CoreV1Api } | { ok: false; result: string } {
  if (!runtime) {
    return {
      ok: false,
      result: fail(
        'KCFG_NOT_READY',
        'Kubernetes SDK 尚未初始化，请检查 kubeconfig 配置或查看插件日志。',
        ctx,
        op
      ),
    };
  }
  return { ok: true, api: runtime.api };
}

async function listNodes(ctx: Context): Promise<string> {
  const rt = requireRuntime(ctx, 'k8s_list_nodes');
  if (!rt.ok) return rt.result;
  try {
    const res = await rt.api.listNode();
    const nodes = res.body.items.map((node) => {
      const internalIP = node.status?.addresses?.find((addr) => addr.type === 'InternalIP')?.address ?? '';
      const ready = node.status?.conditions?.find((cond) => cond.type === 'Ready')?.status === 'True';
      return {
        name: node.metadata?.name ?? '',
        internalIP,
        ready,
      };
    });
    return ok({ nodes });
  } catch (err) {
    const info = apiError(err);
    return fail(info.code, info.message, ctx, 'k8s_list_nodes', err);
  }
}

async function listPods(ctx: Context, namespace: string): Promise<string> {
  const rt = requireRuntime(ctx, 'k8s_list_pods');
  if (!rt.ok) return rt.result;
  try {
    const res = await rt.api.listNamespacedPod(namespace);
    const pods = res.body.items.map((pod) => ({
      name: pod.metadata?.name ?? '',
      phase: pod.status?.phase ?? '',
    }));
    return ok({ namespace, pods });
  } catch (err) {
    const info = apiError(err);
    return fail(info.code, info.message, ctx, 'k8s_list_pods', err);
  }
}

async function getPodLog(ctx: Context, podName: string, namespace: string, tailLines: number): Promise<string> {
  const rt = requireRuntime(ctx, 'k8s_get_pod_log');
  if (!rt.ok) return rt.result;
  try {
    const res = await rt.api.readNamespacedPodLog(
      podName,
      namespace,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      tailLines,
      false
    );
    return ok({ podName, namespace, tailLines, log: res.body });
  } catch (err) {
    const info = apiError(err);
    return fail(info.code, info.message, ctx, 'k8s_get_pod_log', err);
  }
}

export function apply(ctx: Context): void {
  ctx.on('ready', () => {
    try {
      const kc = new KubeConfig();
      kc.loadFromDefault();
      Object.assign(kc, { requestTimeout: 30000 });
      runtime = {
        kc,
        api: kc.makeApiClient(CoreV1Api),
      };
      ctx.logger.info(`Kubernetes SDK 插件已就绪，当前上下文：${kc.getCurrentContext()}`);
    } catch (err) {
      runtime = null;
      const info = kubeconfigError(err);
      ctx.logger.error(`[ready] ${info.message}\n${(err as any)?.stack || String(err)}`);
    }
  });

  ctx.registerTool({
    name: 'k8s_list_nodes',
    description: '获取 Kubernetes 集群中所有节点名称、内网 IP 和 Ready 状态。',
    schema: z.object({}),
    handler: async () => listNodes(ctx),
  });

  ctx.registerTool({
    name: 'k8s_list_pods',
    description: '获取指定命名空间下所有 Pod 名称及运行阶段（Phase）。',
    schema: z.object({
      namespace: z.string().default('default').describe('目标命名空间，默认值为 default。'),
    }),
    handler: async (args: { namespace?: string }) => {
      const namespace = args.namespace || 'default';
      return listPods(ctx, namespace);
    },
  });

  ctx.registerTool({
    name: 'k8s_get_pod_log',
    description: '获取指定 Pod 的最新日志，默认返回最近 100 行。',
    schema: z.object({
      podName: z.string().describe('需要读取日志的 Pod 名称（必填）。'),
      namespace: z.string().default('default').describe('目标命名空间，默认值为 default。'),
      tailLines: z.coerce.number().int().min(1).max(5000).default(100).describe('返回日志尾部行数，默认值为 100。'),
    }),
    handler: async (args: { podName: string; namespace?: string; tailLines?: number }) => {
      const podName = args.podName;
      const namespace = args.namespace || 'default';
      const tailLines = args.tailLines ?? 100;
      return getPodLog(ctx, podName, namespace, tailLines);
    },
  });
}

export default apply;

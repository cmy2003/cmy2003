import { CoreV1Api, KubeConfig } from '@kubernetes/client-node';

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

async function main(): Promise<void> {
  let kc: KubeConfig;
  let api: CoreV1Api;

  try {
    kc = new KubeConfig();
    kc.loadFromDefault();
    Object.assign(kc, { requestTimeout: 30000 });
    api = kc.makeApiClient(CoreV1Api);
  } catch (err) {
    const info = kubeconfigError(err);
    process.stderr.write(JSON.stringify({ success: false, error: info }, null, 2) + '\n');
    process.exit(1);
    return;
  }

  try {
    const res = await api.listNode();
    const nodes = res.body.items.map((node) => {
      const internalIP = node.status?.addresses?.find((addr) => addr.type === 'InternalIP')?.address ?? '';
      const ready = node.status?.conditions?.find((cond) => cond.type === 'Ready')?.status === 'True';
      return {
        name: node.metadata?.name ?? '',
        internalIP,
        ready,
      };
    });
    process.stdout.write(
      JSON.stringify(
        {
          success: true,
          currentContext: kc.getCurrentContext(),
          nodeCount: nodes.length,
          nodes,
        },
        null,
        2
      ) + '\n'
    );
  } catch (err) {
    const info = apiError(err);
    process.stderr.write(JSON.stringify({ success: false, error: info }, null, 2) + '\n');
    process.exit(1);
  }
}

main();

/** Typed locale dictionaries for the SSH remote workspace panel. */

/** Dictionary key union owned by this plugin. */
export type SshRemoteKey =
  | 'panel.title'
  | 'panel.empty'
  | 'panel.refresh'
  | 'target.connect'
  | 'target.connecting'
  | 'target.open'
  | 'target.retry'
  | 'target.disconnect'
  | 'phase.checking'
  | 'phase.installing-node'
  | 'phase.installing-dsh'
  | 'phase.starting'
  | 'phase.tunneling'
  | 'phase.ready'
  | 'phase.error'
  | 'error.refresh'

/** Dictionary namespace owned by this plugin. */
export const NS = 'sshRemote'

/** English dictionary. */
export const en: Record<SshRemoteKey, string> = {
  'panel.title': 'SSH workspaces',
  'panel.empty': 'No Host entries found in ~/.ssh/config.',
  'panel.refresh': 'Refresh',
  'target.connect': 'Connect',
  'target.connecting': 'Connecting…',
  'target.open': 'Open',
  'target.retry': 'Retry',
  'target.disconnect': 'Disconnect',
  'phase.checking': 'Checking remote…',
  'phase.installing-node': 'Installing Node.js…',
  'phase.installing-dsh': 'Installing dsh…',
  'phase.starting': 'Starting backend…',
  'phase.tunneling': 'Opening tunnel…',
  'phase.ready': 'Ready',
  'phase.error': 'Error',
  'error.refresh': 'Failed to load SSH targets.',
}

/** 中文词典。 */
export const zh: Record<SshRemoteKey, string> = {
  'panel.title': 'SSH 工作区',
  'panel.empty': '未在 ~/.ssh/config 中发现 Host 条目。',
  'panel.refresh': '刷新',
  'target.connect': '连接',
  'target.connecting': '连接中…',
  'target.open': '打开',
  'target.retry': '重试',
  'target.disconnect': '断开',
  'phase.checking': '检查远程环境…',
  'phase.installing-node': '正在安装 Node.js…',
  'phase.installing-dsh': '正在安装 dsh…',
  'phase.starting': '正在启动后端…',
  'phase.tunneling': '正在建立隧道…',
  'phase.ready': '就绪',
  'phase.error': '错误',
  'error.refresh': '加载 SSH 目标失败。',
}

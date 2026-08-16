/** Locale bundles for the runner-devices settings section. */

/** Locale keys this section renders. */
export type RunnerDevicesKey =
  | 'nav' | 'intro' | 'loading' | 'error' | 'retry'
  | 'connected' | 'offline' | 'noDevices' | 'noDevicesHint'
  | 'folderIntro' | 'pathPlaceholder' | 'pathFor' | 'browse'
  | 'browsing' | 'browseError' | 'openFolder' | 'isDirectory'
  | 'isFile' | 'isOther' | 'attachFolder' | 'attaching'
  | 'offlineHint'

/** English copy. */
export const en: Record<RunnerDevicesKey, string> = {
  nav: 'Runner devices',
  intro:
    'Laptops connected with `dsh-runner connect` appear here. Attach a laptop folder '
    + 'and it becomes a workspace in the sidebar — prompts there run the agent on this '
    + 'server, with every tool call executed on the laptop.',
  loading: 'Loading devices…',
  error: 'Could not load runner devices.',
  retry: 'Retry',
  connected: 'Connected',
  offline: 'Offline',
  noDevices: 'No connected devices',
  noDevicesHint: 'Run `dsh-runner connect --server <this host> --user <your id>` on a laptop to connect it.',
  folderIntro: 'Attach a folder on this laptop as a server workspace:',
  pathPlaceholder: 'e.g. /home/you/projects or C:\\Users\\you\\code',
  pathFor: 'Folder path on {device}',
  browse: 'Browse',
  browsing: 'Browsing…',
  browseError: 'Could not browse that path.',
  openFolder: 'Open',
  isDirectory: 'folder',
  isFile: 'file',
  isOther: 'other',
  attachFolder: 'Attach as workspace',
  attaching: 'Attaching…',
  offlineHint: 'Reconnect the laptop to attach a folder.',
}

/** Simplified Chinese copy. */
export const zh: Record<RunnerDevicesKey, string> = {
  nav: '运行器设备',
  intro: '使用 `dsh-runner connect` 连接的笔记本电脑会显示在这里。附加笔记本上的一个文件夹后，它会成为侧边栏中的一个工作区——在该工作区发送提示词时，代理在本服务器上运行，而所有工具调用都在笔记本电脑上执行。',
  loading: '正在加载设备…',
  error: '无法加载运行器设备。',
  retry: '重试',
  connected: '已连接',
  offline: '离线',
  noDevices: '没有已连接的设备',
  noDevicesHint: '在笔记本电脑上运行 `dsh-runner connect --server <本主机> --user <你的 id>` 来连接。',
  folderIntro: '将此笔记本电脑上的一个文件夹附加为服务器工作区：',
  pathPlaceholder: '例如 /home/you/projects 或 C:\\Users\\you\\code',
  pathFor: '{device} 上的文件夹路径',
  browse: '浏览',
  browsing: '正在浏览…',
  browseError: '无法浏览该路径。',
  openFolder: '打开',
  isDirectory: '文件夹',
  isFile: '文件',
  isOther: '其他',
  attachFolder: '附加为工作区',
  attaching: '正在附加…',
  offlineHint: '重新连接笔记本电脑即可附加文件夹。',
}

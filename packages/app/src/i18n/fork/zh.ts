/**
 * Fork-local Simplified Chinese copy.
 *
 * Keys missing here fall back to `./en.ts`, which in turn sits on top of the upstream English base.
 * See FORK.md.
 */
type EnDict = (typeof import("./en"))["dict"]

export const dict = {
  "fork.settings.tab.configFile": "配置文件",

  "fork.prompt.working": "正在工作",

  "fork.tps.label": "TPS",
  "fork.tps.title": "最近几秒的输出速度（token/秒）。按到达的文本估算，非精确计数。",

  "fork.config.section.title": "全局配置",
  "fork.config.section.description":
    "编辑所选服务器的全局配置文件。大部分改动立即生效；服务器监听参数（port、hostname、cors、mdns）需要手动重启服务器。",
  "fork.config.file.label": "文件",
  "fork.config.server.label": "服务器",

  "fork.config.action.save": "保存",
  "fork.config.action.revert": "放弃更改",
  "fork.config.action.reload": "从服务器重新载入",

  "fork.config.status.clean": "无更改",
  "fork.config.status.dirty": "有未保存的更改",
  "fork.config.status.saving": "保存中…",
  "fork.config.status.saved": "已保存",

  "fork.config.error.json": "JSON 语法错误",
  "fork.config.error.schema": "不符合配置 schema",
  "fork.config.error.load": "无法读取配置文件",
  "fork.config.error.unsupported": "{{server}} 不提供配置文件访问。它没有运行本 fork 的构建，或者版本早于这个功能。",
  "fork.config.error.save": "无法保存配置文件",

  "fork.config.editor.label": "配置文件内容",
  "fork.config.status.checking": "校验中…",
  "fork.config.status.valid": "校验通过",
  "fork.config.problems.title": "问题",

  "fork.config.reference.title": "可用配置项",
  "fork.config.reference.search": "搜索配置项…",
  "fork.config.reference.empty": "没有匹配的配置项",
  "fork.config.reference.insert": "插入到光标处",
  "fork.config.reference.count": "{{shown}} / {{total}}",

  "fork.usage.title": "用量",
  "fork.usage.session.title": "会话用量",
  "fork.usage.command": "查看用量",
  "fork.usage.command.description": "当前会话与其他各处的花费、请求数和 token",
  "fork.usage.server": "服务器",
  "fork.usage.error.load": "无法加载用量",
  "fork.usage.error.unsupported": "{{server}} 不上报用量。它没有运行本 fork 的构建，或者版本早于这个功能。",

  "fork.usage.range.5h": "5 小时",
  "fork.usage.range.1d": "1 天",
  "fork.usage.range.7d": "7 天",
  "fork.usage.range.30d": "30 天",
  "fork.usage.range.all": "全部",

  "fork.usage.metric.cost": "花费",
  "fork.usage.metric.requests": "请求数",
  "fork.usage.metric.input": "输入",
  "fork.usage.metric.output": "输出",
  "fork.usage.cached.pct": "{{pct}}% 命中缓存",

  "fork.usage.short.requests": "请求",
  "fork.usage.short.cost": "花费",
  "fork.usage.short.input": "入",
  "fork.usage.short.output": "出",
  "fork.usage.short.cached": "缓存",

  "fork.usage.range.label": "时间范围",
  "fork.usage.range.whole.5h": "最近 5 小时",
  "fork.usage.range.whole.1d": "最近 24 小时",
  "fork.usage.range.whole.7d": "最近 7 天",
  "fork.usage.range.whole.30d": "最近 30 天",
  "fork.usage.range.whole.all": "全部时间",
  "fork.usage.requests.n": "{{count}} 次请求",

  "fork.usage.chart.title": "请求与花费",
  "fork.usage.chart.hint": "花费按模型拆分",
  "fork.usage.chart.label": "每个时段的请求数与花费，花费按模型拆分",
  "fork.usage.chart.empty": "该区间内没有记录",
  "fork.usage.chart.other": "其他",
  "fork.usage.chart.all": "全部",
  "fork.usage.value.unset": "未记录",

  "fork.usage.projects.title": "项目",
  "fork.usage.models.title": "模型",
  "fork.usage.project.none": "仓库之外",

  "fork.usage.sessions.title": "会话",
  "fork.usage.sessions.count": "区间内 {{count}} 个",
  "fork.usage.sessions.hint": "子 agent 嵌在派生它的会话下",

  "fork.usage.heatmap.title": "每一天",
  "fork.usage.heatmap.hint": "每天的花费，全部历史",
  "fork.usage.heatmap.label": "过去一年每天的花费",
  "fork.usage.heatmap.empty": "还没有用量记录",

  "fork.usage.truncated": "分组过多，仅返回了前一部分",
} satisfies Partial<Record<keyof EnDict, string>>

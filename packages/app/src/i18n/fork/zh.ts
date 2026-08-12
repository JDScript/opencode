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
} satisfies Partial<Record<keyof EnDict, string>>

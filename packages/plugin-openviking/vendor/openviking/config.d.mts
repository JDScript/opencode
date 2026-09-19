export interface Config {
  enabled: boolean
  endpoint: string
  apiKey: string
  account: string
  user: string
  peerId: string
  mcpUrl: string
  credentialSource: string
  credentialPath: string
  configPath: string
  legacyCredentialsUsed: boolean
  userAgent: string
  timeoutMs: number
  mcp: { enabled: boolean }
  repoContext: { enabled: boolean; cacheTtlMs: number }
  autoRecall: {
    enabled: boolean
    limit: number
    scoreThreshold: number
    maxContentChars: number
    preferAbstract: boolean
    tokenBudget: number
    minQueryLength: number
  }
  autoCapture: boolean
  captureMode: string
  captureMaxLength: number
  captureAssistantTurns: boolean
  captureToolMaxChars: number
  commitTokenThreshold: number
  commitKeepRecentCount: number
  profileTokenBudget: number
  resumeContextBudget: number
  minQueryLength: number
  recallPeerScope: string
  noAutoInject: boolean
  bypassSession: boolean
  bypassSessionPatterns: string[]
  debug: boolean
  runtime?: { dataDir?: string }
  effectivePeer?: { peerId?: string; legacyPeerId?: string }
}

export function loadConfig(pluginRoot: string, projectDirectory?: string): Config
export function resolveDataDir(pluginRoot: string, config: Config): string

export interface ModelSettings {
  baseUrl: string
  apiKey: string
  model: string
}

export interface SdSettings {
  mode: 'local' | 'server'
  cliPath: string
  documentsFolder: string
  serverUrl: string
  token: string
}

export interface Settings {
  model: ModelSettings
  slashdocs: SdSettings
}

export const PRESETS = [
  { name: 'Particle (default)', baseUrl: 'https://api.particle.ai/v1', model: 'deepseek-v4.1-flash' },
  { name: 'LM Studio', baseUrl: 'http://localhost:1234/v1', model: 'deepseek-v4.1-flash' },
  { name: 'Ollama', baseUrl: 'http://localhost:11434/v1', model: 'clef-flash' },
  { name: 'Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/', model: 'gemini-2.5-flash' },
]

const KEY = 'agent-review-loop.settings.v1'

export const defaultSettings: Settings = {
  model: { baseUrl: 'https://api.particle.ai/v1', apiKey: '', model: 'deepseek-v4.1-flash' },
  slashdocs: {
    mode: 'local',
    cliPath: (import.meta as any).env?.VITE_SLASHDOCS_CLI || 'slashdocs',
    documentsFolder: '',
    serverUrl: '',
    token: '',
  },
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return structuredClone(defaultSettings)
    const parsed = JSON.parse(raw)
    return {
      model: { ...defaultSettings.model, ...parsed.model },
      slashdocs: { ...defaultSettings.slashdocs, ...parsed.slashdocs },
    }
  } catch {
    return structuredClone(defaultSettings)
  }
}

export function saveSettings(s: Settings): void {
  localStorage.setItem(KEY, JSON.stringify(s))
}

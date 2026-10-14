export type SdMode = 'local' | 'server'

export interface SlashdocsConfig {
  mode: SdMode
  /** Absolute path or name of the slashdocs CLI binary */
  cliPath: string
  /** local mode: folder served by `slashdocs local` */
  documentsFolder?: string
  /** server mode */
  serverUrl?: string
  token?: string
}

export interface ModelConfig {
  baseUrl: string
  apiKey: string
  model: string
}

export interface CommentAnchor {
  quote?: string
  prefix?: string
  suffix?: string
  dom_path?: string
  start_offset?: number
  end_offset?: number
}

export interface SdComment {
  id: string
  document_id?: string
  version_id?: string
  created_on_version_id?: string
  author?: { id: string; name?: string; type?: string }
  body: string
  selected_text?: string
  anchor?: CommentAnchor
  status: 'open' | 'resolved' | string
  created_at?: string
  resolved_at?: string | null
  replies?: unknown[]
}

export type VerdictKind = 'edited' | 'untouched' | 'deleted' | 'stale_anchor'

export interface CommentVerdict {
  comment_id: string
  quote: string | null
  human_comment: string
  agent_claim: string | null
  verdict: VerdictKind
  reanchor_mode: 'offsets' | 'exact' | 'fuzzy' | 'none'
  similarity: number | null
  v1_span: [number, number] | null
  v2_span: [number, number] | null
  before_snippet: string | null
  after_snippet: string | null
  note: string | null
}

export interface MetricValue {
  label: string
  key: string
  value: string
  detail: string
  na_reason: string | null
}

export interface RunMetrics {
  attribution_rate: MetricValue
  collateral_churn: MetricValue
  claim_accuracy: MetricValue
  cost_per_attributed_fix: MetricValue
  rounds_to_converge: MetricValue
  edited: number
  untouched: number
  deleted: number
  stale_anchor: number
  actionable: number
  total_tokens: number
  prompt_tokens: number
  completion_tokens: number
  pushes: number
  converged: boolean
}

export interface ClaimMismatch {
  comment_id: string
  claim: string
  computed: VerdictKind
  message: string
}

export interface AgentReport {
  comments: {
    comment_id: string
    claim: 'addressed' | 'not_addressed' | 'stale_anchor'
    change_summary: string
    rationale: string
  }[]
  notes: string
}

export interface RunRecord {
  id: string
  created_at: string
  phase: 'setup' | 'authored' | 'review' | 'revised' | 'scored'
  slashdocs: SlashdocsConfig
  model: ModelConfig
  target: { kind: 'brief'; brief: string } | { kind: 'existing'; docId: string }
  doc_id: string | null
  doc_url: string | null
  v1_version_id: string | null
  error: string | null
  log: { at: string; step: string; detail: string }[]
}

export const STALE_ANCHOR_STRING =
  'ATTRIBUTION: STALE ANCHOR - quote not found in current version; comment left unresolved'
export const CLAIM_MISMATCH_STRING =
  'VERIFICATION: MODEL CLAIMED ADDRESSED - ANCHORED TEXT UNCHANGED'

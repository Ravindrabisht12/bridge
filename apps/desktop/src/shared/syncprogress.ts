/** Progress of a registry catalogue sync, shared by main and renderer. */
export interface SyncProgress {
  phase: 'servers' | 'downloads' | 'done' | 'error'
  fetched: number
  total: number | null
  message?: string
}

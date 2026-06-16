/**
 * Persists task completions + manual tasks in localStorage when the API has no DB tables yet.
 * Keyed by backend user id. Migrated to TypeScript (issue #20).
 */

export type Completions = Record<string, string>
export type ManualTask = {
  id: string
  title: string
  startTime?: string | null
  completedAt?: string | null
}
export type LocalTaskState = { completions: Completions; manualTasks: ManualTask[] }

function key(userId: string): string {
  return `boilerindy-tasks-v1-${userId}`
}

export function loadLocalTasks(userId: string | null | undefined): LocalTaskState {
  if (!userId) return { completions: {}, manualTasks: [] }
  try {
    const raw = localStorage.getItem(key(userId))
    if (!raw) return { completions: {}, manualTasks: [] }
    const p = JSON.parse(raw)
    return {
      completions: typeof p.completions === 'object' && p.completions !== null ? p.completions : {},
      manualTasks: Array.isArray(p.manualTasks) ? p.manualTasks : [],
    }
  } catch {
    return { completions: {}, manualTasks: [] }
  }
}

export function saveLocalTasks(userId: string | null | undefined, state: LocalTaskState): void {
  if (!userId) return
  try {
    localStorage.setItem(
      key(userId),
      JSON.stringify({
        completions: state.completions,
        manualTasks: state.manualTasks,
      }),
    )
  } catch {
    /* quota */
  }
}

/** Same shape as GET /api/me/tasks/meta + flags for the Tasks page */
export function taskMetaFromLocalStore(userId: string | null | undefined) {
  const raw = loadLocalTasks(userId)
  return {
    completions: Object.entries(raw.completions).map(([calendar_item_id, completed_at]) => ({
      calendar_item_id,
      completed_at,
    })),
    manualTasks: raw.manualTasks.map((t) => ({
      id: t.id,
      title: t.title,
      startTime: t.startTime,
      endTime: null,
      category: 'manual_task',
      sourceType: 'manual',
      description: null,
      location: null,
      externalUid: null,
      sourceId: null,
      completedAt: t.completedAt || null,
      isManual: true,
    })),
    unavailable: true,
    local: true,
  }
}

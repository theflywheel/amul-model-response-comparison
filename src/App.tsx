import { useEffect, useMemo, useState } from 'react'
import Papa, { ParseResult } from 'papaparse'
import ReactMarkdown from 'react-markdown'
import rawCsv from '../OAN Projects - Model Responses.csv?raw'
import LoginForm from './LoginForm'

type QuestionRow = {
  id: string
  section: string
  question: string
  responses: string[]
}

type ParsedRow = Record<string, string>

type Selection = {
  questionIndex: number
  bestIndex: number
  secondIndex?: number | null
  timestamp: string
  sessionId: string
  userId: string
}

type LogEntry = {
  selection: Selection
  question: QuestionRow
  receivedAt: string
}

type ModelMapping = Record<string, string>

const LOGGER_BASE_URL =
  import.meta.env.VITE_LOGGER_URL || 'http://localhost:4000'
const ADMIN_TOKEN = import.meta.env.VITE_ADMIN_TOKEN || ''

function getCookie(name: string): string | null {
  if (typeof document === 'undefined') return null
  const value = `; ${document.cookie}`
  const parts = value.split(`; ${name}=`)
  if (parts.length === 2) return parts.pop()?.split(';').shift() ?? null
  return null
}

function setCookie(name: string, value: string, days = 365) {
  if (typeof document === 'undefined') return
  const expires = new Date()
  expires.setTime(expires.getTime() + days * 24 * 60 * 60 * 1000)
  document.cookie = `${name}=${value};expires=${expires.toUTCString()};path=/`
}

function parseCsv(csv: string): QuestionRow[] {
  const result: ParseResult<ParsedRow> = Papa.parse(csv, {
    header: true,
    skipEmptyLines: 'greedy',
  })

  const fields = result.meta.fields ?? []

  if (fields.length < 3) {
    return []
  }

  const lowerFields = fields.map((f) => f.toLowerCase())
  const questionIdField =
    fields[lowerFields.indexOf('question_id')] ?? undefined
  const sectionField = fields[lowerFields.indexOf('section')] ?? undefined
  const questionField = fields[lowerFields.indexOf('question')] ?? undefined
  const modelFields = fields.filter((name) =>
    /^model_/i.test(name.toLowerCase()),
  )

  const useNewFormat =
    !!questionField && modelFields.length >= 2 && !!questionIdField

  if (useNewFormat) {
    return (result.data as ParsedRow[])
      .map((row, index) => {
        const idRaw = (questionIdField && row[questionIdField]) || ''
        const id = idRaw.toString().trim() || String(index + 1)
        const section = sectionField ? row[sectionField]?.trim() ?? '' : ''
        const question = row[questionField!]?.trim() ?? ''
        const responses = modelFields.map((field) => {
          const value = row[field] ?? ''
          // Keep all model_* columns so the UI always sees the full
          // set of models (even if some answers are empty).
          return value.toString().replace(/^[\s\n\r]+|[\s\n\r]+$/g, '')
        })

        if (!question || responses.length === 0) {
          return null
        }

        return { id, section, question, responses }
      })
      .filter((row): row is QuestionRow => row !== null)
  }

  // Fallback: legacy format – first two columns are section + question,
  // remaining non-time columns are responses.
  const answerFields = fields.filter((name, index) => {
    if (index < 2) return false
    const lower = name.toLowerCase()
    return !lower.includes('time')
  })

  return (result.data as ParsedRow[])
    .map((row, index) => {
      const section = row[fields[0]]?.trim() ?? ''
      const question = row[fields[1]]?.trim() ?? ''
      const responses = answerFields
        .map((field) => {
          const value = row[field]?.trim() ?? ''
          return value.replace(/^[\s\n\r]+|[\s\n\r]+$/g, '')
        })
        .filter((value) => value.length > 0)

      if (!question || responses.length === 0) {
        return null
      }

      return { id: String(index + 1), section, question, responses }
    })
    .filter((row): row is QuestionRow => row !== null)
}

async function logSelection(selection: Selection, question: QuestionRow) {
  try {
    await fetch(`${LOGGER_BASE_URL}/api/log-selection`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        selection,
        question,
      }),
    })
  } catch {
    // For now, fail silently – this is a local helper.
  }
}

function App() {
  const [userId, setUserId] = useState<string | null>(() => getCookie('userId'))
  const [questions, setQuestions] = useState<QuestionRow[]>([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selections, setSelections] = useState<Record<number, Selection>>({})
  const [logged, setLogged] = useState<Record<number, boolean>>({})
  const [adminMode, setAdminMode] = useState(false)
  const [adminTokenInput, setAdminTokenInput] = useState('')
  const [adminAuthorized, setAdminAuthorized] = useState(false)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [logsError, setLogsError] = useState<string | null>(null)
  const [logsLoading, setLogsLoading] = useState(false)
  const [modelMapping, setModelMapping] = useState<ModelMapping>({})
  const [metrics, setMetrics] = useState<{
    totalSelections: number
    uniqueUsers: number
    recent24h: number
    bestModelWins: Array<{ best_index: number; count: number }>
    secondBestWins: Array<{ second_index: number; count: number }>
    avgSelectionsPerUser: string
  } | null>(null)
  const [filters, setFilters] = useState({
    userId: '',
    sessionId: '',
    questionIndex: '',
    dateFrom: '',
    dateTo: '',
  })
  const [sessionId] = useState(
    () =>
      (typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2)) as string,
  )
  const [comparisonSelections, setComparisonSelections] = useState<
    Record<number, number[]>
  >({})

  const handleLogin = (mobileNumber: string) => {
    setCookie('userId', mobileNumber)
    setUserId(mobileNumber)
  }

  useEffect(() => {
    try {
      const parsed = parseCsv(rawCsv)
      if (parsed.length === 0) {
        setError('No questions found in CSV.')
      } else {
        setQuestions(parsed)
      }
    } catch (err) {
      setError('Failed to parse CSV.')
      console.error(err)
    } finally {
      setLoading(false)
    }
  }, [])

  const currentQuestion = useMemo(
    () => (questions.length > 0 ? questions[currentIndex] : null),
    [questions, currentIndex],
  )

  const handleSelect = (bestIndex: number, secondIndex?: number | null) => {
    if (!currentQuestion || !userId) return

    setSelections((prev) => {
      const prevSelection = prev[currentIndex]
      const selection: Selection = {
        questionIndex: currentIndex,
        bestIndex,
        secondIndex:
          typeof secondIndex === 'number'
            ? secondIndex
            : prevSelection?.secondIndex ?? null,
        timestamp: new Date().toISOString(),
        sessionId,
        userId,
      }

      return {
        ...prev,
        [currentIndex]: selection,
      }
    })
  }

  const handlePrev = () => {
    setCurrentIndex((prev) => (prev > 0 ? prev - 1 : prev))
  }

  const handleNext = () => {
    const selectionForCurrent = selections[currentIndex]

    if (currentQuestion && selectionForCurrent && !logged[currentIndex]) {
      void logSelection(selectionForCurrent, currentQuestion)
      setLogged((prev) => ({ ...prev, [currentIndex]: true }))
    }

    setCurrentIndex((prev) =>
      prev < questions.length - 1 ? prev + 1 : prev,
    )
  }

  const handleToggleAdmin = () => {
    setAdminMode((prev) => !prev)
  }

  const toggleCompareModel = (responseIndex: number) => {
    setComparisonSelections((prev) => {
      const existing =
        prev[currentIndex] ??
        (currentQuestion
          ? currentQuestion.responses
              .map((_, idx) => idx)
              .slice(0, Math.min(2, currentQuestion.responses.length))
          : [])
      if (existing.includes(responseIndex)) {
        return {
          ...prev,
          [currentIndex]: existing.filter((i) => i !== responseIndex),
        }
      }
      // If already 2 selected and user clicks a 3rd, reset to just this one
      if (existing.length >= 2) {
        return {
          ...prev,
          [currentIndex]: [responseIndex],
        }
      }
      return {
        ...prev,
        [currentIndex]: [...existing, responseIndex],
      }
    })
  }

  const activeCompareIndices = (() => {
    const forQuestion = comparisonSelections[currentIndex]
    if (forQuestion !== undefined) {
      // Respect explicit user choice, including "no models selected"
      return forQuestion
    }
    // Initial default: first two models, only when user hasn't interacted yet
    return currentQuestion
      ? currentQuestion.responses
          .map((_, idx) => idx)
          .slice(0, Math.min(2, currentQuestion.responses.length))
      : []
  })()

  const labelForModelIndex = (idx: number) =>
    String.fromCharCode('A'.charCodeAt(0) + idx)

  const markBest = (idx: number) => {
    handleSelect(idx)
  }

  const markSecondBest = (idx: number) => {
    if (!currentQuestion || !userId) return
    setSelections((prev) => {
      const prevSelection = prev[currentIndex]
      if (!prevSelection) {
        // If no best yet, treat this as second, best remains undefined
        const selection: Selection = {
          questionIndex: currentIndex,
          bestIndex: idx,
          secondIndex: null,
          timestamp: new Date().toISOString(),
          sessionId,
          userId,
        }
        return { ...prev, [currentIndex]: selection }
      }
      if (prevSelection.bestIndex === idx) {
        return prev
      }
      const selection: Selection = {
        ...prevSelection,
        secondIndex: idx,
        timestamp: new Date().toISOString(),
      }
      return { ...prev, [currentIndex]: selection }
    })
  }

  const fetchMetrics = async () => {
    try {
      const res = await fetch(`${LOGGER_BASE_URL}/api/admin/metrics`, {
        headers: {
          'X-Admin-Token': adminTokenInput || ADMIN_TOKEN,
        },
      })
      if (res.ok) {
        const data = await res.json()
        setMetrics(data)
      }
    } catch (e) {
      console.error('Failed to load metrics', e)
    }
  }

  const fetchLogs = async () => {
    setLogsLoading(true)
    setLogsError(null)
    try {
      const params = new URLSearchParams()
      if (filters.userId) params.set('userId', filters.userId)
      if (filters.sessionId) params.set('sessionId', filters.sessionId)
      if (filters.questionIndex) params.set('questionIndex', filters.questionIndex)
      if (filters.dateFrom) params.set('dateFrom', filters.dateFrom)
      if (filters.dateTo) params.set('dateTo', filters.dateTo)

      const res = await fetch(
        `${LOGGER_BASE_URL}/api/log-selection?${params.toString()}`,
        {
          headers: {
            'X-Admin-Token': adminTokenInput || ADMIN_TOKEN,
          },
        },
      )
      if (!res.ok) {
        throw new Error(`Request failed with status ${res.status}`)
      }
      const data: { entries: LogEntry[] } = await res.json()
      setLogs(data.entries ?? [])
      setAdminAuthorized(true)
      // Also fetch model mapping and metrics when logs load successfully
      try {
        const [mappingRes] = await Promise.all([
          fetch(`${LOGGER_BASE_URL}/api/model-mapping`, {
            headers: {
              'X-Admin-Token': adminTokenInput || ADMIN_TOKEN,
            },
          }),
          fetchMetrics(),
        ])
        if (mappingRes.ok) {
          const mappingData: { mapping: ModelMapping } =
            await mappingRes.json()
          setModelMapping(mappingData.mapping ?? {})
        }
      } catch (e) {
        console.error('Failed to load model mapping/metrics', e)
      }
    } catch (err) {
      console.error(err)
      setLogsError('Failed to load logs (unauthorized or server error).')
      setAdminAuthorized(false)
    } finally {
      setLogsLoading(false)
    }
  }

  const handleDownload = async (format: 'csv' | 'json') => {
    try {
      const params = new URLSearchParams()
      params.set('format', format)
      if (filters.userId) params.set('userId', filters.userId)
      if (filters.sessionId) params.set('sessionId', filters.sessionId)
      if (filters.questionIndex) params.set('questionIndex', filters.questionIndex)
      if (filters.dateFrom) params.set('dateFrom', filters.dateFrom)
      if (filters.dateTo) params.set('dateTo', filters.dateTo)

      const res = await fetch(
        `${LOGGER_BASE_URL}/api/admin/export?${params.toString()}`,
        {
          headers: {
            'X-Admin-Token': adminTokenInput || ADMIN_TOKEN,
          },
        },
      )
      if (!res.ok) {
        throw new Error('Export failed')
      }

      const blob = await res.blob()
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `selections-${Date.now()}.${format}`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      window.URL.revokeObjectURL(url)
    } catch (err) {
      console.error('Failed to download', err)
      alert('Failed to download data')
    }
  }

  if (!userId) {
    return <LoginForm onLogin={handleLogin} />
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <div className="text-gray-700 text-lg">Loading questions…</div>
      </div>
    )
  }

  if (error || !currentQuestion) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <div className="bg-white shadow rounded-lg px-6 py-4 max-w-lg text-center">
          <h1 className="text-lg font-semibold text-red-600 mb-2">
            Something went wrong
          </h1>
          <p className="text-gray-700">{error ?? 'No questions available.'}</p>
        </div>
      </div>
    )
  }

  const selectionForCurrent = selections[currentIndex]

  return (
    <div className="min-h-screen bg-gray-100">
      <header className="border-b border-gray-200 bg-white">
        <div className="max-w-5xl mx-auto px-4 py-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-xl font-semibold text-gray-900">
              Model Response Comparison
            </h1>
            <p className="text-sm text-gray-500">
              Anonymised answers from multiple models. Click the better answer.
            </p>
          </div>
          <div className="flex items-center gap-3 text-sm text-gray-600">
            {!adminMode && (
              <>
                <span className="hidden sm:inline">
                  Question {currentIndex + 1} of {questions.length}
                </span>
                <button
                  type="button"
                  onClick={handleNext}
                  disabled={currentIndex >= questions.length - 1}
                  className="inline-flex items-center rounded-lg border border-transparent bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm disabled:cursor-not-allowed disabled:bg-blue-300 hover:bg-blue-700"
                >
                  Next ⟶
                </button>
              </>
            )}
            <span className="text-xs text-gray-500 font-mono">{userId}</span>
            <button
              type="button"
              onClick={handleToggleAdmin}
              className="inline-flex items-center rounded-md border border-gray-300 px-2 py-1 text-xs font-medium text-gray-700 bg-white hover:bg-gray-50"
            >
              {adminMode ? 'Annotator view' : 'Admin view'}
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6">
        {adminMode ? (
          <div className="space-y-4">
            <div className="max-w-md space-y-2">
              <h2 className="text-lg font-semibold text-gray-900">
                Admin – Selections log
              </h2>
              <input
                type="password"
                value={adminTokenInput}
                onChange={(e) => setAdminTokenInput(e.target.value)}
                placeholder="Admin token"
                className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <button
                type="button"
                onClick={fetchLogs}
                className="mt-2 inline-flex items-center rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
              >
                Load logs
              </button>
              {logsLoading && (
                <p className="text-sm text-gray-500">Loading logs…</p>
              )}
              {logsError && (
                <p className="text-sm text-red-600">{logsError}</p>
              )}
            </div>

            {adminAuthorized && metrics && (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                <div className="bg-white rounded-lg border border-gray-200 p-4">
                  <div className="text-xs text-gray-500 mb-1">Total Selections</div>
                  <div className="text-2xl font-semibold text-gray-900">
                    {metrics.totalSelections}
                  </div>
                </div>
                <div className="bg-white rounded-lg border border-gray-200 p-4">
                  <div className="text-xs text-gray-500 mb-1">Unique Users</div>
                  <div className="text-2xl font-semibold text-gray-900">
                    {metrics.uniqueUsers}
                  </div>
                </div>
                <div className="bg-white rounded-lg border border-gray-200 p-4">
                  <div className="text-xs text-gray-500 mb-1">Last 24h</div>
                  <div className="text-2xl font-semibold text-gray-900">
                    {metrics.recent24h}
                  </div>
                </div>
                <div className="bg-white rounded-lg border border-gray-200 p-4">
                  <div className="text-xs text-gray-500 mb-1">Avg per User</div>
                  <div className="text-2xl font-semibold text-gray-900">
                    {metrics.avgSelectionsPerUser}
                  </div>
                </div>
                <div className="bg-white rounded-lg border border-gray-200 p-4">
                  <div className="text-xs text-gray-500 mb-1">Best Model Wins</div>
                  <div className="text-lg font-semibold text-gray-900">
                    {metrics.bestModelWins.length > 0 ? (
                      <>
                        {labelForModelIndex(metrics.bestModelWins[0].best_index)}
                        {modelMapping[
                          `model_${metrics.bestModelWins[0].best_index + 1}`
                        ] && (
                          <span className="text-xs text-gray-500 ml-1">
                            ({modelMapping[`model_${metrics.bestModelWins[0].best_index + 1}`]})
                          </span>
                        )}
                        <span className="text-xs text-gray-500 ml-1">
                          ({metrics.bestModelWins[0].count})
                        </span>
                      </>
                    ) : (
                      '-'
                    )}
                  </div>
                </div>
                <div className="bg-white rounded-lg border border-gray-200 p-4">
                  <div className="text-xs text-gray-500 mb-1">2nd Best Wins</div>
                  <div className="text-lg font-semibold text-gray-900">
                    {metrics.secondBestWins.length > 0 ? (
                      <>
                        {labelForModelIndex(metrics.secondBestWins[0].second_index)}
                        {modelMapping[
                          `model_${metrics.secondBestWins[0].second_index + 1}`
                        ] && (
                          <span className="text-xs text-gray-500 ml-1">
                            ({modelMapping[`model_${metrics.secondBestWins[0].second_index + 1}`]})
                          </span>
                        )}
                        <span className="text-xs text-gray-500 ml-1">
                          ({metrics.secondBestWins[0].count})
                        </span>
                      </>
                    ) : (
                      '-'
                    )}
                  </div>
                </div>
              </div>
            )}

            {adminAuthorized && (
              <>
                {Object.keys(modelMapping).length > 0 && (
                  <div className="rounded-lg border border-gray-200 bg-white p-3 text-xs text-gray-700 space-y-1">
                    <div className="font-semibold mb-1">
                      Model mapping (admin only)
                    </div>
                    <ul className="list-disc pl-4 space-y-0.5">
                      {Object.entries(modelMapping).map(
                        ([key, value]) => (
                          <li key={key}>
                            <span className="font-mono">{key}</span>{' '}
                            → <span>{value}</span>
                          </li>
                        ),
                      )}
                    </ul>
                  </div>
                )}

                <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-gray-900">
                      Filters
                    </h3>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => handleDownload('csv')}
                        className="inline-flex items-center rounded-md border border-gray-300 bg-white px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
                      >
                        Download CSV
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDownload('json')}
                        className="inline-flex items-center rounded-md border border-gray-300 bg-white px-2 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
                      >
                        Download JSON
                      </button>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    <div>
                      <label className="block text-xs text-gray-600 mb-1">
                        User ID (prefix)
                      </label>
                      <input
                        type="text"
                        value={filters.userId}
                        onChange={(e) =>
                          setFilters((prev) => ({
                            ...prev,
                            userId: e.target.value,
                          }))
                        }
                        placeholder="e.g., 91"
                        className="w-full rounded-md border border-gray-300 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-600 mb-1">
                        Session ID (prefix)
                      </label>
                      <input
                        type="text"
                        value={filters.sessionId}
                        onChange={(e) =>
                          setFilters((prev) => ({
                            ...prev,
                            sessionId: e.target.value,
                          }))
                        }
                        placeholder="e.g., abc123"
                        className="w-full rounded-md border border-gray-300 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-600 mb-1">
                        Question #
                      </label>
                      <input
                        type="number"
                        value={filters.questionIndex}
                        onChange={(e) =>
                          setFilters((prev) => ({
                            ...prev,
                            questionIndex: e.target.value,
                          }))
                        }
                        placeholder="e.g., 5"
                        className="w-full rounded-md border border-gray-300 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-600 mb-1">
                        Date From
                      </label>
                      <input
                        type="date"
                        value={filters.dateFrom}
                        onChange={(e) =>
                          setFilters((prev) => ({
                            ...prev,
                            dateFrom: e.target.value,
                          }))
                        }
                        className="w-full rounded-md border border-gray-300 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-600 mb-1">
                        Date To
                      </label>
                      <input
                        type="date"
                        value={filters.dateTo}
                        onChange={(e) =>
                          setFilters((prev) => ({
                            ...prev,
                            dateTo: e.target.value,
                          }))
                        }
                        className="w-full rounded-md border border-gray-300 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                    <div className="flex items-end">
                      <button
                        type="button"
                        onClick={fetchLogs}
                        className="w-full inline-flex items-center justify-center rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
                      >
                        Apply Filters
                      </button>
                    </div>
                  </div>
                </div>

                {logs.length > 0 && (
                  <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
                    <table className="min-w-full text-sm">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-3 py-2 text-left font-medium text-gray-700">
                            #
                          </th>
                          <th className="px-3 py-2 text-left font-medium text-gray-700">
                            Question
                          </th>
                          <th className="px-3 py-2 text-left font-medium text-gray-700">
                            Best / 2nd
                          </th>
                          <th className="px-3 py-2 text-left font-medium text-gray-700">
                            User ID
                          </th>
                          <th className="px-3 py-2 text-left font-medium text-gray-700">
                            Session ID
                          </th>
                          <th className="px-3 py-2 text-left font-medium text-gray-700">
                            Timestamp
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {logs
                          .slice()
                          .reverse()
                          .map((entry, idx) => {
                            const anySel: any = entry.selection as any
                            const bestIndex: number | undefined =
                              typeof anySel.bestIndex === 'number'
                                ? anySel.bestIndex
                                : typeof anySel.responseIndex === 'number'
                                  ? anySel.responseIndex
                                  : undefined
                            const secondIndex: number | null =
                              typeof anySel.secondIndex === 'number'
                                ? anySel.secondIndex
                                : null
                            const userId: string | undefined = anySel.userId
                            const sessionId: string | undefined =
                              anySel.sessionId

                            return (
                              <tr
                                key={`${entry.receivedAt}-${idx}`}
                                className={
                                  idx % 2 === 0 ? 'bg-white' : 'bg-gray-50'
                                }
                              >
                                <td className="px-3 py-2 align-top text-gray-700">
                                  {entry.selection.questionIndex + 1}
                                </td>
                                <td className="px-3 py-2 align-top text-gray-800 max-w-xs">
                                  <div className="text-xs text-gray-500">
                                    {entry.question.section}
                                  </div>
                                  <div className="text-sm">
                                    {entry.question.question}
                                  </div>
                                </td>
                                <td className="px-3 py-2 align-top text-gray-800 max-w-xs">
                                  <div className="text-xs text-gray-500 mb-1">
                                    {typeof bestIndex === 'number' && (
                                      <>
                                        Best:{' '}
                                        {labelForModelIndex(bestIndex)}
                                        {modelMapping[
                                          `model_${bestIndex + 1}`
                                        ] && (
                                          <>
                                            {' '}
                                            (
                                            {
                                              modelMapping[
                                                `model_${bestIndex + 1}`
                                              ]
                                            }
                                            )
                                          </>
                                        )}
                                      </>
                                    )}
                                    {typeof secondIndex === 'number' && (
                                      <>
                                        <span className="mx-1 text-gray-400">
                                          |
                                        </span>
                                        2nd:{' '}
                                        {labelForModelIndex(secondIndex)}
                                        {modelMapping[
                                          `model_${secondIndex + 1}`
                                        ] && (
                                          <>
                                            {' '}
                                            (
                                            {
                                              modelMapping[
                                                `model_${secondIndex + 1}`
                                              ]
                                            }
                                            )
                                          </>
                                        )}
                                      </>
                                    )}
                                  </div>
                                  <div className="text-xs whitespace-pre-line">
                                    {
                                      entry.question.responses[
                                        typeof bestIndex === 'number'
                                          ? bestIndex
                                          : 0
                                      ]
                                    }
                                  </div>
                                </td>
                                <td className="px-3 py-2 align-top text-xs text-gray-600 font-mono">
                                  {userId || '-'}
                                </td>
                                <td className="px-3 py-2 align-top text-xs text-gray-600 font-mono">
                                  {sessionId
                                    ? sessionId.slice(0, 8) + '...'
                                    : '-'}
                                </td>
                                <td className="px-3 py-2 align-top text-xs text-gray-600">
                                  {new Date(
                                    entry.receivedAt,
                                  ).toLocaleString()}
                                </td>
                              </tr>
                            )
                          })}
                      </tbody>
                    </table>
                  </div>
                )}

                {logs.length === 0 && !logsLoading && (
                  <p className="text-sm text-gray-600 p-4">
                    No selections match the current filters.
                  </p>
                )}
              </>
            )}
          </div>
        ) : (
        <>
        <div className="flex flex-col lg:flex-row gap-6">
          <aside className="w-full lg:w-64 lg:flex-none space-y-3 order-1 lg:order-2">
            <h3 className="text-sm font-semibold text-gray-800">
              Models (pick up to 2)
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-1 gap-2">
              {currentQuestion.responses.map((_, idx) => {
                const label = labelForModelIndex(idx)
                const selectedForCompare = activeCompareIndices.includes(idx)
                const isBest = selectionForCurrent?.bestIndex === idx
                const isSecond =
                  typeof selectionForCurrent?.secondIndex === 'number' &&
                  selectionForCurrent.secondIndex === idx

                return (
                  <div
                    key={idx}
                    className={[
                      'rounded-lg border px-2 py-2 text-xs space-y-1',
                      selectedForCompare
                        ? 'border-blue-500 bg-blue-50'
                        : 'border-gray-200 bg-white',
                    ].join(' ')}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-gray-800">
                        Model {label}
                      </span>
                      {isBest && (
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
                          Best
                        </span>
                      )}
                      {isSecond && !isBest && (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800">
                          2nd
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-1 mt-1">
                      <button
                        type="button"
                        onClick={() => toggleCompareModel(idx)}
                        className={[
                          'rounded-full border px-2 py-0.5 text-[11px]',
                          selectedForCompare
                            ? 'border-blue-500 bg-blue-100 text-blue-800'
                            : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50',
                        ].join(' ')}
                      >
                        {selectedForCompare ? 'Remove' : 'Compare'}
                      </button>
                      <button
                        type="button"
                        onClick={() => markBest(idx)}
                        className="rounded-full border border-emerald-500 bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-800 hover:bg-emerald-100"
                      >
                        Best
                      </button>
                      <button
                        type="button"
                        onClick={() => markSecondBest(idx)}
                        className="rounded-full border border-amber-400 bg-amber-50 px-2 py-0.5 text-[11px] text-amber-800 hover:bg-amber-100"
                      >
                        2nd best
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </aside>

          <div className="flex-1 order-2 lg:order-1">
            {currentQuestion.section && (
              <div className="mb-2 inline-flex items-center rounded-full bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700">
                {currentQuestion.section}
              </div>
            )}

            <h2 className="text-lg sm:text-xl font-semibold text-gray-900 mb-4">
              {currentQuestion.question}
            </h2>

            <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
              <div className="text-xs sm:text-sm text-gray-500">
                Use the panel on the right to pick up to two models to compare.
              </div>
              {selectionForCurrent && (
                <div className="inline-flex items-center rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700 gap-1">
                  <span>
                    Best: {labelForModelIndex(selectionForCurrent.bestIndex)}
                  </span>
                  {typeof selectionForCurrent.secondIndex === 'number' && (
                    <>
                      <span className="mx-1 text-emerald-400">|</span>
                      <span>
                        2nd:{' '}
                        {labelForModelIndex(
                          selectionForCurrent.secondIndex,
                        )}
                      </span>
                    </>
                  )}
                </div>
              )}
            </div>

            {activeCompareIndices.length === 0 ? (
              <p className="text-sm text-gray-600">
                Select at least one model from the panel on the right to start
                comparing.
              </p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
                {activeCompareIndices.map((idx) => {
                  const response = currentQuestion.responses[idx]
                  const isBest = selectionForCurrent?.bestIndex === idx
                  const isSecond =
                    typeof selectionForCurrent?.secondIndex === 'number' &&
                    selectionForCurrent.secondIndex === idx

                  return (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => handleSelect(idx)}
                      className={[
                        'text-left rounded-xl border bg-white px-4 py-4 shadow-sm transition overflow-hidden',
                        'hover:-translate-y-0.5 hover:shadow-md flex flex-col h-full',
                        isBest
                          ? 'border-emerald-500 ring-2 ring-emerald-200'
                          : isSecond
                            ? 'border-amber-400 ring-2 ring-amber-200'
                            : 'border-gray-200 hover:border-blue-300',
                      ].join(' ')}
                    >
                      <div className="flex items-start justify-between gap-2 flex-none">
                        <span className="inline-flex h-7 w-7 flex-none items-center justify-center rounded-full bg-gray-100 text-xs font-semibold text-gray-700">
                          {labelForModelIndex(idx)}
                        </span>
                        {isBest && (
                          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                            Best
                          </span>
                        )}
                        {isSecond && !isBest && (
                          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">
                            2nd
                          </span>
                        )}
                      </div>
                      <ReactMarkdown className="mt-3 text-gray-800 text-sm whitespace-pre-line leading-relaxed text-left flex-grow">
                        {response}
                      </ReactMarkdown>
                    </button>
                  )
                })}
              </div>
            )}

            <div className="flex items-center justify-between gap-4">
              <button
                type="button"
                onClick={handlePrev}
                disabled={currentIndex === 0}
                className="inline-flex items-center rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 shadow-sm disabled:cursor-not-allowed disabled:opacity-50 hover:bg-gray-50"
              >
                ⟵ Previous
              </button>
              <button
                type="button"
                onClick={handleNext}
                disabled={currentIndex >= questions.length - 1}
                className="inline-flex items-center rounded-lg border border-transparent bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm disabled:cursor-not-allowed disabled:bg-blue-300 hover:bg-blue-700"
              >
                Next ⟶
              </button>
            </div>
          </div>
        </div>
        </>
        )}
      </main>
    </div>
  )
}

export default App


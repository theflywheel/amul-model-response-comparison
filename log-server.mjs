import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import Database from 'better-sqlite3'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const PORT = Number(process.env.PORT || 4000)
const DATA_DIR = path.join(__dirname, 'data')
const DB_FILE = path.join(DATA_DIR, 'selections.db')
const MODEL_MAPPING_FILE = path.join(__dirname, 'model-mapping.json')
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ''

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
}

// Initialize SQLite database
let db
try {
  db = new Database(DB_FILE)
  db.pragma('journal_mode = WAL')
} catch (err) {
  console.error(`Failed to open database at ${DB_FILE}:`, err)
  console.error('Make sure the directory is writable and the volume is mounted correctly.')
  process.exit(1)
}

// Create table if it doesn't exist
db.exec(`
  CREATE TABLE IF NOT EXISTS selections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    user_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    question_index INTEGER NOT NULL,
    best_index INTEGER NOT NULL,
    second_index INTEGER,
    question_id TEXT,
    section TEXT,
    question TEXT,
    responses TEXT NOT NULL,
    received_at TEXT NOT NULL
  )
`)

const insertStmt = db.prepare(`
  INSERT INTO selections (
    timestamp, user_id, session_id, question_index, best_index, second_index,
    question_id, section, question, responses, received_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`)

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.end(JSON.stringify(payload))
}

function handleCors(req, res) {
  res.statusCode = 204
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Token')
  res.end()
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    handleCors(req, res)
    return
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)

  if (req.method === 'POST' && req.url === '/api/log-selection') {
    let body = ''

    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 1e6) {
        req.socket.destroy()
      }
    })

    req.on('end', () => {
      try {
        const parsed = JSON.parse(body)
        const { selection, question } = parsed

        if (!selection || !question) {
          sendJson(res, 400, { error: 'Missing selection or question' })
          return
        }

        const receivedAt = new Date().toISOString()

        insertStmt.run(
          selection.timestamp || receivedAt,
          selection.userId || '',
          selection.sessionId || '',
          selection.questionIndex ?? 0,
          selection.bestIndex ?? 0,
          typeof selection.secondIndex === 'number'
            ? selection.secondIndex
            : null,
          question.id || null,
          question.section || null,
          question.question || null,
          JSON.stringify(question.responses || []),
          receivedAt,
        )

        sendJson(res, 204, {})
      } catch (err) {
        console.error('Failed to parse or save selection:', err)
        sendJson(res, 500, { error: 'Failed to save selection' })
      }
    })

    return
  }

  if (req.method === 'GET' && url.pathname === '/api/log-selection') {
    const token = req.headers['x-admin-token']
    if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
      sendJson(res, 401, { error: 'Unauthorized' })
      return
    }

    try {
      const limit = Number(url.searchParams.get('limit') || 200)
      const userIdPrefix = url.searchParams.get('userId') || ''
      const sessionIdPrefix = url.searchParams.get('sessionId') || ''
      const questionIndexPrefix = url.searchParams.get('questionIndex') || ''
      const dateFrom = url.searchParams.get('dateFrom') || ''
      const dateTo = url.searchParams.get('dateTo') || ''

      let query = 'SELECT * FROM selections WHERE 1=1'
      const params = []

      if (userIdPrefix) {
        query += ' AND user_id LIKE ?'
        params.push(`${userIdPrefix}%`)
      }
      if (sessionIdPrefix) {
        query += ' AND session_id LIKE ?'
        params.push(`${sessionIdPrefix}%`)
      }
      if (questionIndexPrefix) {
        const qIdx = Number(questionIndexPrefix)
        if (!isNaN(qIdx)) {
          query += ' AND question_index = ?'
          params.push(qIdx)
        }
      }
      if (dateFrom) {
        query += ' AND DATE(received_at) >= ?'
        params.push(dateFrom)
      }
      if (dateTo) {
        query += ' AND DATE(received_at) <= ?'
        params.push(dateTo)
      }

      query += ' ORDER BY received_at DESC LIMIT ?'
      params.push(limit)

      const rows = db.prepare(query).all(...params)

      const entries = rows.map((row) => ({
        selection: {
          questionIndex: row.question_index,
          bestIndex: row.best_index,
          secondIndex: row.second_index,
          timestamp: row.timestamp,
          sessionId: row.session_id,
          userId: row.user_id,
        },
        question: {
          id: row.question_id,
          section: row.section,
          question: row.question,
          responses: JSON.parse(row.responses),
        },
        receivedAt: row.received_at,
      }))

      sendJson(res, 200, { entries })
    } catch (err) {
      console.error('Failed to read selections:', err)
      sendJson(res, 500, { error: 'Failed to read selections' })
    }

    return
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/metrics') {
    const token = req.headers['x-admin-token']
    if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
      sendJson(res, 401, { error: 'Unauthorized' })
      return
    }

    try {
      const totalSelections = db
        .prepare('SELECT COUNT(*) as count FROM selections')
        .get().count

      const uniqueUsers = db
        .prepare('SELECT COUNT(DISTINCT user_id) as count FROM selections')
        .get().count

      const recent24h = db
        .prepare(
          `SELECT COUNT(*) as count FROM selections 
           WHERE received_at >= datetime('now', '-24 hours')`,
        )
        .get().count

      const bestModelWins = db
        .prepare(
          `SELECT best_index, COUNT(*) as count 
           FROM selections 
           GROUP BY best_index 
           ORDER BY count DESC`,
        )
        .all()

      const secondBestWins = db
        .prepare(
          `SELECT second_index, COUNT(*) as count 
           FROM selections 
           WHERE second_index IS NOT NULL
           GROUP BY second_index 
           ORDER BY count DESC`,
        )
        .all()

      const avgSelectionsPerUser =
        uniqueUsers > 0 ? (totalSelections / uniqueUsers).toFixed(1) : '0'

      sendJson(res, 200, {
        totalSelections,
        uniqueUsers,
        recent24h,
        bestModelWins,
        secondBestWins,
        avgSelectionsPerUser,
      })
    } catch (err) {
      console.error('Failed to compute metrics:', err)
      sendJson(res, 500, { error: 'Failed to compute metrics' })
    }

    return
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/export') {
    const token = req.headers['x-admin-token']
    if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
      sendJson(res, 401, { error: 'Unauthorized' })
      return
    }

    try {
      const format = url.searchParams.get('format') || 'json'
      const userIdPrefix = url.searchParams.get('userId') || ''
      const sessionIdPrefix = url.searchParams.get('sessionId') || ''
      const questionIndexPrefix = url.searchParams.get('questionIndex') || ''
      const dateFrom = url.searchParams.get('dateFrom') || ''
      const dateTo = url.searchParams.get('dateTo') || ''

      let query = 'SELECT * FROM selections WHERE 1=1'
      const params = []

      if (userIdPrefix) {
        query += ' AND user_id LIKE ?'
        params.push(`${userIdPrefix}%`)
      }
      if (sessionIdPrefix) {
        query += ' AND session_id LIKE ?'
        params.push(`${sessionIdPrefix}%`)
      }
      if (questionIndexPrefix) {
        const qIdx = Number(questionIndexPrefix)
        if (!isNaN(qIdx)) {
          query += ' AND question_index = ?'
          params.push(qIdx)
        }
      }
      if (dateFrom) {
        query += ' AND DATE(received_at) >= ?'
        params.push(dateFrom)
      }
      if (dateTo) {
        query += ' AND DATE(received_at) <= ?'
        params.push(dateTo)
      }

      query += ' ORDER BY received_at DESC'

      const rows = db.prepare(query).all(...params)

      if (format === 'csv') {
        const csvRows = [
          [
            'timestamp',
            'user_id',
            'session_id',
            'question_index',
            'best_index',
            'second_index',
            'question_id',
            'section',
            'question',
            'received_at',
          ].join(','),
        ]

        for (const row of rows) {
          csvRows.push(
            [
              `"${(row.timestamp || '').replace(/"/g, '""')}"`,
              `"${(row.user_id || '').replace(/"/g, '""')}"`,
              `"${(row.session_id || '').replace(/"/g, '""')}"`,
              row.question_index ?? '',
              row.best_index ?? '',
              row.second_index ?? '',
              `"${(row.question_id || '').replace(/"/g, '""')}"`,
              `"${(row.section || '').replace(/"/g, '""')}"`,
              `"${(row.question || '').replace(/"/g, '""')}"`,
              `"${(row.received_at || '').replace(/"/g, '""')}"`,
            ].join(','),
          )
        }

        res.statusCode = 200
        res.setHeader('Content-Type', 'text/csv')
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="selections-${Date.now()}.csv"`,
        )
        res.end(csvRows.join('\n'))
      } else {
        const entries = rows.map((row) => ({
          timestamp: row.timestamp,
          userId: row.user_id,
          sessionId: row.session_id,
          questionIndex: row.question_index,
          bestIndex: row.best_index,
          secondIndex: row.second_index,
          questionId: row.question_id,
          section: row.section,
          question: row.question,
          responses: JSON.parse(row.responses),
          receivedAt: row.received_at,
        }))

        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json')
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="selections-${Date.now()}.json"`,
        )
        res.end(JSON.stringify(entries, null, 2))
      }
    } catch (err) {
      console.error('Failed to export data:', err)
      sendJson(res, 500, { error: 'Failed to export data' })
    }

    return
  }

  if (req.method === 'GET' && url.pathname === '/api/model-mapping') {
    const token = req.headers['x-admin-token']
    if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
      sendJson(res, 401, { error: 'Unauthorized' })
      return
    }

    fs.readFile(MODEL_MAPPING_FILE, 'utf8', (err, data) => {
      if (err) {
        if (err.code === 'ENOENT') {
          sendJson(res, 200, { mapping: {} })
          return
        }
        console.error('Failed to read model mapping file:', err)
        sendJson(res, 500, { error: 'Failed to read model mapping file' })
        return
      }

      try {
        const parsed = JSON.parse(data)
        sendJson(res, 200, { mapping: parsed })
      } catch (e) {
        console.error('Failed to parse model mapping file:', e)
        sendJson(res, 500, { error: 'Invalid model mapping JSON' })
      }
    })

    return
  }

  sendJson(res, 404, { error: 'Not found' })
})

server.listen(PORT, () => {
  console.log(`Selection log server listening on http://localhost:${PORT}`)
  console.log(`Database: ${DB_FILE}`)
})

process.on('SIGINT', () => {
  db.close()
  process.exit(0)
})

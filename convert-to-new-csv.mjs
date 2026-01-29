import fs from 'fs'
import path from 'path'
import Papa from 'papaparse'

const inputPath =
  process.argv[2] ||
  path.join(process.cwd(), 'OAN Projects - Model Responses.csv')
const outputPath =
  process.argv[3] ||
  path.join(
    path.dirname(inputPath),
    path.basename(inputPath, '.csv') + '.normalized.csv',
  )

if (!fs.existsSync(inputPath)) {
  console.error(`Input CSV not found: ${inputPath}`)
  process.exit(1)
}

const csv = fs.readFileSync(inputPath, 'utf8')

const parsed = Papa.parse(csv, {
  header: true,
  skipEmptyLines: 'greedy',
})

const fields = parsed.meta.fields ?? []
if (fields.length < 3) {
  console.error('Input CSV does not look like the original format.')
  process.exit(1)
}

// Original assumption:
// - col 0: section
// - col 1: question
// - remaining non-time columns: model responses
const sectionField = fields[0]
const questionField = fields[1]
const answerFields = fields.filter((name, index) => {
  if (index < 2) return false
  const lower = name.toLowerCase()
  return !lower.includes('time')
})

if (answerFields.length < 2) {
  console.error(
    'Expected at least two answer columns after section+question in the original CSV.',
  )
  process.exit(1)
}

// New schema:
// question_id,section,question,model_1,model_2,...
const modelHeaders = answerFields.map((_, idx) => `model_${idx + 1}`)

const rows = []
let rowIndex = 1

for (const row of parsed.data) {
  const section = (row[sectionField] ?? '').toString().trim()
  const question = (row[questionField] ?? '').toString().trim()
  const responses = answerFields.map((field) =>
    (row[field] ?? '').toString().replace(/^[\s\n\r]+|[\s\n\r]+$/g, ''),
  )

  const nonEmpty = responses.filter((r) => r.length > 0)
  if (!question || nonEmpty.length === 0) {
    rowIndex += 1
    continue
  }

  const outRow = {
    question_id: `Q${rowIndex}`,
    section,
    question,
  }

  responses.forEach((value, idx) => {
    outRow[modelHeaders[idx]] = value
  })

  rows.push(outRow)
  rowIndex += 1
}

if (rows.length === 0) {
  console.error('No usable rows found in input CSV.')
  process.exit(1)
}

const outCsv = Papa.unparse({
  fields: ['question_id', 'section', 'question', ...modelHeaders],
  data: rows.map((row) =>
    ['question_id', 'section', 'question', ...modelHeaders].map(
      (key) => row[key] ?? '',
    ),
  ),
})

fs.writeFileSync(outputPath, outCsv, 'utf8')

console.log(
  `Wrote normalized CSV to ${outputPath} with ${rows.length} questions and ${modelHeaders.length} model columns.`,
)


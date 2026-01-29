import fs from 'fs'
import path from 'path'
import Papa from 'papaparse'

const targetPath =
  process.argv[2] ||
  path.join(process.cwd(), 'OAN Projects - Model Responses.csv')

if (!fs.existsSync(targetPath)) {
  console.error(`CSV file not found: ${targetPath}`)
  process.exit(1)
}

const csv = fs.readFileSync(targetPath, 'utf8')
const result = Papa.parse(csv, {
  header: true,
  skipEmptyLines: 'greedy',
})

const fields = result.meta.fields ?? []
const lowerFields = fields.map((f) => f.toLowerCase())

const questionIdField =
  fields[lowerFields.indexOf('question_id')] ?? undefined
const sectionField = fields[lowerFields.indexOf('section')] ?? undefined
const questionField = fields[lowerFields.indexOf('question')] ?? undefined
const modelFields = fields.filter((name) =>
  /^model_/i.test(name.toLowerCase()),
)

const errors = []

if (!questionIdField) {
  errors.push('Missing required column: question_id')
}
if (!questionField) {
  errors.push('Missing required column: question')
}
if (modelFields.length < 2) {
  errors.push('Expected at least two model_* columns for responses')
}

if (errors.length > 0) {
  console.error('Schema errors:')
  for (const e of errors) console.error(`- ${e}`)
  process.exit(1)
}

const seenIds = new Set()
let rowIndex = 1

for (const row of result.data) {
  const idRaw = (questionIdField && row[questionIdField]) || ''
  const id = idRaw.toString().trim()
  const question = (questionField && row[questionField])?.toString().trim()

  if (!id) {
    errors.push(`Row ${rowIndex}: missing question_id`)
  } else if (seenIds.has(id)) {
    errors.push(`Row ${rowIndex}: duplicate question_id "${id}"`)
  } else {
    seenIds.add(id)
  }

  if (!question) {
    errors.push(`Row ${rowIndex}: empty question`)
  }

  const nonEmptyModels = modelFields
    .map((field) => (row[field] ?? '').toString().trim())
    .filter((v) => v.length > 0)

  if (nonEmptyModels.length < 2) {
    errors.push(
      `Row ${rowIndex}: expected at least 2 non-empty model_* responses`,
    )
  }

  rowIndex += 1
}

if (errors.length > 0) {
  console.error('Validation failed:')
  for (const e of errors) console.error(`- ${e}`)
  process.exit(1)
}

console.log(
  `CSV at ${targetPath} looks good. Rows: ${result.data.length}, models: ${modelFields.join(
    ', ',
  )}`,
)


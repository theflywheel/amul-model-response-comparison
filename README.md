## Model response comparison UI

Simple Vite + React UI to compare anonymised model responses from the CSV
`OAN Projects - Model Responses.csv`, with a tiny Node logger and an admin view
to inspect selections.

### Prerequisites

- Node 20+ (for local, non‑Docker usage)
- Docker + Docker Compose (for the containerised setup)

### Local (without Docker)

1. Install dependencies:

```bash
cd model-response-comparison
npm install
```

2. Start the logger:

```bash
ADMIN_TOKEN=changeme \
node log-server.mjs
```

3. In another terminal, start the Vite dev server:

```bash
VITE_LOGGER_URL=http://localhost:4000 \
VITE_ADMIN_TOKEN=changeme \
npm run dev
```

4. Open `http://localhost:5173` in a browser.

- Annotator view lets you step through questions and pick the better response.
- Selections are appended as JSONL lines to `selection-log.jsonl`.

To see the admin view, click **“Admin view”** in the header, enter the admin
token (must match `ADMIN_TOKEN` used for the logger), and press **“Load logs”**.

### Docker / Docker Compose

From `model-response-comparison`:

```bash
docker compose up --build
```

Environment:

- `ADMIN_TOKEN` – secret used by the logger to protect the admin endpoint.
  - If you do nothing, it defaults to `changeme` (not recommended).
  - Set it when running compose:

    ```bash
    ADMIN_TOKEN="some-long-secret" docker compose up --build
    ```

What this starts:

- **frontend** – Vite dev server on `http://localhost:5173`
  - Talks to the logger at `http://logger:4000` via `VITE_LOGGER_URL`
- **logger** – Node HTTP server on `http://localhost:4000`
  - Writes selections to `selection-log.jsonl` (bound as a volume)
  - Exposes:
    - `POST /api/log-selection` – append a new selection
    - `GET /api/log-selection` – admin‑only; returns last ~200 entries

### Admin endpoint protection

- Logger side:
  - Reads `ADMIN_TOKEN` from the environment.
  - `GET /api/log-selection` requires header `X-Admin-Token: <ADMIN_TOKEN>`.
- Frontend side:
  - Reads `VITE_ADMIN_TOKEN` from the environment (set to the same value).
  - Admin view sends the token in the `X-Admin-Token` header when fetching logs.

### Log file format

- File: `selection-log.jsonl` (JSON Lines)
- Each line is a JSON object:

```json
{
  "selection": {
    "questionIndex": 0,
    "responseIndex": 1,
    "timestamp": "2026-01-27T09:30:00.000Z"
  },
  "question": {
    "section": "…",
    "question": "…",
    "responses": ["…", "…", "…"]
  },
  "receivedAt": "2026-01-27T09:30:01.234Z"
}
```

You can process this file later with any JSONL‑friendly tooling or a simple
Python/Node script.

### CSV format and validator

The UI reads from a CSV (by default `OAN Projects - Model Responses.csv`).

**Recommended schema (new format):**

```csv
question_id,section,question,model_a,model_b,model_c
Q1,Some section,What is the question?,Answer from model A,Answer from model B,Answer from model C
```

- `question_id` – required, unique per row.
- `section` – optional grouping label.
- `question` – required text of the question.
- `model_*` – one or more columns prefixed with `model_` (at least 2).

The app:

- Detects this schema automatically (by the presence of `question_id` and
  `model_*` columns).
- Falls back to the older format (first column = section, second = question,
  remaining non‑time columns = responses) if the new schema is not present.

To validate that your CSV follows the **new** schema:

```bash
npm run validate:csv              # validates default CSV
npm run validate:csv -- path/to/your.csv
```

The validator checks:

- Required columns: `question_id`, `question`, and ≥ 2 `model_*` columns.
- `question_id` is non‑empty and unique.
- Each row has at least 2 non‑empty model responses.



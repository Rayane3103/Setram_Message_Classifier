# Pinecone RAG Setup

This project uses Pinecone integrated embedding, so Pinecone converts the `chunk_text`
field into vectors during upload. The export script keeps the historical answer in
metadata so the frontend/API can retrieve it later.

## 1. Prepare the local export

```bash
npm run rag:prepare
```

Outputs are generated under `data/pinecone/`:

- `client-response-records.csv`: readable export with `description` and `response`
- `client-response-records.ndjson`: Pinecone upsert format
- `client-response-records.preview.json`: first records for manual inspection
- `manifest.json`: source, counts, field map, and generation details

The generated data files are ignored by git because they contain customer-response
history. Keep them local unless you intentionally decide to store them elsewhere.

## 2. Configure Pinecone

Create `.env.local` or set these environment variables:

```bash
PINECONE_API_KEY=your-pinecone-key
PINECONE_INDEX_NAME=setram-client-responses
PINECONE_NAMESPACE=setram-client-responses
PINECONE_CLOUD=aws
PINECONE_REGION=us-east-1
PINECONE_EMBED_MODEL=multilingual-e5-large
```

Optional variables:

```bash
PINECONE_INDEX_HOST=your-index-host
PINECONE_BATCH_SIZE=96
PINECONE_BATCH_DELAY_MS=250
PINECONE_CREATE_INDEX=true
```

If `PINECONE_INDEX_HOST` is not provided, the upload script tries to describe
`PINECONE_INDEX_NAME`; if it does not exist, it creates a dense integrated
embedding index with `field_map: { text: "chunk_text" }`.

## 3. Dry run

```bash
npm run rag:upload:dry-run
```

This validates the NDJSON file and prints sample records without sending data to
Pinecone.

## 4. Upload

```bash
npm run rag:upload
```

The script upserts records in batches of up to 96 because Pinecone limits text
upsert batches for integrated embedding.

## 5. Render runtime environment

After the upload is complete, Render does not need the CSV or NDJSON files. The
deployed app queries Pinecone directly from `/api/suggest-response`.

Set these environment variables in Render:

```bash
PINECONE_API_KEY=your-pinecone-key
PINECONE_INDEX_NAME=setram-client-responses
PINECONE_NAMESPACE=setram-client-responses
```

Recommended:

```bash
PINECONE_INDEX_HOST=your-index-host-from-pinecone
```

`PINECONE_INDEX_HOST` is optional because the app can discover the host from
`PINECONE_INDEX_NAME`, but setting it makes the first RAG request faster and
avoids an extra Pinecone control-plane lookup.

Do not create `NEXT_PUBLIC_PINECONE_API_KEY`; the Pinecone key must stay server
side only.

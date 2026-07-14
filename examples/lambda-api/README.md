# Lambda API Example

A minimal Lambda handler with two endpoints:

- **POST /ingest** — store document segments and rebuild the BM25 keyword index
- **POST /search** — hybrid search (BM25 keyword + vector, fused with RRF)

## Setup

1. Create a DynamoDB table (on-demand billing):

```bash
aws dynamodb create-table \
  --table-name rag-table \
  --attribute-definitions AttributeName=PK,AttributeType=S AttributeName=SK,AttributeType=S \
  --key-schema AttributeName=PK,KeyType=HASH AttributeName=SK,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST
```

2. Set the `TABLE_NAME` environment variable on your Lambda.

3. Wire your own vector search inside `handler.ts` (search for `TODO`).

## Usage

### Ingest a document

```bash
curl -X POST https://your-api/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "namespace": "my-project",
    "docId": "doc-001",
    "docName": "architecture.md",
    "segments": [
      { "text": "AuthService uses JWT for stateless authentication.", "page": 1 },
      { "text": "Rate limiting is enforced at the API Gateway level.", "page": 2 },
      { "text": "Sessions expire after 24 hours of inactivity.", "page": 3 }
    ]
  }'
```

### Search

```bash
curl -X POST https://your-api/search \
  -H "Content-Type: application/json" \
  -d '{
    "namespace": "my-project",
    "query": "how long do sessions last?",
    "limit": 3
  }'
```

Response:

```json
{
  "results": [
    {
      "text": "Sessions expire after 24 hours of inactivity.",
      "docName": "architecture.md",
      "page": 3,
      "score": 0.032,
      "strategies": 1
    }
  ]
}
```

## Deploying

This is just a handler file — deploy it however you deploy Lambdas:

- **CDK**: `new NodejsFunction(this, 'Search', { entry: 'handler.ts' })`
- **SAM**: point `CodeUri` at this folder
- **Serverless Framework**: standard TypeScript handler
- **Function URL**: enable in Lambda console for instant HTTPS endpoint

No framework lock-in.

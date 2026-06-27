# Milvus Local Stack for MCode RAG

Milvus **2.4+** standalone stack for Phase 7 hybrid indexing (Dense HNSW + Sparse + RRF).

## Quick Start

```powershell
cd milvus
docker compose up -d
```

Default gRPC endpoint: **`localhost:19530`**

Verify:

```powershell
docker compose ps
```

## MCode Settings

1. Open **Settings → Index Settings**
2. Select **Milvus (Vector Database)**
3. Set address to `localhost:19530`
4. Click **Test Connection**
5. Optional: enable **Dual-write** to keep a local disk index copy
6. Click **Save & Apply Settings** (full index build)

## Architecture

| Component | Role |
| :--- | :--- |
| `etcd` | Metadata store |
| `minio` | Object storage |
| `standalone` | Milvus 2.4 server |

Collection per workspace: `mcode_hybrid_{workspaceId}`

Partitions:

- `code_partition` — `code_chunk`
- `git_partition` — `git_commit`
- `doc_partition` — `doc_chunk`

## Troubleshooting

| Issue | Fix |
| :--- | :--- |
| `ECONNREFUSED 127.0.0.1:19530` | Run `docker compose up -d` and wait ~30s |
| Index rebuild after upgrade | manifest v4 + backend switch triggers rebuild |
| Reset data | `docker compose down` then delete `milvus/volumes/` |

## Implementation

- Adapter: `src/vs/workbench/contrib/mcode/electron-main/rag/milvusStore.ts`
- Hybrid query: Dense + Sparse with `RRFRanker(60)`

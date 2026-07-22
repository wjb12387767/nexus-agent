# LightRAG MCP Bridge

A thin stdio MCP server that wraps the [LightRAG](https://github.com/HKUDS/LightRAG)
engine, exposing knowledge-graph RAG capabilities (entity extraction, 5 retrieval
modes, persistent storage) to MCP-compatible clients like Nexus Agent.

## Why this exists

Nexus Agent integrates LightRAG as one of 4 optional MCP servers (alongside
Playwright, Docling, and Qdrant). LightRAG does not ship an official MCP server,
so this bridge fills the gap. It is intentionally minimal — 4 tools, stdio
transport, no HTTP server.

## Tools exposed

| Tool | Description |
|---|---|
| `lightrag_insert` | Ingest text into the knowledge graph (chunk + entity/relation extraction + vector index) |
| `lightrag_query` | Query with 5 modes: `naive` / `local` / `global` / `hybrid` / `mix` |
| `lightrag_list_docs` | List all ingested document IDs |
| `lightrag_stats` | Show storage statistics (file sizes, document count) |

## Configuration (environment variables)

| Variable | Default | Description |
|---|---|---|
| `LIGHTRAG_WORKING_DIR` | `~/.nexus/lightrag` | Where LightRAG persists its graph + vectors |
| `LLM_API_BASE` | `http://127.0.0.1:18317/v1` | OpenAI-compatible LLM endpoint |
| `LLM_API_KEY` | (none) | API key for the LLM endpoint |
| `LLM_MODEL` | `grok-4.5` | Model name for entity extraction / summarization |
| `EMBEDDING_MODEL` | `sentence-transformers/all-MiniLM-L6-v2` | HuggingFace embedding model |

## Usage

### Standalone (outside Docker)

```sh
pip install -r requirements.txt
python server.py
```

The server speaks MCP over stdio (JSON-RPC 2.0). It is launched by the MCP
client as a subprocess — not a standalone HTTP server.

### Inside docker-compose

The [docker-compose.yml](../../docker-compose.yml) `lightrag` service mounts
this directory read-only into `/srv/lightrag` and runs:

```sh
pip install --quiet --no-cache-dir mcp lightrag-hku httpx
python /srv/lightrag/server.py
```

The working dir is `/data/lightrag` (mounted volume), and the LLM endpoint
points to the host's relay via `host.docker.internal`.

## How it works

```
MCP client (Nexus)
    │  stdio (JSON-RPC 2.0)
    ▼
server.py (this file)
    │  Python import
    ▼
LightRAG engine
    │  HTTP calls
    ▼
LLM endpoint (LLM_API_BASE)
    +
HuggingFace embeddings (EMBEDDING_MODEL)
    │
    ▼
Persistent storage (LIGHTRAG_WORKING_DIR)
    ├── graph_chunk_entity_relation.graphml
    ├── kv_store_doc_status.json
    ├── kv_store_full_docs.json
    └── vector_db.sqlite
```

The bridge lazy-initializes the LightRAG instance on the first tool call, then
reuses it for all subsequent calls.

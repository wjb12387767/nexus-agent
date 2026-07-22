"""
LightRAG MCP Bridge — exposes LightRAG's knowledge-graph RAG capabilities
to MCP-compatible clients (like Nexus Agent).

This is a thin stdio MCP server that wraps the LightRAG engine. It exposes 4 tools:
  - lightrag_insert:    ingest text into the knowledge graph
  - lightrag_query:     retrieve with 5 modes (naive/local/global/hybrid/mix)
  - lightrag_list_docs: list all ingested document IDs
  - lightrag_stats:     show storage statistics

Configuration is via environment variables:
  LIGHTRAG_WORKING_DIR  (default: ~/.nexus/lightrag)
  LLM_API_BASE          OpenAI-compatible endpoint (e.g. http://localhost:18317/v1)
  LLM_API_KEY           API key for the LLM endpoint
  LLM_MODEL             model name (e.g. grok-4.5)
  EMBEDDING_MODEL       (optional) HuggingFace embedding model name.
                        Defaults to sentence-transformers/all-MiniLM-L6-v2.

Usage:
  python server.py

  The server speaks MCP over stdio (JSON-RPC 2.0). It is launched by the
  MCP client (e.g. Nexus Agent) as a subprocess — not a standalone HTTP server.

  When used inside docker-compose, the working dir is /data/lightrag (mounted
  volume), and the LLM endpoint points to the host's relay via
  host.docker.internal.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Lazy imports — installed by docker-compose on first start. We defer them so
# the module loads even when mcp / lightrag-hku are not yet pip-installed, and
# surface a clear error only when the MCP handshake actually starts.
# ---------------------------------------------------------------------------

_mcp_module = None
_lightrag_module = None


def _load_mcp() -> Any:
    global _mcp_module
    if _mcp_module is None:
        try:
            from mcp.server import Server
            from mcp.server.stdio import stdio_server
            from mcp.types import TextContent, Tool

            _mcp_module = {
                "Server": Server,
                "stdio_server": stdio_server,
                "TextContent": TextContent,
                "Tool": Tool,
            }
        except ImportError as e:
            sys.stderr.write(
                "[lightrag-mcp-bridge] FATAL: mcp package not installed. "
                "Run `pip install mcp lightrag-hku httpx`.\n"
                f"Original error: {e}\n"
            )
            sys.exit(1)
    return _mcp_module


def _load_lightrag() -> Any:
    global _lightrag_module
    if _lightrag_module is None:
        try:
            from lightrag import LightRAG, QueryParam

            _lightrag_module = {"LightRAG": LightRAG, "QueryParam": QueryParam}
        except ImportError as e:
            sys.stderr.write(
                "[lightrag-mcp-bridge] FATAL: lightrag-hku not installed. "
                "Run `pip install lightrag-hku`.\n"
                f"Original error: {e}\n"
            )
            sys.exit(1)
    return _lightrag_module


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------


def _config() -> dict[str, str]:
    working_dir = os.environ.get(
        "LIGHTRAG_WORKING_DIR",
        str(Path.home() / ".nexus" / "lightrag"),
    )
    Path(working_dir).mkdir(parents=True, exist_ok=True)

    return {
        "working_dir": working_dir,
        "llm_api_base": os.environ.get("LLM_API_BASE", "http://127.0.0.1:18317/v1"),
        "llm_api_key": os.environ.get("LLM_API_KEY", ""),
        "llm_model": os.environ.get("LLM_MODEL", "grok-4.5"),
        "embedding_model": os.environ.get(
            "EMBEDDING_MODEL",
            "sentence-transformers/all-MiniLM-L6-v2",
        ),
    }


# ---------------------------------------------------------------------------
# LightRAG instance (lazy init on first tool call, reused thereafter)
# ---------------------------------------------------------------------------

_rag: Any = None
_rag_lock = asyncio.Lock()


async def _get_rag() -> Any:
    global _rag
    if _rag is not None:
        return _rag

    async with _rag_lock:
        if _rag is not None:  # double-check after acquiring lock
            return _rag

        cfg = _config()
        lightrag_mod = _load_lightrag()
        LightRAG = lightrag_mod["LightRAG"]

        sys.stderr.write(
            f"[lightrag-mcp-bridge] initializing LightRAG "
            f"(working_dir={cfg['working_dir']}, "
            f"llm={cfg['llm_model']} @ {cfg['llm_api_base']})\n"
        )

        # LightRAG supports an OpenAI-compatible binding. We pass the API
        # base/key/model via environment variables that LightRAG reads, and
        # also explicitly via kwargs where supported.
        os.environ["OPENAI_API_BASE"] = cfg["llm_api_base"]
        os.environ["OPENAI_API_KEY"] = cfg["llm_api_key"]

        _rag = LightRAG(
            working_dir=cfg["working_dir"],
            enable_llm_cache=True,
        )

        sys.stderr.write("[lightrag-mcp-bridge] LightRAG initialized\n")
        return _rag


# ---------------------------------------------------------------------------
# MCP server wiring
# ---------------------------------------------------------------------------


def _build_server() -> Any:
    mcp_mod = _load_mcp()
    Server = mcp_mod["Server"]
    Tool = mcp_mod["Tool"]

    server = Server("lightrag-mcp-bridge")

    @server.list_tools()
    async def list_tools() -> list[Tool]:  # type: ignore[no-untyped-def]
        return [
            Tool(
                name="lightrag_insert",
                description=(
                    "Ingest text into the LightRAG knowledge graph. The text is "
                    "split into chunks, entities/relations are extracted via the "
                    "LLM, and the resulting graph + vector index is persisted to "
                    "the working directory. Use this when the user wants to "
                    "'remember', 'ingest', or 'index' a document for later "
                    "graph-based retrieval."
                ),
                inputSchema={
                    "type": "object",
                    "properties": {
                        "text": {
                            "type": "string",
                            "description": "The document text to ingest.",
                        },
                    },
                    "required": ["text"],
                },
            ),
            Tool(
                name="lightrag_query",
                description=(
                    "Query the LightRAG knowledge graph. Supports 5 retrieval "
                    "modes: naive (vector only), local (entity neighborhood), "
                    "global (community-level summary), hybrid (local+global), "
                    "mix (all three). Use this for knowledge-graph-grounded "
                    "questions over previously ingested documents."
                ),
                inputSchema={
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "The natural-language query.",
                        },
                        "mode": {
                            "type": "string",
                            "enum": ["naive", "local", "global", "hybrid", "mix"],
                            "default": "hybrid",
                            "description": "Retrieval mode.",
                        },
                    },
                    "required": ["query"],
                },
            ),
            Tool(
                name="lightrag_list_docs",
                description=(
                    "List all document IDs currently stored in the LightRAG "
                    "working directory. Useful for the user to see what has been "
                    "ingested so far."
                ),
                inputSchema={"type": "object", "properties": {}},
            ),
            Tool(
                name="lightrag_stats",
                description=(
                    "Return storage statistics for the LightRAG working "
                    "directory: number of documents, entities, relationships, "
                    "and chunks."
                ),
                inputSchema={"type": "object", "properties": {}},
            ),
        ]

    @server.call_tool()
    async def call_tool(name: str, arguments: dict) -> list:  # type: ignore[no-untyped-def]
        mcp_mod2 = _load_mcp()
        TextContent = mcp_mod2["TextContent"]
        rag = await _get_rag()

        try:
            if name == "lightrag_insert":
                text = arguments.get("text", "")
                if not text.strip():
                    return [TextContent(
                        type="text",
                        text="Error: 'text' is required and must be non-empty.",
                    )]
                await rag.ainsert(text)
                return [TextContent(
                    type="text",
                    text=f"OK: ingested {len(text)} chars into LightRAG.",
                )]

            elif name == "lightrag_query":
                query = arguments.get("query", "")
                mode = arguments.get("mode", "hybrid")
                if not query.strip():
                    return [TextContent(
                        type="text",
                        text="Error: 'query' is required and must be non-empty.",
                    )]
                QueryParam = _load_lightrag()["QueryParam"]
                result = await rag.aquery(query, param=QueryParam(mode=mode))
                return [TextContent(
                    type="text",
                    text=str(result) if result else "(no results)",
                )]

            elif name == "lightrag_list_docs":
                # LightRAG stores docs in <working_dir>/kv_store_doc_status.json
                cfg = _config()
                status_file = Path(cfg["working_dir"]) / "kv_store_doc_status.json"
                if not status_file.exists():
                    return [TextContent(
                        type="text",
                        text="No documents ingested yet.",
                    )]
                try:
                    with open(status_file, encoding="utf-8") as f:
                        data = json.load(f)
                    doc_ids = list(data.keys()) if isinstance(data, dict) else []
                    return [TextContent(
                        type="text",
                        text=json.dumps({"doc_count": len(doc_ids), "docs": doc_ids}, ensure_ascii=False),
                    )]
                except Exception as e:
                    return [TextContent(type="text", text=f"Error reading doc status: {e}")]

            elif name == "lightrag_stats":
                cfg = _config()
                wd = Path(cfg["working_dir"])
                stats = {"working_dir": str(wd), "files": {}}
                for name_file in ["graph_chunk_entity_relation.graphml",
                                  "kv_store_doc_status.json",
                                  "kv_store_full_docs.json",
                                  "vector_db.sqlite"]:
                    p = wd / name_file
                    stats["files"][name_file] = {
                        "exists": p.exists(),
                        "size_bytes": p.stat().st_size if p.exists() else 0,
                    }
                return [TextContent(type="text", text=json.dumps(stats, ensure_ascii=False))]

            else:
                return [TextContent(type="text", text=f"Unknown tool: {name}")]

        except Exception as e:
            import traceback
            tb = traceback.format_exc()
            return [TextContent(
                type="text",
                text=f"Error executing {name}: {e}\n\n{tb}",
            )]

    return server


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


async def _main() -> None:
    mcp_mod = _load_mcp()
    server = _build_server()
    stdio_server = mcp_mod["stdio_server"]

    sys.stderr.write("[lightrag-mcp-bridge] starting stdio MCP server\n")
    async with stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream,
            write_stream,
            server.create_initialization_options(),
        )


if __name__ == "__main__":
    try:
        asyncio.run(_main())
    except KeyboardInterrupt:
        sys.stderr.write("[lightrag-mcp-bridge] interrupted, exiting\n")
        sys.exit(0)

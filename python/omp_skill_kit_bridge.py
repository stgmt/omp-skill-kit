#!/usr/bin/env python3
"""Loopback JSONL adapter for the pinned mega-tron runtime."""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import logging
import os
import re
import secrets
import sys
import time
from pathlib import Path
from typing import Any

LOG = logging.getLogger("omp-skill-kit.bridge")
PROTOCOL_VERSION = 1
MAX_REQUEST_BYTES = 64 * 1024
MAX_RESPONSE_BYTES = 16 * 1024
IDLE_SHUTDOWN_S = 30 * 60
OPS = {"ping", "warmup", "rank", "feedback", "shutdown"}
SAFE_SKILL = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
VERDICTS = {"helpful", "harmful", "neutral"}


def _home_arg() -> str:
    return os.environ.get("OMP_SKILL_KIT_HOME", str(Path.home() / ".omp" / "skill-kit"))


def _catalog_root(catalog_path: str, catalog_hash: str) -> Path:
    path = Path(catalog_path).resolve()
    root = path.parent if path.name == "catalog.json" else path
    metadata = root / "catalog.json"
    if metadata.is_file():
        data = json.loads(metadata.read_text(encoding="utf-8"))
        if data.get("revision") != catalog_hash:
            raise ValueError("catalog revision mismatch")
        root = root / "skills"
    if not root.is_dir() or not any(
        (child / "SKILL.md").is_file() for child in root.iterdir() if child.is_dir()
    ):
        raise ValueError("catalog skills directory missing")
    return root


class BridgeServer:
    def __init__(self, home: str, runtime_hash: str, token: str | None = None) -> None:
        self.home = Path(home)
        self.runtime_hash = runtime_hash
        self.token = token or secrets.token_hex(32)
        self.router: Any = None
        self.router_catalog_hash: str | None = None
        self.embedder: Any = None
        self.last_client_ts = time.monotonic()
        self.server: asyncio.AbstractServer | None = None
        self.port = 0
        self._stop_event = asyncio.Event()

    async def start(self, host: str = "127.0.0.1") -> None:
        self.server = await asyncio.start_server(self._handle, host, 0)
        sock = self.server.sockets[0] if self.server.sockets else None
        if sock is None:
            raise RuntimeError("bridge socket was not created")
        self.port = int(sock.getsockname()[1])

    async def self_check(self) -> None:
        reader, writer = await asyncio.open_connection("127.0.0.1", self.port)
        request = {"id": "self-check", "op": "ping", "token": self.token}
        writer.write(json.dumps(request, separators=(",", ":")).encode() + b"\n")
        await writer.drain()
        raw = await asyncio.wait_for(reader.readline(), timeout=2)
        writer.close()
        await writer.wait_closed()
        result = json.loads(raw)
        if result.get("ok") is not True or result.get("result") != "pong":
            raise RuntimeError("bridge self-check failed")

    async def publish_endpoint(self) -> None:
        payload = {
            "protocolVersion": PROTOCOL_VERSION,
            "runtimeHash": self.runtime_hash,
            "pid": os.getpid(),
            "port": self.port,
            "token": self.token,
        }
        self.home.mkdir(parents=True, exist_ok=True)
        tmp = self.home / "endpoint.json.tmp"
        tmp.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
        os.replace(tmp, self.home / "endpoint.json")

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self.last_client_ts = time.monotonic()
        try:
            for _ in range(64):
                raw = await reader.readline()
                if not raw:
                    break
                if len(raw) > MAX_REQUEST_BYTES:
                    await self._send(writer, {"id": None, "ok": False, "error": "request too large"})
                    break
                try:
                    request = json.loads(raw.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    await self._send(writer, {"id": None, "ok": False, "error": "malformed request"})
                    break
                if not isinstance(request, dict) or "token" not in request:
                    await self._send(writer, {"id": None, "ok": False, "error": "missing token"})
                    break
                if not secrets.compare_digest(str(request.get("token", "")), self.token):
                    await self._send(writer, {"id": request.get("id"), "ok": False, "error": "unauthorized"})
                    break
                response = await self._dispatch(request)
                if response is None:
                    break
                await self._send(writer, response)
                self.last_client_ts = time.monotonic()
        except (ConnectionResetError, asyncio.IncompleteReadError):
            pass
        except Exception:
            LOG.warning("bridge request failed", exc_info=True)
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass

    async def _dispatch(self, request: dict[str, Any]) -> dict[str, Any] | None:
        op = request.get("op")
        request_id = request.get("id")
        if op not in OPS:
            return {"id": request_id, "ok": False, "error": "unknown operation"}
        if op == "ping":
            return {"id": request_id, "ok": True, "result": "pong"}
        if op == "shutdown":
            self._stop_event.set()
            return {"id": request_id, "ok": True, "result": "bye"}
        payload = request.get("payload")
        if op == "warmup":
            payload = payload or {}
            try:
                await self._warmup(str(payload.get("catalogPath", "")), str(payload.get("catalogHash", "")))
                return {"id": request_id, "ok": True, "result": "warm"}
            except Exception:
                return {"id": request_id, "ok": False, "error": "warmup failed"}
        if not isinstance(payload, dict):
            return {"id": request_id, "ok": False, "error": "bad payload"}
        try:
            if op == "feedback":
                return {"id": request_id, "ok": True, "result": await self._record_feedback(payload)}
            return {"id": request_id, "ok": True, "result": await self._rank(payload)}
        except Exception:
            LOG.warning("bridge operation failed", exc_info=True)
            return {"id": request_id, "ok": False, "error": f"{op} failed"}

    async def _send(self, writer: asyncio.StreamWriter, response: dict[str, Any]) -> None:
        wire = json.dumps(response, separators=(",", ":"))
        if len(wire.encode("utf-8")) > MAX_RESPONSE_BYTES:
            wire = json.dumps({"id": response.get("id"), "ok": False, "error": "response too large"}, separators=(",", ":"))
        writer.write(wire.encode("utf-8") + b"\n")
        await writer.drain()

    async def _get_router(self, catalog_path: str, catalog_hash: str) -> Any:
        skills_dir = _catalog_root(catalog_path, catalog_hash)
        if self.embedder is None:
            from mega_tron.embedder import make_embedder  # type: ignore
            self.embedder = await asyncio.to_thread(make_embedder)
        if self.router is None or self.router_catalog_hash != catalog_hash:
            from mega_tron.cache import Cache  # type: ignore
            from mega_tron.router import Router  # type: ignore
            cache_path = self.home / "runtime" / "cache" / f"{catalog_hash}.npz"
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            self.router = Router(skills_dir=skills_dir, embedder=self.embedder, cache=Cache(cache_path))
            self.router_catalog_hash = catalog_hash
        return self.router

    async def _warmup(self, catalog_path: str, catalog_hash: str) -> None:
        if not catalog_path or not catalog_hash:
            return
        router = await self._get_router(catalog_path, catalog_hash)
        await asyncio.to_thread(router.warmup)

    def _feedback_path(self) -> Path:
        return self.home / "telemetry" / "feedback.json"

    def _load_feedback(self) -> dict[str, dict[str, dict[str, int]]]:
        try:
            data = json.loads(self._feedback_path().read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    def _save_feedback(self, data: dict[str, dict[str, dict[str, int]]]) -> None:
        path = self._feedback_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
        os.replace(tmp, path)

    async def _record_feedback(self, payload: dict[str, Any]) -> dict[str, Any]:
        project_id = payload.get("projectId")
        verdict = payload.get("verdict")
        route_id = payload.get("routeId")
        skill_names = payload.get("skillNames")
        if not isinstance(project_id, str) or len(project_id) != 64:
            raise ValueError("invalid project id")
        if verdict not in VERDICTS or not isinstance(route_id, str) or not route_id:
            raise ValueError("invalid feedback")
        if not isinstance(skill_names, list) or not skill_names or any(
            not isinstance(name, str) or SAFE_SKILL.fullmatch(name) is None for name in skill_names
        ):
            raise ValueError("invalid skill names")
        data = self._load_feedback()
        project = data.setdefault(project_id, {})
        for name in set(skill_names):
            stats = project.setdefault(name, {"helpful": 0, "harmful": 0, "neutral": 0})
            stats[verdict] = int(stats.get(verdict, 0)) + 1
        self._save_feedback(data)
        return {"recorded": True, "routeId": route_id, "skills": len(set(skill_names))}

    def _feedback_bias(self, project_id: str, skill_name: str) -> float:
        stats = self._load_feedback().get(project_id, {}).get(skill_name, {})
        helpful = int(stats.get("helpful", 0))
        harmful = int(stats.get("harmful", 0))
        return max(-0.1, min(0.1, helpful * 0.02 - harmful * 0.03))

    async def _rank(self, payload: dict[str, Any]) -> dict[str, Any]:
        prompt = payload.get("prompt")
        prompt_hash = payload.get("promptHash")
        catalog_hash = payload.get("catalogHash")
        catalog_path = payload.get("catalogPath")
        session_id = payload.get("sessionId")
        project_id = payload.get("projectId")
        project_name = payload.get("projectName")
        route_id = payload.get("routeId")
        top_k = max(1, min(3, int(payload.get("topK", 3))))
        if not isinstance(prompt, str) or not prompt or len(prompt.encode("utf-8")) > MAX_REQUEST_BYTES:
            raise ValueError("invalid prompt")
        if not isinstance(prompt_hash, str) or hashlib.sha256(prompt.encode("utf-8")).hexdigest() != prompt_hash:
            raise ValueError("prompt hash mismatch")
        if not isinstance(catalog_hash, str) or not isinstance(catalog_path, str):
            raise ValueError("catalog identity missing")
        if not isinstance(project_id, str) or len(project_id) != 64 or not isinstance(route_id, str):
            raise ValueError("route identity missing")
        router = await self._get_router(catalog_path, catalog_hash)
        ranked = await asyncio.to_thread(router.rank, prompt, top_k=top_k, dynamic=True)
        try:
            from mega_tron.hosts._route_log import log_route_from_ranked  # type: ignore
            await asyncio.to_thread(log_route_from_ranked, prompt, ranked, router, session_id=session_id if isinstance(session_id, str) else None, host="omp")
        except Exception:
            pass
        candidates = []
        project_feedback = self._load_feedback().get(project_id, {})
        feedback_applied = bool(project_feedback)
        feedback_adjusted = 0
        for item in ranked[:top_k]:
            name = getattr(item, "name", "")
            score = getattr(item, "score", None)
            if isinstance(name, str) and name and isinstance(score, (int, float)) and score == score:
                bias = self._feedback_bias(project_id, name)
                if bias != 0:
                    feedback_adjusted += 1
                candidates.append({"name": name, "score": float(score) + bias})
        candidates.sort(key=lambda item: item["score"], reverse=True)
        return {
            "candidates": candidates,
            "routeId": route_id,
            "projectId": project_id,
            "projectName": project_name if isinstance(project_name, str) else "unknown-project",
            "catalogRevision": catalog_hash,
            "feedbackApplied": feedback_applied,
            "feedbackAdjusted": feedback_adjusted,
        }


class Bridge:
    def __init__(self) -> None:
        parser = argparse.ArgumentParser(description="omp-skill-kit bridge")
        parser.add_argument("--home", default=_home_arg())
        parser.add_argument("--runtime-hash", default="")
        parser.add_argument("--token", default=None)
        parser.add_argument("--catalog-path", default="")
        parser.add_argument("--catalog-hash", default="")
        parser.add_argument("--fixture-query", default="route a software engineering task")
        parser.add_argument("--warmup-only", action="store_true")
        parser.add_argument("--idle-shutdown-s", type=float, default=IDLE_SHUTDOWN_S)
        self.args = parser.parse_args()

    async def run(self) -> int:
        home = Path(self.args.home)
        home.mkdir(parents=True, exist_ok=True)
        if self.args.warmup_only:
            server = BridgeServer(str(home), self.args.runtime_hash, self.args.token or "warmup")
            await server._warmup(self.args.catalog_path, self.args.catalog_hash)
            if self.args.catalog_path and self.args.catalog_hash:
                await server._rank({
                    "prompt": self.args.fixture_query,
                    "promptHash": hashlib.sha256(self.args.fixture_query.encode()).hexdigest(),
                    "catalogHash": self.args.catalog_hash,
                    "catalogPath": self.args.catalog_path,
                    "sessionId": "installer-fixture",
                    "routeId": "installer-fixture",
                    "projectId": "0" * 64,
                    "projectName": "installer-fixture",
                    "topK": 1,
                })
            print("warmup ok", flush=True)
            return 0
        server = BridgeServer(str(home), self.args.runtime_hash, self.args.token)
        logging.basicConfig(level=logging.WARNING, format="%(message)s")
        await server.start()
        await server.self_check()
        await server.publish_endpoint()
        print(f"bridge listening on 127.0.0.1:{server.port}", flush=True)
        try:
            while not server._stop_event.is_set():
                try:
                    await asyncio.wait_for(server._stop_event.wait(), timeout=5)
                except asyncio.TimeoutError:
                    if time.monotonic() - server.last_client_ts > self.args.idle_shutdown_s:
                        LOG.warning("bridge idle; shutting down")
                        server._stop_event.set()
        finally:
            if server.server is not None:
                server.server.close()
                await server.server.wait_closed()
            endpoint = home / "endpoint.json"
            try:
                data = json.loads(endpoint.read_text(encoding="utf-8"))
                if data.get("pid") == os.getpid(): endpoint.unlink()
            except Exception:
                pass
        return 0

    def _main(self) -> None:
        try:
            sys.exit(asyncio.run(self.run()))
        except KeyboardInterrupt:
            sys.exit(0)


if __name__ == "__main__":
    Bridge()._main()

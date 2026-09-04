#!/usr/bin/env python3
"""Loopback proxy that adds project-aware OMP telemetry to mega-tron dashboard."""
from __future__ import annotations

import argparse
import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request, urlopen


def load_events(home: Path, days: int) -> list[dict]:
    path = home / "telemetry" / "events.jsonl"
    cutoff = time.time() - max(1, days) * 86400
    result: list[dict] = []
    try:
        for line in path.read_text(encoding="utf-8").splitlines()[-10000:]:
            try:
                item = json.loads(line)
                ts = time.mktime(time.strptime(item.get("ts", "")[:19], "%Y-%m-%dT%H:%M:%S"))
                if ts >= cutoff and isinstance(item, dict):
                    result.append(item)
            except (ValueError, TypeError, json.JSONDecodeError):
                continue
    except OSError:
        pass
    return result


def analytics(home: Path, days: int) -> dict:
    events = load_events(home, days)
    routes = [event for event in events if event.get("type") == "route"]
    usage = [event for event in events if event.get("type") in {"usage", "feedback"}]
    feedback = [event for event in events if event.get("type") == "feedback"]
    projects: dict[str, dict] = {}
    for event in routes:
        project = projects.setdefault(event.get("projectName", "unknown-project"), {
            "project": event.get("projectName", "unknown-project"),
            "projectId": event.get("projectId", ""),
            "routes": 0,
            "matched": 0,
            "empty": 0,
            "unavailable": 0,
            "timeout": 0,
            "selected": 0,
            "catalogRevisions": set(),
        })
        project["routes"] += 1
        status = event.get("status")
        if status in project:
            project[status] += 1
        project["selected"] += len(event.get("selected", []))
        revision = event.get("catalogRevision")
        if revision:
            project["catalogRevisions"].add(revision)
    for project in projects.values():
        project["catalogRevisions"] = len(project["catalogRevisions"])
    return {
        "host": "omp",
        "days": days,
        "routes": len(routes),
        "used": sum(len(event.get("used", [])) for event in usage),
        "verdicts": len(feedback),
        "by_status": {status: sum(event.get("status") == status for event in routes) for status in ("matched", "empty", "unavailable", "timeout", "failed")},
        "projects": list(projects.values()),
        "events": events[-200:],
    }


def inject_project_panel(body: bytes) -> bytes:
    if b"</body>" not in body:
        return body
    script = b"""
<script>
(async () => {
  try {
    const data = await fetch('/api/omp/overview').then((response) => response.json());
    const section = document.createElement('section');
    section.id = 'omp-project-analytics';
    section.style.cssText = 'margin:24px 0;padding:16px;border:1px solid #334155;border-radius:12px;background:#0f172a;color:#e2e8f0;font:14px system-ui';
    const title = document.createElement('h2');
    title.textContent = 'OMP project analytics';
    section.append(title);
    for (const project of data.projects || []) {
      const row = document.createElement('div');
      row.textContent = `${project.project}: ${project.routes} routes, ${project.matched} matched, ${project.selected} selected, ${project.catalogRevisions} catalog revisions`;
      section.append(row);
    }
    document.body.append(section);
  } catch (_) {}
})();
</script>
"""
    return body.replace(b"</body>", script + b"</body>", 1)


def merge_overview(upstream: dict, local: dict) -> dict:
    result = dict(upstream)
    by_host = dict(result.get("by_host") or {})
    omp_routes = local["routes"]
    by_host["omp"] = omp_routes
    result["by_host"] = by_host
    result["unknown_host_count"] = max(0, int(result.get("unknown_host_count", 0)) - omp_routes)
    result["omp_unknown_host_count"] = 0
    result["omp"] = local
    result["project_analytics"] = local["projects"]
    return result


class Handler(BaseHTTPRequestHandler):
    home: Path
    upstream_port: int

    def log_message(self, format: str, *args) -> None:
        return

    def do_GET(self) -> None:
        parsed = urlsplit(self.path)
        query = parse_qs(parsed.query)
        days = int(query.get("days", ["30"])[0]) if query.get("days", ["30"])[0].isdigit() else 30
        if parsed.path == "/api/omp/overview":
            self.send_json(analytics(self.home, days))
            return
        if parsed.path == "/api/omp/events":
            self.send_json({"events": analytics(self.home, days)["events"]})
            return
        upstream = self.fetch_upstream(parsed.path, parsed.query)
        if parsed.path == "/api/overview" and isinstance(upstream, dict):
            upstream = merge_overview(upstream, analytics(self.home, days))
        if upstream is None:
            self.send_error(502, "upstream dashboard unavailable")
        elif isinstance(upstream, (dict, list)):
            self.send_json(upstream)
        else:
            body = inject_project_panel(upstream[2]) if parsed.path == "/" and upstream[1].startswith("text/html") else upstream[2]
            self.send_bytes(upstream[0], upstream[1], body)

    def fetch_upstream(self, path: str, query: str):
        try:
            request = Request(f"http://127.0.0.1:{self.upstream_port}{path}" + (f"?{query}" if query else ""))
            with urlopen(request, timeout=3) as response:
                body = response.read()
                content_type = response.headers.get("Content-Type", "application/octet-stream")
                if "application/json" in content_type:
                    return json.loads(body.decode("utf-8"))
                return int(response.status), content_type, body
        except Exception:
            return None

    def send_json(self, value: object) -> None:
        self.send_bytes(200, "application/json; charset=utf-8", json.dumps(value, separators=(",", ":")).encode())

    def send_bytes(self, status: int, content_type: str, body: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--home", required=True)
    parser.add_argument("--upstream-port", required=True, type=int)
    parser.add_argument("--port", required=True, type=int)
    args = parser.parse_args()
    handler = type("OMPAdapterHandler", (Handler,), {})
    handler.home = Path(args.home)
    handler.upstream_port = args.upstream_port
    server = ThreadingHTTPServer(("127.0.0.1", args.port), handler)
    server.serve_forever()


if __name__ == "__main__":
    main()

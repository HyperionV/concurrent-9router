#!/usr/bin/env python3
"""Batch proxy tester that reads proxies from a file and writes JSON metrics."""

from __future__ import annotations

import argparse
import base64
import concurrent.futures
import datetime as dt
import json
import math
import pathlib
import ssl
import statistics
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter


DEFAULT_PROXY_FILE = "scripts/proxy_list.txt"
DEFAULT_OUTPUT_FILE = "scripts/proxy_results.json"
DEFAULT_URL = "https://api.ipify.org?format=json"


def mask_proxy_url(proxy_url: str) -> str:
    parsed = urllib.parse.urlsplit(proxy_url)
    if not parsed.username:
        return proxy_url

    username = urllib.parse.unquote(parsed.username)
    host = parsed.hostname or ""
    port = f":{parsed.port}" if parsed.port else ""
    scheme = parsed.scheme or "http"
    return f"{scheme}://{username}:***@{host}{port}"


def build_opener(
    proxy_url: str,
    ssl_context: ssl.SSLContext,
) -> urllib.request.OpenerDirector:
    parsed = urllib.parse.urlsplit(proxy_url)
    if not parsed.scheme or not parsed.hostname:
        raise ValueError(f"Invalid proxy URL: {proxy_url}")

    host = parsed.hostname
    port = f":{parsed.port}" if parsed.port else ""
    base_proxy = f"{parsed.scheme}://{host}{port}"
    handlers: list[urllib.request.BaseHandler] = [
        urllib.request.ProxyHandler(
            {
                "http": base_proxy,
                "https": base_proxy,
            }
        ),
        urllib.request.HTTPSHandler(context=ssl_context),
    ]

    if parsed.username or parsed.password:
        username = urllib.parse.unquote(parsed.username or "")
        password = urllib.parse.unquote(parsed.password or "")
        token = base64.b64encode(f"{username}:{password}".encode("utf-8")).decode("ascii")
        handlers.append(urllib.request.ProxyBasicAuthHandler())
        opener = urllib.request.build_opener(*handlers)
        opener.addheaders = [
            ("User-Agent", "proxy-metrics-tester/1.0"),
            ("Proxy-Authorization", f"Basic {token}"),
        ]
        return opener

    opener = urllib.request.build_opener(*handlers)
    opener.addheaders = [("User-Agent", "proxy-metrics-tester/1.0")]
    return opener


def percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    rank = max(0, math.ceil((pct / 100.0) * len(ordered)) - 1)
    return ordered[rank]


def parse_ip(payload: bytes) -> str | None:
    try:
        data = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None

    for key in ("ip", "origin"):
        value = data.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def compute_summary(results: list[dict[str, object]], wall_time_s: float) -> dict[str, object]:
    success = [item for item in results if item["ok"]]
    failures = [item for item in results if not item["ok"]]
    latencies = [float(item["elapsed_ms"]) for item in success]
    bytes_total = sum(int(item["bytes"]) for item in results)
    status_counts = Counter(str(item["status"]) for item in results if item["status"] is not None)
    ip_counts = Counter(str(item["ip"]) for item in success if item["ip"])

    summary: dict[str, object] = {
        "requests": len(results),
        "success": len(success),
        "failures": len(failures),
        "success_rate": (len(success) / len(results) * 100.0) if results else 0.0,
        "bytes_total": bytes_total,
        "status_counts": dict(sorted(status_counts.items())),
        "ip_counts": dict(sorted(ip_counts.items())),
        "wall_time_s": wall_time_s,
        "throughput_rps": (len(results) / wall_time_s) if wall_time_s > 0 else 0.0,
        "success_rps": (len(success) / wall_time_s) if wall_time_s > 0 else 0.0,
    }

    if latencies:
        summary.update(
            {
                "latency_avg_ms": statistics.mean(latencies),
                "latency_min_ms": min(latencies),
                "latency_p50_ms": statistics.median(latencies),
                "latency_p95_ms": percentile(latencies, 95),
                "latency_max_ms": max(latencies),
            }
        )

    return summary


def load_proxy_list(proxy_file: pathlib.Path) -> list[str]:
    proxies: list[str] = []
    for raw_line in proxy_file.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        proxies.append(line)
    return proxies


def run_probe(
    opener: urllib.request.OpenerDirector,
    url: str,
    timeout: float,
) -> dict[str, object]:
    request = urllib.request.Request(url)
    started = time.perf_counter()

    try:
        with opener.open(request, timeout=timeout) as response:
            body = response.read()
            elapsed_ms = (time.perf_counter() - started) * 1000.0
            return {
                "ok": True,
                "status": response.getcode(),
                "bytes": len(body),
                "elapsed_ms": elapsed_ms,
                "ip": parse_ip(body),
                "error": None,
            }
    except urllib.error.HTTPError as exc:
        elapsed_ms = (time.perf_counter() - started) * 1000.0
        body = exc.read()
        return {
            "ok": False,
            "status": exc.code,
            "bytes": len(body),
            "elapsed_ms": elapsed_ms,
            "ip": parse_ip(body),
            "error": f"HTTPError: {exc.code} {exc.reason}",
        }
    except Exception as exc:  # noqa: BLE001 - surface raw transport errors clearly
        elapsed_ms = (time.perf_counter() - started) * 1000.0
        return {
            "ok": False,
            "status": None,
            "bytes": 0,
            "elapsed_ms": elapsed_ms,
            "ip": None,
            "error": f"{type(exc).__name__}: {exc}",
        }


def run_probe_once(
    request_id: int,
    proxy_url: str,
    url: str,
    timeout: float,
    ssl_context: ssl.SSLContext,
) -> tuple[int, dict[str, object]]:
    opener = build_opener(proxy_url, ssl_context)
    return request_id, run_probe(opener, url, timeout)


def run_requests_for_proxy(
    proxy_url: str,
    target_url: str,
    total_requests: int,
    concurrency: int,
    timeout: float,
    delay: float,
    ssl_context: ssl.SSLContext,
) -> tuple[list[dict[str, object]], float]:
    results: list[dict[str, object]] = []
    started = time.perf_counter()

    if concurrency == 1:
        opener = build_opener(proxy_url, ssl_context)
        for request_id in range(1, total_requests + 1):
            result = run_probe(opener, target_url, timeout)
            result["request_id"] = request_id
            results.append(result)

            status = result["status"] if result["status"] is not None else "-"
            elapsed = float(result["elapsed_ms"])
            size = int(result["bytes"])
            ip = result["ip"] or "-"
            error = result["error"]

            if result["ok"]:
                print(
                    f"[{request_id}/{total_requests}] ok"
                    f" status={status}"
                    f" latency={elapsed:.2f}ms"
                    f" bytes={size}"
                    f" ip={ip}"
                )
            else:
                print(
                    f"[{request_id}/{total_requests}] fail"
                    f" status={status}"
                    f" latency={elapsed:.2f}ms"
                    f" error={error}"
                )

            if request_id < total_requests and delay:
                time.sleep(delay)
    else:
        ordered_results: list[dict[str, object] | None] = [None] * total_requests
        with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as executor:
            futures = [
                executor.submit(
                    run_probe_once,
                    request_id,
                    proxy_url,
                    target_url,
                    timeout,
                    ssl_context,
                )
                for request_id in range(1, total_requests + 1)
            ]

            completed = 0
            for future in concurrent.futures.as_completed(futures):
                request_id, result = future.result()
                result["request_id"] = request_id
                ordered_results[request_id - 1] = result
                completed += 1

                status = result["status"] if result["status"] is not None else "-"
                elapsed = float(result["elapsed_ms"])
                size = int(result["bytes"])
                ip = result["ip"] or "-"
                error = result["error"]

                if result["ok"]:
                    print(
                        f"[{completed}/{total_requests}] ok"
                        f" request={request_id}"
                        f" status={status}"
                        f" latency={elapsed:.2f}ms"
                        f" bytes={size}"
                        f" ip={ip}"
                    )
                else:
                    print(
                        f"[{completed}/{total_requests}] fail"
                        f" request={request_id}"
                        f" status={status}"
                        f" latency={elapsed:.2f}ms"
                        f" error={error}"
                    )

        results = [result for result in ordered_results if result is not None]

    wall_time_s = time.perf_counter() - started
    return results, wall_time_s


def build_output_payload(
    proxy_runs: list[dict[str, object]],
    target_url: str,
    requests_per_proxy: int,
    concurrency: int,
    proxy_file: str,
) -> dict[str, object]:
    return {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "target_url": target_url,
        "requests_per_proxy": requests_per_proxy,
        "concurrency": concurrency,
        "proxy_file": proxy_file,
        "proxies": [
            {
                "proxy": mask_proxy_url(str(proxy_run["proxy"])),
                "summary": proxy_run["summary"],
                "requests": proxy_run["requests"],
            }
            for proxy_run in proxy_runs
        ],
    }


def print_proxy_summary(
    proxy_url: str,
    results: list[dict[str, object]],
    wall_time_s: float,
    concurrency: int,
) -> dict[str, object]:
    summary = compute_summary(results, wall_time_s)
    print("\nSummary")
    print("-" * 60)
    print(f"Proxy:         {mask_proxy_url(proxy_url)}")
    print(f"Requests:      {summary['requests']}")
    print(f"Concurrency:   {concurrency}")
    print(f"Success:       {summary['success']}")
    print(f"Failures:      {summary['failures']}")
    print(f"Success rate:  {float(summary['success_rate']):.1f}%")
    print(f"Bytes total:   {summary['bytes_total']}")
    print(f"Wall time:     {float(summary['wall_time_s']):.2f} s")
    print(f"Throughput:    {float(summary['throughput_rps']):.2f} req/s")
    print(f"Success rps:   {float(summary['success_rps']):.2f} req/s")

    if "latency_avg_ms" in summary:
        print(f"Latency avg:   {float(summary['latency_avg_ms']):.2f} ms")
        print(f"Latency min:   {float(summary['latency_min_ms']):.2f} ms")
        print(f"Latency p50:   {float(summary['latency_p50_ms']):.2f} ms")
        print(f"Latency p95:   {float(summary['latency_p95_ms']):.2f} ms")
        print(f"Latency max:   {float(summary['latency_max_ms']):.2f} ms")
    else:
        print("Latency:       no successful responses")

    if summary["status_counts"]:
        formatted = ", ".join(
            f"{code} x{count}" for code, count in dict(summary["status_counts"]).items()
        )
        print(f"Status codes:  {formatted}")

    if summary["ip_counts"]:
        formatted = ", ".join(f"{ip} x{count}" for ip, count in dict(summary["ip_counts"]).items())
        print(f"Exit IPs:      {formatted}")
    return summary


def print_usage_guidance(proxy_file: str, output_file: str) -> None:
    print("\nUsage guidance")
    print("-" * 60)
    print(f"- Put one proxy per line in `{proxy_file}`")
    print("- Blank lines and lines starting with `#` are ignored")
    print(f"- Run: `python scripts/proxy_test.py` to use `{proxy_file}`")
    print(
        "- Override load settings with flags such as "
        "`--requests 10 --concurrency 5 --timeout 20 --url https://api.ipify.org?format=json`"
    )
    print(f"- Results are written to `{output_file}` as JSON")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Load proxies from a newline-separated file and write JSON metrics per proxy.",
        epilog=(
            "Examples:\n"
            "  python scripts/proxy_test.py\n"
            "  python scripts/proxy_test.py --proxy-file scripts/proxy_list.txt --output scripts/proxy_results.json\n"
            "  python scripts/proxy_test.py --requests 10 --concurrency 5 --timeout 20\n"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--proxy-file",
        default=DEFAULT_PROXY_FILE,
        help="Path to a newline-separated proxy list file.",
    )
    parser.add_argument(
        "--output",
        default=DEFAULT_OUTPUT_FILE,
        help="Path to the JSON output file.",
    )
    parser.add_argument("--url", default=DEFAULT_URL, help="Test URL to request through the proxy.")
    parser.add_argument("--requests", type=int, default=5, help="Number of requests to make per proxy.")
    parser.add_argument(
        "--concurrency",
        type=int,
        default=1,
        help="Number of concurrent requests to run. Total requests stay fixed.",
    )
    parser.add_argument("--timeout", type=float, default=15.0, help="Per-request timeout in seconds.")
    parser.add_argument(
        "--delay",
        type=float,
        default=0.5,
        help="Delay in seconds between requests.",
    )
    parser.add_argument(
        "--insecure",
        action="store_true",
        help="Disable TLS certificate verification for the target URL.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.requests < 1:
        raise SystemExit("--requests must be >= 1")
    if args.concurrency < 1:
        raise SystemExit("--concurrency must be >= 1")
    if args.timeout <= 0:
        raise SystemExit("--timeout must be > 0")
    if args.delay < 0:
        raise SystemExit("--delay must be >= 0")

    proxy_file = pathlib.Path(args.proxy_file)
    output_file = pathlib.Path(args.output)
    if not proxy_file.exists():
        raise SystemExit(f"Proxy file not found: {proxy_file}")

    proxies = load_proxy_list(proxy_file)
    if not proxies:
        raise SystemExit(f"No proxies found in {proxy_file}")

    ssl_context = ssl.create_default_context()
    if args.insecure:
        ssl_context.check_hostname = False
        ssl_context.verify_mode = ssl.CERT_NONE

    print("Batch proxy test")
    print("-" * 60)
    print(f"Proxy file:    {args.proxy_file}")
    print(f"Output file:   {args.output}")
    print(f"Target:        {args.url}")
    print(f"Proxies:       {len(proxies)}")
    print(f"Requests:      {args.requests} per proxy")
    print(f"Concurrency:   {args.concurrency}")
    print(f"Timeout:       {args.timeout:.1f}s")
    if args.concurrency > 1 and args.delay:
        print("Delay:         ignored in concurrent mode")
    print("")

    proxy_runs: list[dict[str, object]] = []
    for index, proxy_url in enumerate(proxies, start=1):
        print(f"Proxy {index}/{len(proxies)}: {mask_proxy_url(proxy_url)}")
        results, wall_time_s = run_requests_for_proxy(
            proxy_url=proxy_url,
            target_url=args.url,
            total_requests=args.requests,
            concurrency=args.concurrency,
            timeout=args.timeout,
            delay=args.delay,
            ssl_context=ssl_context,
        )
        summary = print_proxy_summary(proxy_url, results, wall_time_s, args.concurrency)
        proxy_runs.append(
            {
                "proxy": proxy_url,
                "summary": summary,
                "requests": results,
            }
        )
        print("")

    payload = build_output_payload(
        proxy_runs=proxy_runs,
        target_url=args.url,
        requests_per_proxy=args.requests,
        concurrency=args.concurrency,
        proxy_file=args.proxy_file,
    )
    output_file.parent.mkdir(parents=True, exist_ok=True)
    output_file.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    print(f"Saved JSON results to `{args.output}`")
    print_usage_guidance(args.proxy_file, args.output)

    all_ok = all(
        request_result["ok"]
        for proxy_run in proxy_runs
        for request_result in list(proxy_run["requests"])
    )
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())

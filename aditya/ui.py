# Local UI for the page replacement simulator.
#
#   python3 aditya/ui.py   -> builds ./sim if needed and opens http://localhost:8000
#
# Every number shown in the UI comes from ./sim (the C files in aniruddh/ and aditya/).
# This file only checks the options, runs ./sim and passes its JSON / CSV output
# to the web page in ui/.
# Only Python's standard library is used.

import csv
import glob
import http.server
import io
import json
import os
import subprocess
import sys
import time
import urllib.parse
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)   # repository root
SIM = os.path.join(ROOT, "sim")
WEB = os.path.join(HERE, "ui")
SOURCES = glob.glob(os.path.join(ROOT, "aniruddh", "*.[ch]")) + glob.glob(os.path.join(ROOT, "aditya", "*.[ch]"))

ALGOS = ["FIFO", "LRU", "LFU", "Optimal", "Adaptive"]
WORKLOADS = ["classic", "sequential", "looping", "random", "bursty", "phased"]
PLACES = ["default", "random", "hot", "warm", "cold"]


def build_sim():
    """Compile ./sim if it is missing or older than any source file."""
    if os.path.exists(SIM) and os.path.getmtime(SIM) >= max(os.path.getmtime(s) for s in SOURCES):
        return
    print("compiling the simulator ...")
    c_files = [s for s in SOURCES if s.endswith(".c")]
    result = subprocess.run(["gcc", "-o", SIM] + c_files, capture_output=True, text=True)
    if result.returncode != 0:
        print(result.stderr)
        sys.exit("could not compile the simulator (is gcc installed?)")


def run_sim(args):
    result = subprocess.run([SIM] + args, capture_output=True, text=True, timeout=120)
    return result.returncode, result.stdout


class BadRequest(Exception):
    pass


def get_int(q, name, default, low, high):
    value = q.get(name, [str(default)])[0]
    try:
        number = int(value)
    except ValueError:
        raise BadRequest(name + " must be a whole number")
    if number < low or number > high:
        raise BadRequest("%s must be between %d and %d" % (name, low, high))
    return number


def get_choice(q, name, default, choices):
    value = q.get(name, [default])[0]
    if value not in choices:
        raise BadRequest("unknown " + name + ": " + value)
    return value


def run_args(q):
    """Turns the query string of the web page into checked ./sim options."""
    args = ["--algo", get_choice(q, "algo", "Adaptive", ALGOS),
            "--workload", get_choice(q, "workload", "phased", WORKLOADS),
            "--frames", str(get_int(q, "frames", 8, 1, 32)),
            "--length", str(get_int(q, "length", 1000, 10, 5000)),
            "--seed", str(get_int(q, "seed", 42, 0, 1000000))]
    place = get_choice(q, "sensitivity", "default", PLACES)
    if place != "default":
        args += ["--place", place, "--percent", str(get_int(q, "percent", 15, 0, 100))]
    weights = q.get("weights", ["0.2,0.2,1.0,0.3"])[0].split(",")
    try:
        if len(weights) != 4 or any(not (0 <= float(w) <= 10) for w in weights):
            raise ValueError
    except ValueError:
        raise BadRequest("weights must be four numbers between 0 and 10")
    args += ["--weights", ",".join(str(float(w)) for w in weights)]
    if q.get("security", ["1"])[0] == "0":
        args.append("--no-security")
    if q.get("behaviour", ["1"])[0] == "0":
        args.append("--no-behaviour")
    if q.get("feedback", ["1"])[0] == "0":
        args.append("--no-feedback")
    return args


def with_algo(args, algo):
    args = list(args)
    args[args.index("--algo") + 1] = algo
    return args


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WEB, **kwargs)

    def log_message(self, fmt, *args):
        pass   # keep the terminal quiet

    def send_json(self, status, body):
        data = body if isinstance(body, str) else json.dumps(body)
        data = data.encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        if not url.path.startswith("/api/"):
            return super().do_GET()
        q = urllib.parse.parse_qs(url.query)
        try:
            self.api(url.path[5:], q)
        except BadRequest as e:
            self.send_json(400, {"error": str(e)})
        except Exception as e:
            self.send_json(500, {"error": "simulator failed: " + str(e)})

    def sim_json(self, args):
        code, out = run_sim(args)
        self.send_json(200 if code == 0 else 400, out)

    def api(self, name, q):
        if name == "params":
            return self.sim_json(["--params"])

        if name == "run":
            return self.sim_json(["--trace"] + run_args(q))

        if name == "inspect":
            t = get_int(q, "t", 0, 0, 4999)
            return self.sim_json(["--inspect", str(t)] + run_args(q))

        if name == "compare":
            # same workload and settings, every algorithm
            args = run_args(q)
            out = {}
            for algo in ALGOS:
                code, text = run_sim(["--trace"] + with_algo(args, algo))
                trace = json.loads(text)
                if code != 0:
                    return self.send_json(400, trace)
                cumulative, total = [], 0
                step = max(1, len(trace["events"]) // 250)
                for i, event in enumerate(trace["events"]):
                    total += 1 - event[0]
                    if i % step == 0 or i == len(trace["events"]) - 1:
                        cumulative.append([i, total])
                out[algo] = {"faults": trace["faults"], "hits": trace["hits"], "evicted": trace["evicted"],
                             "time_us": trace["time_us"], "cumulative": cumulative}
            return self.send_json(200, out)

        if name == "experiments":
            seed = get_int(q, "seed", 42, 0, 1000000)
            code, text = run_sim(["--csv", "--seed", str(seed)])
            if code != 0:
                return self.send_json(500, {"error": "./sim --csv failed"})
            rows = list(csv.DictReader(io.StringIO(text)))
            for r in rows:
                for key in ["frames", "faults", "hits", "evict_s0", "evict_s1", "evict_s2", "evict_s3"]:
                    r[key] = int(r[key])
                for key in ["hit_rate", "time_us"]:
                    r[key] = float(r[key])
            meta = {"command": "./sim --csv --seed %d" % seed, "seed": seed,
                    "generated": time.strftime("%Y-%m-%d %H:%M:%S"), "requests_per_workload": 5000}
            return self.send_json(200, {"meta": meta, "rows": rows})

        if name == "tests":
            seed = get_int(q, "seed", 42, 0, 1000000)
            code, text = run_sim(["--test", "--seed", str(seed)])
            checks = []
            for line in text.splitlines():
                if line.startswith("PASS  ") or line.startswith("FAIL  "):
                    checks.append({"status": line[:4], "name": line[6:]})
                elif line.startswith("      "):
                    checks.append({"status": "INFO", "name": line.strip()})
            passed = sum(1 for c in checks if c["status"] == "PASS")
            failed = sum(1 for c in checks if c["status"] == "FAIL")
            return self.send_json(200, {"seed": seed, "passed": passed, "failed": failed, "checks": checks})

        raise BadRequest("unknown API: " + name)


def main():
    build_sim()
    port = 8000
    while True:
        try:
            server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
            break
        except OSError:
            port += 1
    address = "http://localhost:%d" % port
    print("UI running at " + address + "  (press Ctrl+C to stop)")
    if "--no-browser" not in sys.argv:
        webbrowser.open(address)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()

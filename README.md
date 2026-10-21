# Security- and Behaviour-Aware Adaptive Page Replacement

OS project by Aditya & Aniruddh. A page replacement simulator in C, and an **Adaptive** algorithm that decides which page to evict using five factors:

```
Score(p) = 0.2·R + 0.2·F + 1.0·B + 0.3·W − wS·S
```

| Factor | Meaning (higher = better page to evict) |
|---|---|
| R, recency | used longest ago |
| F, frequency | used fewest times since it was loaded |
| B, behaviour | depends on the detected pattern: MRU-like for loops and scans, LRU-like for bursts, neutral for random |
| W, working set | not used in the last 32 requests |
| S, sensitivity | S2 = 0.5, S3 = 1 (halved when the page is not in use); subtracted, so secret pages are kept |

Security rules: a top-secret (S3) page that is in use is never evicted unless every page in memory is protected. Every S3 eviction counts as a secure eviction. Every 100 requests the fault rate adjusts `wS` (above 30% → lower it, below 15% → raise it, between 0.5 and 2.0).

## Dataset

We do not use a downloaded dataset. The simulator generates its own memory-access traces (`make_workload()` in `aniruddh/workload.c`).

- **Size and seed:** each workload is 5,000 page requests over 64 pages, made with C's `rand()` from a fixed seed (42; seeds 1–10 for the robustness test). The same seed always gives the same data.
- **Patterns:**
  - sequential: pages in order
  - looping: 12 pages repeated
  - random
  - bursty: 90% of requests go to a group of 6 pages that moves every 50 requests
  - phased: switches pattern every 500 requests
- **Textbook string:** used to check the simulator against known answers.
- **Sensitivity labels:** every page gets S0–S3 (70/15/10/5%), assigned by us.

Why generated data:

- the true pattern is known, so the detector can be checked;
- one factor can be changed at a time;
- the data is fully reproducible;
- public traces have no secrecy labels.

Limitation: the traces are not real program traces. A next step is to record real ones (e.g. Valgrind Lackey). `graphs/0_dataset.png` and the UI's Dataset tab show the workloads.

## Run it

```sh
gcc -o sim aniruddh/*.c aditya/*.c
./sim --test                  # 27 automatic checks
./sim                         # Experiment 1: all workloads and memory sizes
./sim --experiments           # Experiments 2-6
./sim --seed 7                # different random workloads
./sim --csv > results.csv     # everything as one CSV
python3 aniruddh/plot.py      # graphs in graphs/ (needs matplotlib)
python3 aditya/ui.py          # interactive workbench in the browser (standard library only)
```

## Interactive workbench (UI)

`python3 aditya/ui.py` compiles `sim` if needed, starts a server on `localhost` and opens the browser. Every number shown comes from `./sim`:

- `--trace` outputs one run as JSON.
- `--inspect T` outputs the memory state and decision at request T.
- `--params` outputs the parameters.

| Tab | What it shows |
|---|---|
| Overview | the idea, the formula, headline results against LRU, and what it costs |
| Dataset | how the workloads are generated, plotted request by request, with a CSV download |
| Live demo | step through a run; for each eviction: which page came in, which left, why, with each page's score |
| Compare | all five algorithms on the same workload, as bar charts and a table |
| Results | the six experiments one at a time, including "Where it is worse" |
| How it works | the four steps of the algorithm; runs the 27 checks live |

Keys: `←` `→` step, `space` play, `E` next eviction, `S` next security event, `1`–`6` switch tab. The **Light** button (top right) switches to a light theme for projectors (`?theme=light` in the address does the same).

With default settings the app shows exactly the numbers in the report and slides.

## Results (seed 42, 5 workloads × 5 memory sizes)

| Algorithm | Page faults | Secret evictions (S2+S3) | Top-secret evictions (S3) |
|---|---|---|---|
| LRU | 85,765 | 18,218 | 7,400 |
| Optimal | 62,672 | 13,276 | 5,365 |
| **Adaptive** | **73,837 (−14%)** | **8,764 (−52%)** | **1,725 (−77%)** |

- Close to Optimal on looping and sequential workloads, where FIFO, LRU and LFU fault on every request.
- Bursty workloads: about 4% more faults than LRU on average (up to 8% for the worst seed).
- About 0.9 µs per eviction decision, against 0.04 µs for LRU.

## Who did what

The work is split by the two phases in our presentation.

**Aniruddh — Phase 1: the simulator** (`aniruddh/`)

| File | What it is |
|---|---|
| `sim.h` | shared constants, state and function list |
| `workload.c` | the five workloads (the dataset) and the S0–S3 sensitivity labels |
| `simulator.c` | memory frames, FIFO, LRU, LFU, Optimal and the simulation loop |
| `tests.c` | the 27 automatic checks (`./sim --test`) |
| `experiments.c` | the six experiments, table and CSV output |
| `plot.py` | draws the graphs from `results.csv` |

**Aditya — Phase 2: the Adaptive algorithm and the demo** (`aditya/`)

| File | What it is |
|---|---|
| `adaptive.c` | pattern detection, the R, F, B, W, S scores, security rules and feedback |
| `main.c` | command line options and the JSON output used by the UI |
| `ui.py`, `ui/` | interactive workbench (server + web page) |

Reports and slides (`docs/`), `results.csv` and `graphs/` are generated or local and are not in the repository.

## Status

- Phase 1, simulator and baselines: done.
- Phase 2, Adaptive algorithm, experiments, graphs, UI and final report: done.

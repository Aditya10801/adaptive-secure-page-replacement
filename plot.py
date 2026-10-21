# Makes the graphs for our report from the simulator's CSV output.
#
#   ./sim --csv > results.csv
#   python3 plot.py
#
# The graphs are saved in the graphs/ folder.

import csv
import os
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

WORKLOADS = ["sequential", "looping", "random", "bursty", "phased"]
ALGOS = ["FIFO", "LRU", "LFU", "Optimal", "Adaptive"]
COLORS = {"FIFO": "#B8C4D6", "LRU": "#8796AC", "LFU": "#4A5568", "Optimal": "#1A2438", "Adaptive": "#F2A541"}

rows = list(csv.DictReader(open("results.csv")))
os.makedirs("graphs", exist_ok=True)


def find(experiment, workload, setting, frames, algo):
    for r in rows:
        if (r["experiment"] == experiment and r["workload"] == workload and r["setting"] == setting
                and r["frames"] == str(frames) and r["algorithm"] == algo):
            return r
    return None


def secret(r):
    return int(r["evict_s2"]) + int(r["evict_s3"])


def grouped_bars(ax, groups, series, values, colors):
    width = 0.8 / len(series)
    for i, name in enumerate(series):
        xs = [g + i * width - 0.4 + width / 2 for g in range(len(groups))]
        ax.bar(xs, values[name], width, label=name, color=colors[name])
    ax.set_xticks(range(len(groups)))
    ax.set_xticklabels(groups)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)


def save(fig, name):
    fig.tight_layout()
    fig.savefig("graphs/" + name, dpi=200)
    plt.close(fig)
    print("saved graphs/" + name)


# 1. page faults of every algorithm, 8 frames
values = {a: [int(find("main", w, "default", 8, a)["faults"]) for w in WORKLOADS] for a in ALGOS}
fig, ax = plt.subplots(figsize=(9, 4.5))
grouped_bars(ax, WORKLOADS, ALGOS, values, COLORS)
ax.set_ylabel("Page faults (lower is better)")
ax.set_title("Page faults with 8 frames")
ax.legend(ncol=5, frameon=False, loc="upper center", bbox_to_anchor=(0.5, -0.1))
save(fig, "1_faults_8_frames.png")

# 2. secret pages (S2 + S3) evicted, 8 frames
values = {a: [secret(find("main", w, "default", 8, a)) for w in WORKLOADS] for a in ALGOS}
fig, ax = plt.subplots(figsize=(9, 4.5))
grouped_bars(ax, WORKLOADS, ALGOS, values, COLORS)
ax.set_ylabel("S2 + S3 pages evicted (lower is better)")
ax.set_title("Secret pages evicted with 8 frames")
ax.legend(ncol=5, frameon=False, loc="upper center", bbox_to_anchor=(0.5, -0.1))
save(fig, "2_secret_evictions_8_frames.png")

# 3. hit rate against memory size, phased workload
frames = [3, 4, 8, 16, 32]
fig, ax = plt.subplots(figsize=(7, 4.5))
for a in ALGOS:
    hit = [float(find("main", "phased", "default", f, a)["hit_rate"]) for f in frames]
    ax.plot(frames, hit, marker="o", label=a, color=COLORS[a], linewidth=2.5 if a == "Adaptive" else 1.5)
ax.set_xscale("log", base=2)
ax.set_xticks(frames)
ax.set_xticklabels(frames)
ax.set_xlabel("Frames in memory")
ax.set_ylabel("Hit rate (%)")
ax.set_title("Phased workload: hit rate against memory size")
ax.legend(frameon=False)
ax.spines["top"].set_visible(False)
ax.spines["right"].set_visible(False)
save(fig, "3_phased_hit_rate.png")

# 4. share of sensitive pages: faults and secret evictions, LRU against Adaptive
percents = ["0%", "10%", "25%", "50%"]
fig, axes = plt.subplots(1, 2, figsize=(10, 4))
for col, w in enumerate(["phased", "bursty"]):
    ax = axes[col]
    for a, style in [("LRU", "--"), ("Adaptive", "-")]:
        f = [int(find("amount", w, p, 8, a)["faults"]) for p in percents]
        s = [secret(find("amount", w, p, 8, a)) for p in percents]
        ax.plot(percents, f, style, marker="o", color="#1A2438", label=a + " faults")
        ax.plot(percents, s, style, marker="s", color="#F2A541", label=a + " secret evictions")
    ax.set_title(w + " workload, 8 frames")
    ax.set_xlabel("Share of sensitive pages")
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
axes[0].set_ylabel("Count")
axes[1].legend(frameon=False, fontsize=8)
save(fig, "4_share_of_sensitive_pages.png")

# 5. ablation: what each part adds (phased, 8 frames)
variants = [("LRU", "-", "LRU"), ("Adaptive", "full", "full"), ("Adaptive", "no-security", "no security"),
            ("Adaptive", "no-behaviour", "no behaviour"), ("Adaptive", "no-feedback", "no feedback")]
labels = [v[2] for v in variants]
f = [int(find("ablation", "phased", v[1], 8, v[0])["faults"]) for v in variants]
s = [secret(find("ablation", "phased", v[1], 8, v[0])) for v in variants]
fig, axes = plt.subplots(1, 2, figsize=(10, 4))
axes[0].bar(labels, f, color="#1A2438")
axes[0].set_title("Page faults")
axes[1].bar(labels, s, color="#F2A541")
axes[1].set_title("Secret pages evicted")
for ax in axes:
    ax.tick_params(axis="x", rotation=20)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
fig.suptitle("Phased workload, 8 frames: turning parts of Adaptive off")
save(fig, "5_ablation.png")

# 6. running time per eviction
fig, ax = plt.subplots(figsize=(7, 4))
per_eviction = []
for a in ALGOS:
    r = find("overhead", "phased", "-", 8, a)
    per_eviction.append(float(r["time_us"]) / (int(r["faults"]) - 8))
ax.bar(ALGOS, per_eviction, color=[COLORS[a] for a in ALGOS])
ax.set_ylabel("Microseconds per eviction")
ax.set_title("Running time (phased workload, 8 frames, average of 20 runs)")
ax.spines["top"].set_visible(False)
ax.spines["right"].set_visible(False)
save(fig, "6_running_time.png")

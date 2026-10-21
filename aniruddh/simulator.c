// Memory frames, the classic algorithms (FIFO, LRU, LFU, Optimal) and the simulation loop.

#include <stdio.h>
#include <time.h>
#include "sim.h"

char *algo_names[] = {"FIFO", "LRU", "LFU", "Optimal", "B-only", "Adaptive"};

int frames[MAX_FRAMES];
int nframes;
int used;
int loaded_at[MAX_PAGES];
int last_used[MAX_PAGES];
int freq[MAX_PAGES];

int faults, hits;
int evicted[4];
double time_us;


/* ================= ALGORITHMS ================= */
// Each function returns the index of the frame to replace.

int fifo_victim() {
    int victim = 0;
    for (int j = 1; j < nframes; j++) {
        if (loaded_at[frames[j]] < loaded_at[frames[victim]])
            victim = j;
    }
    return victim;
}

int lru_victim() {
    int victim = 0;
    for (int j = 1; j < nframes; j++) {
        if (last_used[frames[j]] < last_used[frames[victim]])
            victim = j;
    }
    return victim;
}

// least frequently used, if equal then least recently used
int lfu_victim() {
    int victim = 0;
    for (int j = 1; j < nframes; j++) {
        int p = frames[j];
        int v = frames[victim];
        if (freq[p] < freq[v] || (freq[p] == freq[v] && last_used[p] < last_used[v]))
            victim = j;
    }
    return victim;
}

// returns when the page will be used next after time t (n if never)
int next_use(int page, int t) {
    for (int i = t + 1; i < n; i++) {
        if (ref[i] == page)
            return i;
    }
    return n;
}

int optimal_victim(int t) {
    int victim = 0;
    int farthest = next_use(frames[0], t);
    for (int j = 1; j < nframes; j++) {
        int next = next_use(frames[j], t);
        if (next > farthest) {
            farthest = next;
            victim = j;
        }
    }
    return victim;
}

int choose_victim(int algo, int t) {
    if (algo == FIFO)
        return fifo_victim();
    if (algo == LRU)
        return lru_victim();
    if (algo == LFU)
        return lfu_victim();
    if (algo == OPTIMAL)
        return optimal_victim(t);
    if (algo == BEHAVIOUR_ONLY)
        return behaviour_victim(t);
    return adaptive_victim(t);
}


/* ================= SIMULATOR ================= */

// returns frame index of the page, or -1 if the page is not in memory
int find(int page) {
    for (int i = 0; i < used; i++) {
        if (frames[i] == page)
            return i;
    }
    return -1;
}

// Runs one algorithm on the current workload with the given number of frames.
void run(int algo, int num_frames) {
    nframes = num_frames;
    used = 0;
    faults = 0;
    hits = 0;
    for (int i = 0; i < 4; i++)
        evicted[i] = 0;
    for (int p = 0; p < MAX_PAGES; p++) {
        loaded_at[p] = 0;
        last_used[p] = 0;
        freq[p] = 0;
    }
    wS = WS_START;
    interval_faults = 0;
    fb_count = 0;

    clock_t start = clock();

    for (int t = 0; t < n; t++) {
        int page = ref[t];
        if (t == inspect_at && !trace)
            print_state(algo, t);

        int f = find(page);
        int hit = (f != -1);
        int victim_page = -1;
        if (hit) {
            hits++;
        } else {
            faults++;
            interval_faults++;
            if (used < nframes) {
                f = used;    // free frame available
                used++;
            } else {
                f = choose_victim(algo, t);
                victim_page = frames[f];
                evicted[sens[victim_page]]++;
            }
            frames[f] = page;
            loaded_at[page] = t;
            freq[page] = 0;
        }

        last_used[page] = t;
        freq[page]++;

        if (algo == ADAPTIVE && use_feedback && (t + 1) % FEEDBACK_INTERVAL == 0)
            feedback_update(t);

        if (trace) {
            // one event per request: [hit, frame, evicted page, detected pattern, flags]
            // flags: 1 = every page was protected, 2 = the security part changed the choice
            int flags = 0;
            if (algo == ADAPTIVE && victim_page >= 0) {
                if (last_fallback)
                    flags += 1;
                if (last_no_security != victim_page)
                    flags += 2;
            }
            if (t > 0)
                printf(",");
            if (t % 20 == 0)
                printf("\n");
            printf("[%d,%d,%d,%d,%d]", hit, f, victim_page, detect_behaviour(t), flags);
        }
    }

    time_us = (double)(clock() - start) * 1000000 / CLOCKS_PER_SEC;
}

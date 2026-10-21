/*
 * Security- and Behaviour-Aware Adaptive Page Replacement
 * OS Project - Aditya & Aniruddh
 *
 * Phase 1: page replacement simulator with FIFO, LRU, LFU and Optimal
 * Phase 2: our Adaptive algorithm. Every page gets an eviction score
 *
 *     Score(p) = wR*R + wF*F + wB*B + wW*W - wS*S
 *
 *   R = recency, F = frequency, B = behaviour, W = working set, S = sensitivity.
 *   The page with the highest score is evicted. Top-secret pages that are in use
 *   are never evicted (unless every page in memory is protected), and the
 *   security weight wS is adjusted every 100 requests using the page fault rate.
 *
 * Compile: gcc -o sim sim.c
 * Run:     ./sim                -> results table (all workloads, all algorithms)
 *          ./sim --experiments  -> the experiments from our report
 *          ./sim --csv          -> everything in CSV format (for graphs)
 *          ./sim --seed 7       -> use different random workloads
 *          ./sim --test         -> run all checks
 *
 * Used by the UI (ui.py), output is JSON:
 *          ./sim --trace --algo Adaptive --workload phased --frames 8 --length 1000
 *          ./sim --inspect 250 (same options)   -> memory state and decision at request 250
 *          ./sim --params                       -> all parameters of the algorithm
 *   other options: --place hot|warm|cold|random --percent 15
 *                  --weights 0.2,0.2,1.0,0.3  --no-security --no-behaviour --no-feedback
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define MAX_REFS   5000
#define MAX_PAGES  64
#define MAX_FRAMES 32
#define WINDOW     32    // number of recent references used to detect behaviour
#define WS_WINDOW  32    // working set window (delta): pages used in the last 32 requests

// access patterns
#define CLASSIC    0
#define SEQUENTIAL 1
#define LOOPING    2
#define RANDOM     3
#define BURSTY     4
#define PHASED     5

// algorithms
#define FIFO           0
#define LRU            1
#define LFU            2
#define OPTIMAL        3
#define BEHAVIOUR_ONLY 4
#define ADAPTIVE       5

// how sensitive pages are placed in the experiments
#define PLACE_RANDOM 0
#define PLACE_HOT    1   // the most used pages are sensitive
#define PLACE_WARM   2   // pages in the middle are sensitive
#define PLACE_COLD   3   // the least used pages are sensitive

char *pattern_names[] = {"classic", "sequential", "looping", "random", "bursty", "phased"};
char *algo_names[] = {"FIFO", "LRU", "LFU", "Optimal", "B-only", "Adaptive"};
char *place_names[] = {"random", "hot", "warm", "cold"};

// weights of the eviction score (chosen by experiment, see report).
// They are variables so the UI can change them with --weights.
double w_recency   = 0.2;
double w_frequency = 0.2;
double w_behaviour = 1.0;
double w_workset   = 0.3;

// security weight wS is changed by feedback between WS_MIN and WS_MAX
#define WS_START 1.0
#define WS_MIN   0.5
#define WS_MAX   2.0
#define WS_STEP  0.25
#define COLD_SECRET 0.5         // a secret page outside the working set keeps only half of its S
#define FEEDBACK_INTERVAL 100   // check the fault rate every 100 requests
#define HIGH_FAULT_RATE   0.30  // above this: memory pressure, security gives a little
#define LOW_FAULT_RATE    0.15  // below this: memory is fine, protect secrets more

// current workload
char *workload_name;
int ref[MAX_REFS];     // page reference string
int n;                 // length of reference string
int npages;            // pages are numbered 0 to npages-1
int sens[MAX_PAGES];   // sensitivity level of each page: 0 = S0 (public) ... 3 = S3 (top secret)

// memory state
int frames[MAX_FRAMES];
int nframes;           // total frames
int used;              // frames filled so far
int loaded_at[MAX_PAGES];
int last_used[MAX_PAGES];
int freq[MAX_PAGES];

// filled by prepare_scores() before each eviction decision
int oldest_use, newest_use, max_freq;

// state of the Adaptive algorithm
double wS;             // current security weight
int interval_faults;   // faults since the last feedback check
int use_security = 1;  // these three switches are only turned off in experiments
int use_behaviour = 1;
int use_feedback = 1;

// UI / trace mode
int trace = 0;          // 1 = print every request as JSON
int inspect_at = -1;    // print the memory state just before this request
int ref_length = 5000;  // number of requests in generated workloads
int last_fallback = 0;  // last Adaptive decision: every page was protected
int last_no_security = -1;   // last Adaptive decision: page it would evict without the security part
int fb_count = 0;       // feedback changes during the last run
int fb_t[MAX_REFS / FEEDBACK_INTERVAL + 1];
double fb_rate[MAX_REFS / FEEDBACK_INTERVAL + 1];
double fb_old[MAX_REFS / FEEDBACK_INTERVAL + 1];
double fb_new[MAX_REFS / FEEDBACK_INTERVAL + 1];

// results of the last run
int faults, hits;
int evicted[4];        // number of evicted pages of each sensitivity level (S3 = secure evictions)
double time_us;


/* ================= WORKLOADS ================= */

// Gives every page a sensitivity level.
// 70% S0, 15% S1, 10% S2, 5% S3
void assign_sensitivity() {
    for (int p = 0; p < npages; p++) {
        int x = rand() % 100;
        if (x < 70)
            sens[p] = 0;
        else if (x < 85)
            sens[p] = 1;
        else if (x < 95)
            sens[p] = 2;
        else
            sens[p] = 3;
    }
}

// Used in experiments: makes `percent` % of the pages sensitive (one third S3, the rest S2),
// all other pages S0. `placement` decides which pages are chosen.
void label_pages(int placement, int percent) {
    int count[MAX_PAGES] = {0};
    int order[MAX_PAGES];
    for (int i = 0; i < n; i++)
        count[ref[i]]++;
    for (int p = 0; p < npages; p++)
        order[p] = p;

    if (placement == PLACE_RANDOM) {
        // shuffle the pages
        for (int i = npages - 1; i > 0; i--) {
            int j = rand() % (i + 1);
            int tmp = order[i];
            order[i] = order[j];
            order[j] = tmp;
        }
    } else {
        // sort pages from most used to least used (selection sort)
        for (int i = 0; i < npages; i++) {
            int best = i;
            for (int j = i + 1; j < npages; j++) {
                if (count[order[j]] > count[order[best]])
                    best = j;
            }
            int tmp = order[i];
            order[i] = order[best];
            order[best] = tmp;
        }
    }

    int k = npages * percent / 100;   // number of sensitive pages
    int start = 0;                    // PLACE_HOT and PLACE_RANDOM take the first k
    if (placement == PLACE_COLD)
        start = npages - k;
    else if (placement == PLACE_WARM)
        start = (npages - k) / 2;

    for (int p = 0; p < npages; p++)
        sens[p] = 0;
    for (int i = 0; i < k; i++) {
        if (i % 3 == 0)
            sens[order[start + i]] = 3;
        else
            sens[order[start + i]] = 2;
    }
}

// Loads a fixed reference string (used for the classic example and the tests)
void load_string(int arr[], int len) {
    n = len;
    npages = 0;
    for (int i = 0; i < n; i++) {
        ref[i] = arr[i];
        if (ref[i] + 1 > npages)
            npages = ref[i] + 1;
    }
    assign_sensitivity();
}

// Creates a reference string of 5000 requests over 64 pages with the given pattern.
// PHASED switches between sequential, looping, random and bursty every 500 requests.
void make_workload(int pattern) {
    workload_name = pattern_names[pattern];
    if (pattern == CLASSIC) {
        int classic[] = {1, 2, 3, 4, 1, 2, 5, 1, 2, 3, 4, 5,
                         6, 3, 2, 1, 4, 5, 6, 7, 1, 2, 3, 4, 5};
        load_string(classic, 25);
        return;
    }

    n = ref_length;
    npages = 64;
    int hot = 0;   // start of the current hot area (bursty)

    for (int i = 0; i < n; i++) {
        int phase = i / 500;
        int kind = pattern;
        if (pattern == PHASED)
            kind = SEQUENTIAL + phase % 4;

        int page;
        if (kind == SEQUENTIAL) {
            page = i % npages;                  // go through all pages in order
        } else if (kind == LOOPING) {
            page = i % 12;                      // loop over the same 12 pages
        } else if (kind == RANDOM) {
            page = rand() % npages;             // any page
        } else {
            // BURSTY: 90% of requests go to a group of 6 pages, the group moves every 50 requests
            if (i % 50 == 0)
                hot = rand() % (npages - 6);
            if (rand() % 10 < 9)
                page = hot + rand() % 6;
            else
                page = rand() % npages;
        }

        if (pattern == PHASED)
            page = (page + phase * 13) % npages;   // each phase uses a different part of memory

        ref[i] = page;
    }
    assign_sensitivity();
}


/* ================= BEHAVIOUR SCORE ================= */

// Looks at the last WINDOW requests (up to time t) and decides the access pattern.
// Returns LOOPING, SEQUENTIAL, BURSTY or RANDOM.
int detect_behaviour(int t) {
    int start = t - WINDOW + 1;
    if (start < 1)
        start = 1;
    int len = t - start + 1;
    if (len < 8)
        return RANDOM;   // not enough history yet

    // 1. Looping: does the window repeat itself every L steps?
    for (int L = 2; L <= len / 2; L++) {
        int match = 0;
        for (int i = start + L; i <= t; i++) {
            if (ref[i] == ref[i - L])
                match++;
        }
        if (match >= 0.9 * (len - L))
            return LOOPING;
    }

    // 2. Sequential: does each request go to the next page?
    int seq = 0;
    for (int i = start; i <= t; i++) {
        if (ref[i] == ref[i - 1] + 1)
            seq++;
    }
    if (seq >= 0.8 * len)
        return SEQUENTIAL;

    // 3. Bursty: are only a few different pages being used?
    int seen[MAX_PAGES] = {0};
    int distinct = 0;
    for (int i = start; i <= t; i++) {
        if (seen[ref[i]] == 0) {
            seen[ref[i]] = 1;
            distinct++;
        }
    }
    if (distinct <= len / 2)
        return BURSTY;

    return RANDOM;
}

// Finds the oldest and newest last use and the highest use count of the pages
// in memory. Done once per eviction instead of once per page.
void prepare_scores() {
    oldest_use = last_used[frames[0]];
    newest_use = last_used[frames[0]];
    max_freq = 1;
    for (int j = 0; j < nframes; j++) {
        int p = frames[j];
        if (last_used[p] < oldest_use)
            oldest_use = last_used[p];
        if (last_used[p] > newest_use)
            newest_use = last_used[p];
        if (freq[p] > max_freq)
            max_freq = freq[p];
    }
}

// How recently a page was used compared to the other pages in memory.
// 0 = used longest ago, 1 = used most recently
double recency_rank(int page) {
    if (newest_use == oldest_use)
        return 1.0;
    return (double)(last_used[page] - oldest_use) / (newest_use - oldest_use);
}

// Behaviour score B of a page in memory, between 0 and 1.
// Higher score = better page to evict.
double behaviour_score(int page, int behaviour, int t) {
    double recency = recency_rank(page);

    if (behaviour == SEQUENTIAL) {
        // the page just read will be needed again only after the whole scan -> evict it
        return recency;
    }
    if (behaviour == LOOPING) {
        // pages not used in the window are not part of the loop -> evict them first
        if (t - last_used[page] > WINDOW)
            return 1.0;
        // inside the loop the page just used is needed last -> evict it
        return 0.9 * recency;
    }
    if (behaviour == BURSTY) {
        // keep the pages currently being used, evict the old ones (like LRU)
        return 1 - recency;
    }
    // RANDOM: behaviour gives no information, other scores will decide
    return 0.5;
}


/* ================= OTHER SCORES (R, F, W, S) ================= */
// All scores are between 0 and 1. Higher = better page to evict.

// R: pages not used for a long time are good to evict
double recency_score(int page) {
    return 1 - recency_rank(page);
}

// F: pages used only a few times since they were loaded are good to evict
double frequency_score(int page) {
    return 1 - (double)freq[page] / max_freq;
}

// W: 1 if the page is outside the working set (not used in the last WS_WINDOW requests)
double workset_score(int page, int t) {
    if (t - last_used[page] > WS_WINDOW)
        return 1.0;
    return 0.0;
}

// S: how much we want to keep the page for security. S0/S1 = 0, S2 = 0.5, S3 = 1.
// A secret page that is not being used (outside the working set) keeps only a small
// part of its S: evicting it once is better than letting it block memory forever.
// A secret page that IS being used would be evicted and loaded again and again,
// and every eviction can write it to disk, so those are the ones we protect.
double security_score(int page, int t) {
    double s = 0.0;
    if (sens[page] == 3)
        s = 1.0;
    else if (sens[page] == 2)
        s = 0.5;
    if (workset_score(page, t) == 1.0)
        s = s * COLD_SECRET;
    return s;
}

// A top-secret (S3) page that is in the working set must not be evicted
int is_protected(int page, int t) {
    return sens[page] == 3 && workset_score(page, t) == 0.0;
}

// Score(p) = wR*R + wF*F + wB*B + wW*W - wS*S
double eviction_score(int page, int behaviour, int t) {
    double score = w_recency * recency_score(page)
                 + w_frequency * frequency_score(page)
                 + w_behaviour * behaviour_score(page, behaviour, t)
                 + w_workset * workset_score(page, t);
    if (use_security)
        score = score - wS * security_score(page, t);
    return score;
}

// Feedback, called every FEEDBACK_INTERVAL requests.
// Many faults -> memory is under pressure -> lower wS so cold secret pages can leave.
// Few faults  -> memory is fine -> raise wS to protect secret pages more.
void feedback_update(int t) {
    double fault_rate = (double)interval_faults / FEEDBACK_INTERVAL;
    double old = wS;
    if (fault_rate > HIGH_FAULT_RATE && wS > WS_MIN)
        wS = wS - WS_STEP;
    else if (fault_rate < LOW_FAULT_RATE && wS < WS_MAX)
        wS = wS + WS_STEP;
    interval_faults = 0;

    // remember every check for the UI
    fb_t[fb_count] = t;
    fb_rate[fb_count] = fault_rate;
    fb_old[fb_count] = old;
    fb_new[fb_count] = wS;
    fb_count++;
}


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

// uses only the behaviour score (for testing the score, not the final algorithm)
int behaviour_victim(int t) {
    prepare_scores();
    int behaviour = detect_behaviour(t);
    int victim = 0;
    double best = behaviour_score(frames[0], behaviour, t);
    for (int j = 1; j < nframes; j++) {
        double score = behaviour_score(frames[j], behaviour, t);
        if (score > best) {
            best = score;
            victim = j;
        }
    }
    return victim;
}

// Returns the frame whose page has the highest eviction score.
// If skip_protected is 1, protected pages are not considered (-1 if all are protected).
int best_frame(int behaviour, int t, int skip_protected) {
    int victim = -1;
    double best = 0;
    for (int j = 0; j < nframes; j++) {
        if (skip_protected && is_protected(frames[j], t))
            continue;
        double score = eviction_score(frames[j], behaviour, t);
        if (victim == -1 || score > best) {
            best = score;
            victim = j;
        }
    }
    return victim;
}

// Our algorithm: evict the page with the highest eviction score.
// Protected pages (top-secret pages in use) are skipped. If every page is
// protected there is no other choice, so all pages are considered and the
// S3 page that leaves is counted as a secure eviction.
int adaptive_victim(int t) {
    prepare_scores();
    int behaviour = RANDOM;          // RANDOM gives every page the same B, so B has no effect
    if (use_behaviour)
        behaviour = detect_behaviour(t);

    last_fallback = 0;
    int victim = best_frame(behaviour, t, use_security);
    if (victim == -1) {
        // every page is protected: pick the best one anyway (memory must be freed)
        last_fallback = 1;
        victim = best_frame(behaviour, t, 0);
    }

    // for the UI: which page would be evicted without the security part?
    if (trace || inspect_at == t) {
        int saved = use_security;
        use_security = 0;
        last_no_security = frames[best_frame(behaviour, t, 0)];
        use_security = saved;
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

// Prints the memory state just before request t as JSON (used by the UI inspector).
// If request t needs an eviction, it also prints which page the algorithm picks.
void print_state(int algo, int t) {
    int page = ref[t];
    int hit = (find(page) != -1);
    int decision = (!hit && used == nframes);
    int victim = -1;
    if (decision)
        victim = choose_victim(algo, t);     // the same choice the simulator is about to make
    if (used > 0)
        prepare_scores();
    int behaviour = detect_behaviour(t);
    int b = behaviour;
    if (!use_behaviour)
        b = RANDOM;

    printf("{\"t\":%d,\"request\":%d,\"request_sens\":%d,\"hit\":%d,\"decision\":%d,",
           t, page, sens[page], hit, decision);
    printf("\"behaviour\":\"%s\",\"wS\":%.2f,\"used\":%d,\"frames\":[", pattern_names[behaviour], wS, used);
    for (int j = 0; j < used; j++) {
        int p = frames[j];
        if (j > 0)
            printf(",");
        printf("{\"frame\":%d,\"page\":%d,\"sens\":%d,\"loaded\":%d,\"last\":%d,\"freq\":%d,\"in_ws\":%d",
               j, p, sens[p], loaded_at[p], last_used[p], freq[p], workset_score(p, t) == 0.0);
        if (algo == ADAPTIVE && used == nframes) {
            printf(",\"protected\":%d,\"R\":%.3f,\"F\":%.3f,\"B\":%.3f,\"W\":%.0f,\"S\":%.3f,\"score\":%.3f",
                   use_security && is_protected(p, t), recency_score(p), frequency_score(p),
                   behaviour_score(p, b, t), workset_score(p, t), security_score(p, t), eviction_score(p, b, t));
        }
        if (algo == OPTIMAL)
            printf(",\"next_use\":%d", next_use(p, t));
        printf("}");
    }
    printf("],\"victim_frame\":%d,\"victim_page\":%d", victim, victim >= 0 ? frames[victim] : -1);
    if (algo == ADAPTIVE && decision)
        printf(",\"fallback\":%d,\"no_security_page\":%d", last_fallback, last_no_security);
    printf("}\n");
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


/* ================= TESTS ================= */

int passed = 0, failed = 0;

void check(char *name, int ok) {
    if (ok) {
        printf("PASS  %s\n", name);
        passed++;
    } else {
        printf("FAIL  %s\n", name);
        failed++;
    }
}

int run_tests() {
    // Textbook answers for 1 2 3 4 1 2 5 1 2 3 4 5
    int belady[] = {1, 2, 3, 4, 1, 2, 5, 1, 2, 3, 4, 5};
    load_string(belady, 12);
    run(FIFO, 3);    check("FIFO, 3 frames = 9 faults", faults == 9);
    run(FIFO, 4);    check("FIFO, 4 frames = 10 faults (Belady's anomaly)", faults == 10);
    run(LRU, 3);     check("LRU, 3 frames = 10 faults", faults == 10);
    run(LRU, 4);     check("LRU, 4 frames = 8 faults", faults == 8);
    run(OPTIMAL, 3); check("Optimal, 3 frames = 7 faults", faults == 7);
    run(OPTIMAL, 4); check("Optimal, 4 frames = 6 faults", faults == 6);

    // A top-secret page used every 4th request, with 3 frames.
    // LRU throws it out every time; Adaptive must keep it.
    int secret[60];
    for (int i = 0; i < 60; i++) {
        if (i % 4 == 0)
            secret[i] = 0;
        else
            secret[i] = 1 + i % 7;
    }
    load_string(secret, 60);
    for (int p = 0; p < npages; p++)
        sens[p] = 0;
    sens[0] = 3;
    run(LRU, 3);      int lru_s3 = evicted[3];
    run(ADAPTIVE, 3); int ad_s3 = evicted[3];
    check("Adaptive never evicts a top-secret page that is in use (LRU does)", lru_s3 > 0 && ad_s3 == 0);

    char name[200];
    for (int k = CLASSIC; k <= PHASED; k++) {
        make_workload(k);

        // No algorithm can beat Optimal, and the counts must add up
        int ok = 1;
        for (int f = 2; f <= 32 && f < npages; f = f * 2) {
            run(OPTIMAL, f);
            int best = faults;
            for (int a = FIFO; a <= ADAPTIVE; a++) {
                run(a, f);
                int total_evicted = evicted[0] + evicted[1] + evicted[2] + evicted[3];
                if (faults < best || hits + faults != n || total_evicted != faults - used)
                    ok = 0;
            }
        }
        sprintf(name, "%s: Optimal is always best, counts add up", pattern_names[k]);
        check(name, ok);

        if (k == CLASSIC)
            continue;

        // Behaviour detection should be right at least 90% of the time.
        // The first WINDOW requests of every 500 are skipped because the window
        // still contains the previous pattern there.
        int correct = 0, total = 0;
        for (int t = 0; t < n; t++) {
            if (t % 500 < WINDOW)
                continue;
            int truth = k;
            if (k == PHASED)
                truth = SEQUENTIAL + (t / 500) % 4;
            if (detect_behaviour(t) == truth)
                correct++;
            total++;
        }
        sprintf(name, "%s: behaviour detected correctly %.1f%% of the time",
                pattern_names[k], 100.0 * correct / total);
        check(name, correct >= 0.9 * total);

        // Behaviour score alone compared with LRU and Optimal (8 frames)
        run(LRU, 8);            int lru_faults = faults;
        run(BEHAVIOUR_ONLY, 8); int b_faults = faults;
        run(OPTIMAL, 8);        int opt_faults = faults;
        sprintf(name, "%s, 8 frames: LRU %d faults, B-only %d, Optimal %d",
                pattern_names[k], lru_faults, b_faults, opt_faults);
        if (k == SEQUENTIAL || k == LOOPING || k == PHASED)
            check(name, b_faults < lru_faults);   // B must beat LRU when there is a pattern
        else
            printf("      %s\n", name);

        // Adaptive compared with LRU (8 frames)
        run(LRU, 8);
        int lru_secret = evicted[2] + evicted[3];
        run(ADAPTIVE, 8);
        int ad_secret = evicted[2] + evicted[3];
        int ok_ws = (wS >= WS_MIN && wS <= WS_MAX);
        int fewer_secret = (ad_secret < lru_secret || lru_secret == 0);
        sprintf(name, "%s, 8 frames: Adaptive %d faults (LRU %d), secret pages evicted %d (LRU %d)",
                pattern_names[k], faults, lru_faults, ad_secret, lru_secret);
        if (k == SEQUENTIAL || k == LOOPING || k == PHASED)
            check(name, faults < lru_faults && fewer_secret && ok_ws);
        else   // no pattern to use here: protecting secrets may cost at most 10% more faults than LRU
            check(name, faults <= 1.10 * lru_faults && fewer_secret && ok_ws);

        // the security part must be what protects the secret pages
        if (k == PHASED) {
            use_security = 0;
            run(ADAPTIVE, 8);
            use_security = 1;
            sprintf(name, "phased: without the security score %d secret pages are evicted (with it %d)",
                    evicted[2] + evicted[3], ad_secret);
            check(name, evicted[2] + evicted[3] > ad_secret);
        }
    }

    printf("\n%d passed, %d failed\n", passed, failed);
    if (failed > 0)
        return 1;
    return 0;
}


/* ================= EXPERIMENTS ================= */

int csv = 0;    // 1 = print CSV rows instead of tables
int seed = 42;

void print_header(char *title) {
    if (csv)
        return;
    printf("\n=== %s ===\n", title);
    printf("%-10s %-13s %6s %-9s %7s %7s %6s %6s %6s %6s %9s\n", "workload", "setting", "frames",
           "algorithm", "faults", "hit%", "evS0", "evS1", "evS2", "evS3", "time_us");
}

// prints the result of the last run as one row
void report(char *experiment, char *setting, int f, int algo) {
    double hit_rate = 100.0 * hits / n;
    if (csv)
        printf("%s,%s,%s,%d,%s,%d,%d,%.2f,%d,%d,%d,%d,%.1f\n", experiment, workload_name, setting, f,
               algo_names[algo], faults, hits, hit_rate, evicted[0], evicted[1], evicted[2], evicted[3], time_us);
    else
        printf("%-10s %-13s %6d %-9s %7d %6.2f%% %6d %6d %6d %6d %9.1f\n", workload_name, setting, f,
               algo_names[algo], faults, hit_rate, evicted[0], evicted[1], evicted[2], evicted[3], time_us);
}

// Experiment 1: every workload, every algorithm, different memory sizes
void main_table() {
    int algos[] = {FIFO, LRU, LFU, OPTIMAL, ADAPTIVE};
    int frame_counts[] = {3, 4, 8, 16, 32};
    srand(seed);
    print_header("Experiment 1: all workloads and memory sizes");
    for (int k = CLASSIC; k <= PHASED; k++) {
        make_workload(k);   // same workload is used for all algorithms
        for (int i = 0; i < 5; i++) {
            if (frame_counts[i] >= npages)
                continue;
            for (int a = 0; a < 5; a++) {
                run(algos[a], frame_counts[i]);
                report("main", "default", frame_counts[i], algos[a]);
            }
        }
        if (!csv)
            printf("\n");
    }
}

// Experiment 2: are sensitive pages hot, warm or cold? (15% of pages sensitive, 8 frames)
void exp_placement() {
    int workloads[] = {BURSTY, PHASED, RANDOM};
    int algos[] = {LRU, OPTIMAL, ADAPTIVE};
    srand(seed);
    print_header("Experiment 2: where the sensitive pages are (15% sensitive, 8 frames)");
    for (int w = 0; w < 3; w++) {
        make_workload(workloads[w]);
        for (int pl = PLACE_RANDOM; pl <= PLACE_COLD; pl++) {
            label_pages(pl, 15);
            for (int a = 0; a < 3; a++) {
                run(algos[a], 8);
                report("placement", place_names[pl], 8, algos[a]);
            }
        }
    }
}

// Experiment 3: how many pages are sensitive (random placement, 8 frames)
void exp_amount() {
    int workloads[] = {BURSTY, PHASED};
    int percents[] = {0, 10, 25, 50};
    char setting[20];
    srand(seed);
    print_header("Experiment 3: share of sensitive pages (8 frames)");
    for (int w = 0; w < 2; w++) {
        make_workload(workloads[w]);
        for (int i = 0; i < 4; i++) {
            label_pages(PLACE_RANDOM, percents[i]);
            sprintf(setting, "%d%%", percents[i]);
            run(LRU, 8);
            report("amount", setting, 8, LRU);
            run(ADAPTIVE, 8);
            report("amount", setting, 8, ADAPTIVE);
        }
    }
}

// Experiment 4: what each part of our algorithm adds (8 frames)
void exp_ablation() {
    int workloads[] = {BURSTY, PHASED, RANDOM};
    srand(seed);
    print_header("Experiment 4: turning parts of the Adaptive algorithm off (8 frames)");
    for (int w = 0; w < 3; w++) {
        make_workload(workloads[w]);
        run(LRU, 8);
        report("ablation", "-", 8, LRU);
        run(ADAPTIVE, 8);
        report("ablation", "full", 8, ADAPTIVE);

        use_security = 0;
        run(ADAPTIVE, 8);
        report("ablation", "no-security", 8, ADAPTIVE);
        use_security = 1;

        use_behaviour = 0;
        run(ADAPTIVE, 8);
        report("ablation", "no-behaviour", 8, ADAPTIVE);
        use_behaviour = 1;

        use_feedback = 0;
        run(ADAPTIVE, 8);
        report("ablation", "no-feedback", 8, ADAPTIVE);
        use_feedback = 1;
    }
}

// Experiment 5: running time (phased workload, 8 frames, average of 20 runs)
void exp_overhead() {
    int algos[] = {FIFO, LRU, LFU, OPTIMAL, ADAPTIVE};
    int repeat = 20;
    srand(seed);
    make_workload(PHASED);
    if (!csv) {
        printf("\n=== Experiment 5: running time (phased workload, 8 frames, average of %d runs) ===\n", repeat);
        printf("%-9s %15s %20s\n", "algorithm", "us per run", "us per eviction");
    }
    for (int a = 0; a < 5; a++) {
        double total = 0;
        for (int r = 0; r < repeat; r++) {
            run(algos[a], 8);
            total = total + time_us;
        }
        time_us = total / repeat;
        if (csv)
            report("overhead", "-", 8, algos[a]);
        else
            printf("%-9s %15.1f %20.3f\n", algo_names[algos[a]], time_us, time_us / (faults - 8));
    }
}


// Experiment 6: LRU against Adaptive with 10 different seeds (8 frames), averages
void exp_seeds() {
    int algos[] = {LRU, ADAPTIVE};
    print_header("Experiment 6: average of 10 different seeds (8 frames)");
    for (int k = SEQUENTIAL; k <= PHASED; k++) {
        for (int a = 0; a < 2; a++) {
            int sum_faults = 0, sum_hits = 0, sum_ev[4] = {0, 0, 0, 0};
            double sum_time = 0;
            for (int sd = 1; sd <= 10; sd++) {
                srand(sd);
                make_workload(k);
                run(algos[a], 8);
                sum_faults += faults;
                sum_hits += hits;
                sum_time += time_us;
                for (int i = 0; i < 4; i++)
                    sum_ev[i] += evicted[i];
                if (csv) {
                    char setting[20];
                    sprintf(setting, "seed-%d", sd);
                    report("seeds", setting, 8, algos[a]);
                }
            }
            // put the averages in the result variables and print them
            faults = sum_faults / 10;
            hits = sum_hits / 10;
            time_us = sum_time / 10;
            for (int i = 0; i < 4; i++)
                evicted[i] = sum_ev[i] / 10;
            report("seeds", "avg-10", 8, algos[a]);
        }
    }
}


/* ================= UI OUTPUT (JSON) ================= */

// Prints one whole run as JSON: the workload, one event per request, the feedback
// changes and the totals. ui.py reads this.
void print_trace(int algo, int f, int place, int percent) {
    printf("{\"algorithm\":\"%s\",\"workload\":\"%s\",\"frames\":%d,\"length\":%d,\"seed\":%d,",
           algo_names[algo], workload_name, f, n, seed);
    printf("\"sensitivity\":\"%s\",\"percent\":%d,", place >= 0 ? place_names[place] : "default", percent);
    printf("\"weights\":[%.2f,%.2f,%.2f,%.2f],", w_recency, w_frequency, w_behaviour, w_workset);
    printf("\"security\":%d,\"behaviour\":%d,\"feedback\":%d,", use_security, use_behaviour, use_feedback);
    printf("\"pages\":%d,\"sens\":[", npages);
    for (int p = 0; p < npages; p++)
        printf(p > 0 ? ",%d" : "%d", sens[p]);
    printf("],\"refs\":[");
    for (int i = 0; i < n; i++)
        printf(i > 0 ? ",%d" : "%d", ref[i]);
    printf("],\"events\":[");
    run(algo, f);
    printf("],\"feedback\":[");
    for (int i = 0; i < fb_count; i++) {
        if (i > 0)
            printf(",");
        printf("{\"t\":%d,\"fault_rate\":%.2f,\"old\":%.2f,\"new\":%.2f}", fb_t[i], fb_rate[i], fb_old[i], fb_new[i]);
    }
    printf("],\"faults\":%d,\"hits\":%d,\"evicted\":[%d,%d,%d,%d],\"time_us\":%.1f}\n",
           faults, hits, evicted[0], evicted[1], evicted[2], evicted[3], time_us);
}

// Prints every parameter of the Adaptive algorithm as JSON
void print_params() {
    printf("{\"window\":%d,\"ws_window\":%d,\"weights\":[%.2f,%.2f,%.2f,%.2f],", WINDOW, WS_WINDOW,
           w_recency, w_frequency, w_behaviour, w_workset);
    printf("\"ws_start\":%.2f,\"ws_min\":%.2f,\"ws_max\":%.2f,\"ws_step\":%.2f,", WS_START, WS_MIN, WS_MAX, WS_STEP);
    printf("\"feedback_interval\":%d,\"high_fault_rate\":%.2f,\"low_fault_rate\":%.2f,\"cold_secret\":%.2f,",
           FEEDBACK_INTERVAL, HIGH_FAULT_RATE, LOW_FAULT_RATE, COLD_SECRET);
    printf("\"max_refs\":%d,\"max_frames\":%d,\"max_pages\":%d}\n", MAX_REFS, MAX_FRAMES, MAX_PAGES);
}

// returns the position of name in the list, or -1
int find_name(char *names[], int count, char *name) {
    for (int i = 0; i < count; i++) {
        if (strcmp(names[i], name) == 0)
            return i;
    }
    return -1;
}

int json_error(char *message) {
    printf("{\"error\":\"%s\"}\n", message);
    return 1;
}


/* ================= MAIN ================= */

int main(int argc, char *argv[]) {
    int test = 0;
    int experiments = 0;
    int params = 0;
    int algo = ADAPTIVE;
    int workload = PHASED;
    int num_frames = 8;
    int place = -1;        // -1 = default sensitivity labels
    int percent = 15;
    int bad = 0;

    for (int i = 1; i < argc; i++) {
        int has_value = (i + 1 < argc);
        if (strcmp(argv[i], "--csv") == 0) {
            csv = 1;
        } else if (strcmp(argv[i], "--test") == 0) {
            test = 1;
        } else if (strcmp(argv[i], "--experiments") == 0) {
            experiments = 1;
        } else if (strcmp(argv[i], "--params") == 0) {
            params = 1;
        } else if (strcmp(argv[i], "--trace") == 0) {
            trace = 1;
        } else if (strcmp(argv[i], "--no-security") == 0) {
            use_security = 0;
        } else if (strcmp(argv[i], "--no-behaviour") == 0) {
            use_behaviour = 0;
        } else if (strcmp(argv[i], "--no-feedback") == 0) {
            use_feedback = 0;
        } else if (strcmp(argv[i], "--seed") == 0 && has_value) {
            seed = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--inspect") == 0 && has_value) {
            inspect_at = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--frames") == 0 && has_value) {
            num_frames = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--length") == 0 && has_value) {
            ref_length = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--percent") == 0 && has_value) {
            percent = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--algo") == 0 && has_value) {
            algo = find_name(algo_names, 6, argv[++i]);
            if (algo == -1)
                bad = 1;
        } else if (strcmp(argv[i], "--workload") == 0 && has_value) {
            workload = find_name(pattern_names, 6, argv[++i]);
            if (workload == -1)
                bad = 1;
        } else if (strcmp(argv[i], "--place") == 0 && has_value) {
            place = find_name(place_names, 4, argv[++i]);
            if (place == -1)
                bad = 1;
        } else if (strcmp(argv[i], "--weights") == 0 && has_value) {
            if (sscanf(argv[++i], "%lf,%lf,%lf,%lf", &w_recency, &w_frequency, &w_behaviour, &w_workset) != 4)
                bad = 1;
        } else {
            printf("usage: ./sim [--experiments] [--csv] [--seed N] [--test]\n");
            printf("       ./sim --trace | --inspect T  [--algo A] [--workload W] [--frames F] [--length L]\n");
            printf("             [--place P --percent K] [--weights r,f,b,w] [--no-security] [--no-behaviour] [--no-feedback]\n");
            printf("       ./sim --params\n");
            return 1;
        }
    }

    if (params) {
        print_params();
        return 0;
    }

    if (test) {
        srand(seed);
        return run_tests();
    }

    if (trace || inspect_at >= 0) {
        if (bad)
            return json_error("unknown algorithm, workload, placement or weights");
        if (num_frames < 1 || num_frames > MAX_FRAMES)
            return json_error("frames must be between 1 and 32");
        if (ref_length < 10 || ref_length > MAX_REFS)
            return json_error("length must be between 10 and 5000");
        if (percent < 0 || percent > 100)
            return json_error("percent must be between 0 and 100");
        srand(seed);
        make_workload(workload);
        if (place >= 0)
            label_pages(place, percent);
        if (trace) {
            print_trace(algo, num_frames, place, percent);
        } else {
            if (inspect_at >= n)
                return json_error("request number is past the end of the workload");
            run(algo, num_frames);
        }
        return 0;
    }

    if (csv) {
        // one CSV file with every experiment, used by plot.py and the UI
        printf("experiment,workload,setting,frames,algorithm,faults,hits,hit_rate,evict_s0,evict_s1,evict_s2,evict_s3,time_us\n");
        main_table();
        exp_placement();
        exp_amount();
        exp_ablation();
        exp_overhead();
        exp_seeds();
    } else if (experiments) {
        exp_placement();
        exp_amount();
        exp_ablation();
        exp_overhead();
        exp_seeds();
    } else {
        main_table();
    }
    return 0;
}

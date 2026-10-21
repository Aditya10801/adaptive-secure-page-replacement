// Command line, and the JSON output used by the UI (ui.py).

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../aniruddh/sim.h"

int trace = 0;
int inspect_at = -1;


/* ================= UI OUTPUT (JSON) ================= */

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

// Prints one whole run as JSON: the workload, one event per request, the feedback
// changes and the totals. ui.py reads this.
static void print_trace(int algo, int f, int place, int percent) {
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
static void print_params() {
    printf("{\"window\":%d,\"ws_window\":%d,\"weights\":[%.2f,%.2f,%.2f,%.2f],", WINDOW, WS_WINDOW,
           w_recency, w_frequency, w_behaviour, w_workset);
    printf("\"ws_start\":%.2f,\"ws_min\":%.2f,\"ws_max\":%.2f,\"ws_step\":%.2f,", WS_START, WS_MIN, WS_MAX, WS_STEP);
    printf("\"feedback_interval\":%d,\"high_fault_rate\":%.2f,\"low_fault_rate\":%.2f,\"cold_secret\":%.2f,",
           FEEDBACK_INTERVAL, HIGH_FAULT_RATE, LOW_FAULT_RATE, COLD_SECRET);
    printf("\"max_refs\":%d,\"max_frames\":%d,\"max_pages\":%d}\n", MAX_REFS, MAX_FRAMES, MAX_PAGES);
}

// returns the position of name in the list, or -1
static int find_name(char *names[], int count, char *name) {
    for (int i = 0; i < count; i++) {
        if (strcmp(names[i], name) == 0)
            return i;
    }
    return -1;
}

static int json_error(char *message) {
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
        // build the workloads in the same order as Experiment 1, so that with the
        // default settings the UI shows exactly the same data and results
        srand(seed);
        for (int k = CLASSIC; k <= workload; k++)
            make_workload(k);
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

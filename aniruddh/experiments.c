// The six experiments from our report (./sim, ./sim --experiments, ./sim --csv).

#include <stdio.h>
#include <stdlib.h>
#include "sim.h"

int csv = 0;
int seed = 42;

static void print_header(char *title) {
    if (csv)
        return;
    printf("\n=== %s ===\n", title);
    printf("%-10s %-13s %6s %-9s %7s %7s %6s %6s %6s %6s %9s\n", "workload", "setting", "frames",
           "algorithm", "faults", "hit%", "evS0", "evS1", "evS2", "evS3", "time_us");
}

// prints the result of the last run as one row
static void report(char *experiment, char *setting, int f, int algo) {
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

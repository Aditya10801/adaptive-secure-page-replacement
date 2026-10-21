// Automatic checks: ./sim --test

#include <stdio.h>
#include "sim.h"

static int passed = 0, failed = 0;

static void check(char *name, int ok) {
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

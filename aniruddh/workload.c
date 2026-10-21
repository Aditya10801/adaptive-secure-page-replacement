// Workloads (the dataset) and sensitivity labels.

#include <stdlib.h>
#include "sim.h"

char *pattern_names[] = {"classic", "sequential", "looping", "random", "bursty", "phased"};
char *place_names[] = {"random", "hot", "warm", "cold"};

char *workload_name;
int ref[MAX_REFS];
int n;
int npages;
int sens[MAX_PAGES];
int ref_length = 5000;

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

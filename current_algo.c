#include <stdio.h>
#include <stdlib.h>

#define MAX 1000

void print_result(const char *name, int faults, int hits, int total) {
    printf("%-8s Faults = %d, Hits = %d, Fault Rate = %.2f%%, Hit Rate = %.2f%%\n",
           name, faults, hits,
           (faults * 100.0) / total,
           (hits * 100.0) / total);
}

int contains(int frames[], int n, int page) {
    for (int i = 0; i < n; i++)
        if (frames[i] == page) return 1;
    return 0;
}

void fifo(int ref[], int n, int frame_count) {
    int frames[MAX], count = 0, pointer = 0, faults = 0, hits = 0;

    for (int i = 0; i < n; i++) {
        if (contains(frames, count, ref[i])) {
            hits++;
        } else {
            faults++;
            if (count < frame_count)
                frames[count++] = ref[i];
            else {
                frames[pointer] = ref[i];
                pointer = (pointer + 1) % frame_count;
            }
        }
    }
    print_result("FIFO", faults, hits, n);
}

void lru(int ref[], int n, int frame_count) {
    int frames[MAX], last[MAX], count = 0, faults = 0, hits = 0;

    for (int i = 0; i < MAX; i++) last[i] = -1;

    for (int i = 0; i < n; i++) {
        int page = ref[i];

        if (contains(frames, count, page)) {
            hits++;
        } else {
            faults++;

            if (count < frame_count) {
                frames[count++] = page;
            } else {
                int victim = 0;
                for (int j = 1; j < frame_count; j++) {
                    if (last[frames[j]] < last[frames[victim]])
                        victim = j;
                }
                frames[victim] = page;
            }
        }
        last[page] = i;
    }
    print_result("LRU", faults, hits, n);
}

void lfu(int ref[], int n, int frame_count) {
    int frames[MAX], freq[MAX], last[MAX];
    int count = 0, faults = 0, hits = 0;

    for (int i = 0; i < MAX; i++) {
        freq[i] = 0;
        last[i] = -1;
    }

    for (int i = 0; i < n; i++) {
        int page = ref[i];

        if (contains(frames, count, page)) {
            hits++;
        } else {
            faults++;

            if (count < frame_count) {
                frames[count++] = page;
            } else {
                int victim = 0;
                for (int j = 1; j < frame_count; j++) {
                    if (freq[frames[j]] < freq[frames[victim]] ||
                       (freq[frames[j]] == freq[frames[victim]] &&
                        last[frames[j]] < last[frames[victim]]))
                        victim = j;
                }
                frames[victim] = page;
            }
        }

        freq[page]++;
        last[page] = i;
    }

    print_result("LFU", faults, hits, n);
}

int next_use(int ref[], int n, int start, int page) {
    for (int i = start; i < n; i++)
        if (ref[i] == page)
            return i;
    return n + 1;
}

void optimal(int ref[], int n, int frame_count) {
    int frames[MAX], count = 0, faults = 0, hits = 0;

    for (int i = 0; i < n; i++) {
        int page = ref[i];

        if (contains(frames, count, page)) {
            hits++;
        } else {
            faults++;

            if (count < frame_count) {
                frames[count++] = page;
            } else {
                int victim = 0;
                int farthest = next_use(ref, n, i + 1, frames[0]);

                for (int j = 1; j < frame_count; j++) {
                    int future = next_use(ref, n, i + 1, frames[j]);
                    if (future > farthest) {
                        farthest = future;
                        victim = j;
                    }
                }
                frames[victim] = page;
            }
        }
    }

    print_result("Optimal", faults, hits, n);
}

int main() {
    int reference_string[] = {
        1, 2, 3, 4, 1, 2, 5, 1, 2, 3, 4, 5,
        6, 3, 2, 1, 4, 5, 6, 7, 1, 2, 3, 4, 5
    };

    int n = sizeof(reference_string) / sizeof(reference_string[0]);
    int frames;

    printf("Number of frames: ");
    scanf("%d", &frames);

    if (frames <= 0 || frames > n) {
        printf("Invalid number of frames.\n");
        return 1;
    }

    printf("\nReference string: ");
    for (int i = 0; i < n; i++)
        printf("%d ", reference_string[i]);

    printf("\n\n--- Page Replacement Results ---\n");

    fifo(reference_string, n, frames);
    lru(reference_string, n, frames);
    lfu(reference_string, n, frames);
    optimal(reference_string, n, frames);

    return 0;
}

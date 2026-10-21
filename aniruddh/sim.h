/*
 * Security- and Behaviour-Aware Adaptive Page Replacement
 * OS Project - Aditya & Aniruddh
 *
 * Phase 1 (aniruddh/): page replacement simulator with FIFO, LRU, LFU and Optimal
 * Phase 2 (aditya/):   our Adaptive algorithm. Every page gets an eviction score
 *
 *     Score(p) = wR*R + wF*F + wB*B + wW*W - wS*S
 *
 *   R = recency, F = frequency, B = behaviour, W = working set, S = sensitivity.
 *   The page with the highest score is evicted. Top-secret pages that are in use
 *   are never evicted (unless every page in memory is protected), and the
 *   security weight wS is adjusted every 100 requests using the page fault rate.
 *
 * Files:
 *   aniruddh/workload.c     workloads and sensitivity labels
 *   aniruddh/simulator.c    memory frames, FIFO/LRU/LFU/Optimal, the simulation loop
 *   aniruddh/tests.c        automatic checks (./sim --test)
 *   aniruddh/experiments.c  the experiments from our report
 *   aditya/adaptive.c       behaviour detection, the five scores, security rules, feedback
 *   aditya/main.c           command line and JSON output for the UI
 *
 * Compile (from the repository root): gcc -o sim aniruddh/[all .c files] aditya/[all .c files]
 * Run:    ./sim                -> results table (all workloads, all algorithms)
 *          ./sim --experiments  -> the experiments from our report
 *          ./sim --csv          -> everything in CSV format (for graphs)
 *          ./sim --seed 7       -> use different random workloads
 *          ./sim --test         -> run all checks
 *
 * Used by the UI (aditya/ui.py), output is JSON:
 *          ./sim --trace --algo Adaptive --workload phased --frames 8 --length 1000
 *          ./sim --inspect 250 (same options)   -> memory state and decision at request 250
 *          ./sim --params                       -> all parameters of the algorithm
 *   other options: --place hot|warm|cold|random --percent 15
 *                  --weights 0.2,0.2,1.0,0.3  --no-security --no-behaviour --no-feedback
 */

#ifndef SIM_H
#define SIM_H

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

// security weight wS is changed by feedback between WS_MIN and WS_MAX
#define WS_START 1.0
#define WS_MIN   0.5
#define WS_MAX   2.0
#define WS_STEP  0.25
#define COLD_SECRET 0.5         // a secret page outside the working set keeps only half of its S
#define FEEDBACK_INTERVAL 100   // check the fault rate every 100 requests
#define HIGH_FAULT_RATE   0.30  // above this: memory pressure, security gives a little
#define LOW_FAULT_RATE    0.15  // below this: memory is fine, protect secrets more

extern char *pattern_names[];
extern char *algo_names[];
extern char *place_names[];


/* ---- workload.c ---- */

// current workload
extern char *workload_name;
extern int ref[MAX_REFS];     // page reference string
extern int n;                 // length of reference string
extern int npages;            // pages are numbered 0 to npages-1
extern int sens[MAX_PAGES];   // sensitivity level of each page: 0 = S0 (public) ... 3 = S3 (top secret)
extern int ref_length;        // number of requests in generated workloads

void assign_sensitivity();
void label_pages(int placement, int percent);
void load_string(int arr[], int len);
void make_workload(int pattern);


/* ---- simulator.c ---- */

// memory state
extern int frames[MAX_FRAMES];
extern int nframes;           // total frames
extern int used;              // frames filled so far
extern int loaded_at[MAX_PAGES];
extern int last_used[MAX_PAGES];
extern int freq[MAX_PAGES];

// results of the last run
extern int faults, hits;
extern int evicted[4];        // number of evicted pages of each sensitivity level (S3 = secure evictions)
extern double time_us;

int next_use(int page, int t);
int choose_victim(int algo, int t);
int find(int page);
void run(int algo, int num_frames);


/* ---- tests.c ---- */

int run_tests();


/* ---- experiments.c ---- */

extern int csv;               // 1 = print CSV rows instead of tables
extern int seed;

void main_table();
void exp_placement();
void exp_amount();
void exp_ablation();
void exp_overhead();
void exp_seeds();


/* ---- aditya/adaptive.c ---- */

// weights of the eviction score (chosen by experiment, see report).
// They are variables so the UI can change them with --weights.
extern double w_recency, w_frequency, w_behaviour, w_workset;

// state of the Adaptive algorithm
extern double wS;             // current security weight
extern int interval_faults;   // faults since the last feedback check
extern int use_security;      // these three switches are only turned off in experiments
extern int use_behaviour;
extern int use_feedback;
extern int last_fallback;     // last Adaptive decision: every page was protected
extern int last_no_security;  // last Adaptive decision: page it would evict without the security part
extern int fb_count;          // feedback changes during the last run
extern int fb_t[];
extern double fb_rate[], fb_old[], fb_new[];

int detect_behaviour(int t);
void prepare_scores();
double behaviour_score(int page, int behaviour, int t);
double recency_score(int page);
double frequency_score(int page);
double workset_score(int page, int t);
double security_score(int page, int t);
int is_protected(int page, int t);
double eviction_score(int page, int behaviour, int t);
void feedback_update(int t);
int behaviour_victim(int t);
int adaptive_victim(int t);


/* ---- aditya/main.c ---- */

extern int trace;             // 1 = print every request as JSON
extern int inspect_at;        // print the memory state just before this request

void print_state(int algo, int t);

#endif

// Our Adaptive algorithm: behaviour detection, the five scores (R, F, B, W, S),
// the security rules and the feedback loop.

#include "../aniruddh/sim.h"

double w_recency   = 0.2;
double w_frequency = 0.2;
double w_behaviour = 1.0;
double w_workset   = 0.3;

double wS;
int interval_faults;
int use_security = 1;
int use_behaviour = 1;
int use_feedback = 1;
int last_fallback = 0;
int last_no_security = -1;
int fb_count = 0;
int fb_t[MAX_REFS / FEEDBACK_INTERVAL + 1];
double fb_rate[MAX_REFS / FEEDBACK_INTERVAL + 1];
double fb_old[MAX_REFS / FEEDBACK_INTERVAL + 1];
double fb_new[MAX_REFS / FEEDBACK_INTERVAL + 1];

// filled by prepare_scores() before each eviction decision
static int oldest_use, newest_use, max_freq;


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
static double recency_rank(int page) {
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


/* ================= VICTIM SELECTION ================= */
// Each function returns the index of the frame to replace.

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
static int best_frame(int behaviour, int t, int skip_protected) {
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

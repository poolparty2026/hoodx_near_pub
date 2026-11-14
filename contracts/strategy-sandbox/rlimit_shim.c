/* near-sandbox asks for 65535 open files; in a container whose hard limit is lower it refuses to
 * start. This preload caps RLIMIT_NOFILE requests at the hard limit. Local test chain only. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <sys/resource.h>
#include <sys/types.h>

typedef int (*set_fn)(__rlimit_resource_t, const struct rlimit *);
typedef int (*set64_fn)(__rlimit_resource_t, const struct rlimit64 *);
typedef int (*prl_fn)(pid_t, __rlimit_resource_t, const struct rlimit *, struct rlimit *);
typedef int (*prl64_fn)(pid_t, __rlimit_resource_t, const struct rlimit64 *, struct rlimit64 *);

static void cap(__rlimit_resource_t res, struct rlimit *r) {
    struct rlimit hard;
    if (res == RLIMIT_NOFILE && getrlimit(RLIMIT_NOFILE, &hard) == 0) {
        if (r->rlim_max > hard.rlim_max) r->rlim_max = hard.rlim_max;
        if (r->rlim_cur > r->rlim_max) r->rlim_cur = r->rlim_max;
    }
}
int setrlimit(__rlimit_resource_t res, const struct rlimit *r) {
    struct rlimit c = *r; cap(res, &c);
    return ((set_fn)dlsym(RTLD_NEXT, "setrlimit"))(res, &c);
}
int setrlimit64(__rlimit_resource_t res, const struct rlimit64 *r) {
    struct rlimit c = { r->rlim_cur, r->rlim_max }; cap(res, &c);
    struct rlimit64 c64 = { c.rlim_cur, c.rlim_max };
    return ((set64_fn)dlsym(RTLD_NEXT, "setrlimit64"))(res, &c64);
}
int prlimit(pid_t p, __rlimit_resource_t res, const struct rlimit *n, struct rlimit *o) {
    if (!n) return ((prl_fn)dlsym(RTLD_NEXT, "prlimit"))(p, res, n, o);
    struct rlimit c = *n; cap(res, &c);
    return ((prl_fn)dlsym(RTLD_NEXT, "prlimit"))(p, res, &c, o);
}
int prlimit64(pid_t p, __rlimit_resource_t res, const struct rlimit64 *n, struct rlimit64 *o) {
    if (!n) return ((prl64_fn)dlsym(RTLD_NEXT, "prlimit64"))(p, res, n, o);
    struct rlimit c = { n->rlim_cur, n->rlim_max }; cap(res, &c);
    struct rlimit64 c64 = { c.rlim_cur, c.rlim_max };
    return ((prl64_fn)dlsym(RTLD_NEXT, "prlimit64"))(p, res, &c64, o);
}

#define _GNU_SOURCE
#include <dlfcn.h>
#include <sys/resource.h>
#include <sys/syscall.h>
#include <unistd.h>
/* Caps an RLIMIT_NOFILE request at the current hard limit (local sandbox only). */
static void cap(int res, struct rlimit *r) {
  if (res != RLIMIT_NOFILE || !r) return;
  struct rlimit cur; syscall(SYS_prlimit64, 0, RLIMIT_NOFILE, NULL, &cur);
  if (r->rlim_max > cur.rlim_max) r->rlim_max = cur.rlim_max;
  if (r->rlim_cur > r->rlim_max) r->rlim_cur = r->rlim_max;
}
int setrlimit(__rlimit_resource_t res, const struct rlimit *r) {
  struct rlimit c = *r; cap(res, &c); return (int)syscall(SYS_prlimit64, 0, res, &c, NULL);
}
int prlimit(pid_t pid, __rlimit_resource_t res, const struct rlimit *n, struct rlimit *o) {
  if (!n) return (int)syscall(SYS_prlimit64, pid, res, NULL, o);
  struct rlimit c = *n; cap(res, &c); return (int)syscall(SYS_prlimit64, pid, res, &c, o);
}
int prlimit64(pid_t pid, __rlimit_resource_t res, const struct rlimit64 *n, struct rlimit64 *o) { return prlimit(pid, res, (const struct rlimit *)n, (struct rlimit *)o); }
int setrlimit64(__rlimit_resource_t res, const struct rlimit64 *r) { return setrlimit(res, (const struct rlimit *)r); }

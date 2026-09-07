/* Does macOS reuse a pid while that pid is still an active pgid with a live
 * member?  Decides whether `-pid` is a stable identity after the leader is
 * reaped. */
#include <stdio.h>
#include <unistd.h>
#include <stdlib.h>
#include <signal.h>
#include <errno.h>
#include <sys/wait.h>

int main(void) {
  pid_t leader = fork();
  if (leader == 0) {
    setpgid(0, 0);
    pid_t g = fork();
    if (g == 0) { sleep(300); _exit(0); }   /* stays in the group */
    _exit(0);                                /* the LEADER exits at once */
  }
  setpgid(leader, leader);
  int st; waitpid(leader, &st, 0);          /* leader reaped */
  printf("target pgid = %d (leader reaped)\n", leader);
  errno = 0;
  printf("kill(-pgid, 0) => %d errno=%d (0 means the group is alive)\n",
         kill(-leader, 0), errno);

  long N = 400000;
  for (long i = 0; i < N; i++) {
    pid_t p = fork();
    if (p < 0) { perror("fork"); break; }
    if (p == 0) _exit(0);
    waitpid(p, &st, 0);
    if (p == leader) {
      printf("RECYCLED at iter %ld: pid %d handed out while its pgid was live\n", i, p);
      kill(-leader, SIGKILL);
      return 1;
    }
  }
  errno = 0;
  printf("NOT recycled after %ld forks; kill(-pgid,0) still => %d errno=%d\n",
         N, kill(-leader, 0), errno);
  kill(-leader, SIGKILL);
  return 0;
}

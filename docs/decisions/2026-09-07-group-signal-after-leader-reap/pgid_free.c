/* Complement: once the group is EMPTY, is the pgid handed out again? That is
 * the window in which `-pid` can name a stranger. */
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
    if (g == 0) { sleep(300); _exit(0); }
    _exit(0);
  }
  setpgid(leader, leader);
  int st; waitpid(leader, &st, 0);
  printf("target pgid = %d\n", leader);
  kill(-leader, SIGKILL);                   /* empty the group */
  for (int i = 0; i < 200 && kill(-leader, 0) == 0; i++) usleep(10000);
  errno = 0;
  printf("after emptying: kill(-pgid,0) => %d errno=%d (3 = ESRCH)\n",
         kill(-leader, 0), errno);

  long N = 400000;
  for (long i = 0; i < N; i++) {
    pid_t p = fork();
    if (p < 0) { perror("fork"); break; }
    if (p == 0) _exit(0);
    waitpid(p, &st, 0);
    if (p == leader) {
      printf("REUSED at iter %ld: pid %d handed out once the group was empty\n", i, p);
      return 0;
    }
  }
  printf("not reused in %ld forks\n", N);
  return 1;
}

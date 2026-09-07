#include <stdio.h>
#include <signal.h>
#include <errno.h>
#include <stdlib.h>
int main(int argc, char **argv) {
  int pgid = atoi(argv[1]);
  errno = 0;
  int r = kill(-pgid, 0);
  printf("kill(-%d, 0) => %d errno=%d (1=EPERM, 3=ESRCH)\n", pgid, r, errno);
  return 0;
}

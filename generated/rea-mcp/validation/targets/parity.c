// Native parity target: a few named functions, a string literal and a call graph.
#include <stdio.h>

static const char *parity_banner = "parity fixture: authorization failed";

unsigned parity_checksum(const char *text) {
  unsigned hash = 2166136261u;
  while (*text) {
    hash ^= (unsigned char)*text++;
    hash *= 16777619u;
  }
  return hash;
}

int parity_compare(const char *left, const char *right) {
  return parity_checksum(left) == parity_checksum(right);
}

int main(int argc, char **argv) {
  const char *input = argc > 1 ? argv[1] : "default";
  printf("%s %u %d\n", parity_banner, parity_checksum(input), parity_compare(input, "expected"));
  return 0;
}

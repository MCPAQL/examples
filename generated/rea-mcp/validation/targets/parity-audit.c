// cargo-auditable fixture: not Rust. A native binary with a __DATA,.dep-v0 section holding a
// zlib-compressed dependency list, the format inspect_rust_binary reads. fixtures.mjs writes
// parity-audit-data.h.
#include <stdio.h>
#include "parity-audit-data.h"

int main(void) {
  printf("%zu\n", sizeof parity_dep_v0);
  return 0;
}

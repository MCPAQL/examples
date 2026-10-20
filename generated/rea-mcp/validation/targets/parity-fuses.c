// Electron fuse fixture: not Electron. A native binary carrying Electron's fuse sentinel,
// wire version 1 and eight fuse bytes ('1' enabled, '0' disabled), so inspect_electron_fuses
// has something to read.
#include <stdio.h>

__attribute__((used)) static const char parity_fuses[] =
    "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX" "\x01" "\x08" "10011001";

int main(void) {
  printf("%zu\n", sizeof parity_fuses);
  return 0;
}

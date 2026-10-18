// Go parity target for inspect_go_binary.
package main

import "fmt"

func parityChecksum(text string) uint32 {
	hash := uint32(2166136261)
	for i := 0; i < len(text); i++ {
		hash ^= uint32(text[i])
		hash *= 16777619
	}
	return hash
}

func main() {
	fmt.Println("parity fixture", parityChecksum("default"))
}

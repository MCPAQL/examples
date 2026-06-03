import CoreGraphics
import Foundation

// Long-running cursor daemon. Reads lines from stdin: "<main|left> <u> <v>"
// where u,v ∈ [0,1] are normalized within the target display.
// Warps the cursor to the corresponding screen point.

var displays = [CGDirectDisplayID](repeating: 0, count: 8)
var count: UInt32 = 0
if CGGetActiveDisplayList(8, &displays, &count) != .success { count = 0 }
let mainID = CGMainDisplayID()
let otherID: CGDirectDisplayID = (0..<Int(count)).map { displays[$0] }.first { $0 != mainID } ?? mainID

FileHandle.standardError.write("move-cursor ready (main=\(mainID), left=\(otherID))\n".data(using: .utf8)!)

while let line = readLine() {
    let parts = line.split(separator: " ")
    guard parts.count == 3,
          let u = Double(parts[1]),
          let v = Double(parts[2]) else { continue }
    let target = String(parts[0])
    let id: CGDirectDisplayID = (target == "main") ? mainID : (target == "left") ? otherID : mainID
    let b = CGDisplayBounds(id)
    let cu = max(0.0, min(1.0, u))
    let cv = max(0.0, min(1.0, v))
    let x = b.origin.x + cu * b.width
    let y = b.origin.y + cv * b.height
    CGWarpMouseCursorPosition(CGPoint(x: x, y: y))
    CGAssociateMouseAndMouseCursorPosition(1)
}

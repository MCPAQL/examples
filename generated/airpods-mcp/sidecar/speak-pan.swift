import AVFoundation
import Foundation

let args = CommandLine.arguments
guard args.count >= 3 else {
    FileHandle.standardError.write("Usage: speak-pan <L|R|C> <text...>\n".data(using: .utf8)!)
    exit(1)
}

let side = args[1].uppercased()
let text = args[2..<args.count].joined(separator: " ")
let pan: Float = (side == "L") ? -1.0 : (side == "R") ? 1.0 : 0.0
let volume: Float = Float(ProcessInfo.processInfo.environment["SPEAK_VOLUME"] ?? "0.6") ?? 0.6
let rate: String = ProcessInfo.processInfo.environment["SPEAK_RATE"] ?? "240"

let aiffPath = "/tmp/airpods-cue-\(getpid()).aiff"
let aiffURL = URL(fileURLWithPath: aiffPath)

let say = Process()
say.launchPath = "/usr/bin/say"
say.arguments = ["-r", rate, "-o", aiffPath, text]
do {
    try say.run()
    say.waitUntilExit()
} catch {
    FileHandle.standardError.write("say failed: \(error)\n".data(using: .utf8)!)
    exit(2)
}

guard let player = try? AVAudioPlayer(contentsOf: aiffURL) else {
    FileHandle.standardError.write("AVAudioPlayer init failed\n".data(using: .utf8)!)
    try? FileManager.default.removeItem(at: aiffURL)
    exit(3)
}
player.pan = pan
player.volume = volume
player.prepareToPlay()
player.play()

while player.isPlaying {
    Thread.sleep(forTimeInterval: 0.05)
}

try? FileManager.default.removeItem(at: aiffURL)

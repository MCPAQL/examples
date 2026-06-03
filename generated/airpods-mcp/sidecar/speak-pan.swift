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
// `say -r` requires an integer. An invalid SPEAK_RATE would make /usr/bin/say
// exit non-zero (which Process.run() does NOT throw for), producing no AIFF
// and a confusing downstream "AVAudioPlayer init failed". Validate and fall
// back rather than silently losing the (non-critical) spoken cue.
let rateEnv = ProcessInfo.processInfo.environment["SPEAK_RATE"] ?? "240"
let rate: String = Int(rateEnv) != nil ? rateEnv : "240"
if rate != rateEnv {
    FileHandle.standardError.write("SPEAK_RATE=\(rateEnv) is not an integer; using 240\n".data(using: .utf8) ?? Data())
}

let aiffPath = "/tmp/airpods-cue-\(getpid()).aiff"
let aiffURL = URL(fileURLWithPath: aiffPath)

let say = Process()
say.launchPath = "/usr/bin/say"
say.arguments = ["-r", rate, "-o", aiffPath, text]
do {
    try say.run()
    say.waitUntilExit()
} catch {
    FileHandle.standardError.write("say failed to launch: \(error)\n".data(using: .utf8) ?? Data())
    exit(2)
}
// Process.run() only throws if `say` can't be launched; a non-zero exit
// (bad args, synthesis failure) does not throw. Check explicitly so the
// failure is reported here rather than as a misleading AVAudioPlayer error.
guard say.terminationStatus == 0 else {
    FileHandle.standardError.write("say exited \(say.terminationStatus)\n".data(using: .utf8) ?? Data())
    try? FileManager.default.removeItem(at: aiffURL)
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

// Bound the wait: if isPlaying never flips false (decode stall) an
// unbounded loop hangs forever AND leaks the temp AIFF (cleanup below
// never runs). Cap at the clip duration plus a small margin.
let deadline = Date().addingTimeInterval(player.duration + 1.0)
while player.isPlaying && Date() < deadline {
    Thread.sleep(forTimeInterval: 0.05)
}

try? FileManager.default.removeItem(at: aiffURL)

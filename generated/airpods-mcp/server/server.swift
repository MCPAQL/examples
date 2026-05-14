import CoreMotion
import Foundation
import Network

let PORT: UInt16 = 47833
let logPath = "/tmp/airpods-mcp-server.log"
FileManager.default.createFile(atPath: logPath, contents: nil)
let logHandle: FileHandle = {
    guard let h = FileHandle(forWritingAtPath: logPath) else {
        FileHandle.standardError.write(
            "FATAL: cannot open \(logPath) for writing\n".data(using: .utf8) ?? Data()
        )
        exit(3)
    }
    return h
}()

func log(_ s: String) {
    let stamp = ISO8601DateFormatter().string(from: Date())
    let line = "[\(stamp)] \(s)\n"
    if let data = line.data(using: .utf8) {
        logHandle.write(data)
    }
}

let clientsLock = NSLock()
var clients: [NWConnection] = []

func broadcast(_ json: String) {
    let payload = (json + "\n").data(using: .utf8)!
    clientsLock.lock()
    let snapshot = clients
    clientsLock.unlock()
    for c in snapshot {
        c.send(content: payload, completion: .contentProcessed { _ in })
    }
}

// Returns nil if the object contains NaN/Inf floats (which JSONSerialization
// rejects) or any other JSON-invalid value. Callers must skip the sample.
func encodeJSON(_ obj: [String: Any]) -> String? {
    guard JSONSerialization.isValidJSONObject(obj),
          let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]),
          let s = String(data: data, encoding: .utf8) else { return nil }
    return s
}

let manager = CMHeadphoneMotionManager()

guard manager.isDeviceMotionAvailable else {
    log("FATAL: CMHeadphoneMotionManager.isDeviceMotionAvailable == false")
    exit(1)
}

log("Headphone motion available; binding TCP \(PORT)…")

// Bind to loopback only: the raw pose stream is unauthenticated, so anything
// listening here must never be reachable from the LAN. requiredInterfaceType
// makes Network.framework reject non-loopback connections at accept time.
let listenerParams = NWParameters.tcp
listenerParams.requiredInterfaceType = .loopback

let listener: NWListener
do {
    listener = try NWListener(using: listenerParams, on: NWEndpoint.Port(rawValue: PORT)!)
} catch {
    log("FATAL: cannot bind \(PORT): \(error)")
    exit(2)
}

// Reject any client whose remote endpoint isn't loopback. The raw pose stream
// is unauthenticated, so it must never be accepted from the LAN even if the
// listener somehow ends up bound to a non-loopback interface.
func isLoopback(_ endpoint: NWEndpoint) -> Bool {
    guard case let .hostPort(host: host, port: _) = endpoint else { return false }
    switch host {
    case .ipv4(let addr): return addr.rawValue == Data([127, 0, 0, 1])
    case .ipv6(let addr): return addr == .loopback
    case .name(let name, _): return name == "localhost"
    @unknown default: return false
    }
}

listener.newConnectionHandler = { conn in
    if !isLoopback(conn.endpoint) {
        log("rejecting non-loopback connection from \(conn.endpoint)")
        conn.cancel()
        return
    }
    log("client connected")
    conn.stateUpdateHandler = { state in
        switch state {
        case .ready:
            clientsLock.lock()
            clients.append(conn)
            clientsLock.unlock()
            if let hello = encodeJSON([
                "type": "hello",
                "server": "airpods-mcp",
                "version": "0.1.0",
                "rate_hint_hz": 25,
            ]), let helloData = (hello + "\n").data(using: .utf8) {
                conn.send(content: helloData, completion: .contentProcessed { _ in })
            }
        case .failed, .cancelled:
            clientsLock.lock()
            clients.removeAll { $0 === conn }
            clientsLock.unlock()
            log("client disconnected")
        default: break
        }
    }
    conn.start(queue: .global())
}

listener.start(queue: .global())
log("listening on \(PORT)")

var sampleCount = 0
let startedAt = Date()
let queue = OperationQueue()
queue.qualityOfService = .userInitiated

manager.startDeviceMotionUpdates(to: queue) { motion, error in
    if let error = error {
        log("motion err: \(error)")
        return
    }
    guard let m = motion else { return }
    sampleCount += 1
    let q = m.attitude.quaternion
    guard let payload = encodeJSON([
        "type": "pose",
        "n": sampleCount,
        "t": Date().timeIntervalSince1970,
        "q": [q.x, q.y, q.z, q.w],
        "pitch": m.attitude.pitch,
        "roll":  m.attitude.roll,
        "yaw":   m.attitude.yaw,
        "rotRate": [m.rotationRate.x, m.rotationRate.y, m.rotationRate.z],
    ]) else {
        // Pose contained NaN/Inf (transient hardware/initialization edge).
        // Skip this sample rather than crashing the motion source.
        return
    }
    broadcast(payload)
}

log("motion updates started; running forever")

signal(SIGINT) { _ in
    log("SIGINT; shutting down")
    manager.stopDeviceMotionUpdates()
    exit(0)
}
signal(SIGTERM) { _ in
    log("SIGTERM; shutting down")
    manager.stopDeviceMotionUpdates()
    exit(0)
}

RunLoop.main.run()

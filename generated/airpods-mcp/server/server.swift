import CoreMotion
import Foundation
import Network

let PORT: UInt16 = 47833
let logPath = "/tmp/airpods-mcp-server.log"
FileManager.default.createFile(atPath: logPath, contents: nil)
let logHandle = FileHandle(forWritingAtPath: logPath)!

func log(_ s: String) {
    let stamp = ISO8601DateFormatter().string(from: Date())
    let line = "[\(stamp)] \(s)\n"
    logHandle.write(line.data(using: .utf8)!)
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

func encodeJSON(_ obj: [String: Any]) -> String {
    let data = try! JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])
    return String(data: data, encoding: .utf8)!
}

let manager = CMHeadphoneMotionManager()

guard manager.isDeviceMotionAvailable else {
    log("FATAL: CMHeadphoneMotionManager.isDeviceMotionAvailable == false")
    exit(1)
}

log("Headphone motion available; binding TCP \(PORT)…")

let listener: NWListener
do {
    listener = try NWListener(using: .tcp, on: NWEndpoint.Port(rawValue: PORT)!)
} catch {
    log("FATAL: cannot bind \(PORT): \(error)")
    exit(2)
}

listener.newConnectionHandler = { conn in
    log("client connected")
    conn.stateUpdateHandler = { state in
        switch state {
        case .ready:
            clientsLock.lock()
            clients.append(conn)
            clientsLock.unlock()
            let hello = encodeJSON([
                "type": "hello",
                "server": "airpods-mcp",
                "version": "0.1.0",
                "rate_hint_hz": 25,
            ])
            conn.send(content: (hello + "\n").data(using: .utf8)!, completion: .contentProcessed { _ in })
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
    let payload = encodeJSON([
        "type": "pose",
        "n": sampleCount,
        "t": Date().timeIntervalSince1970,
        "q": [q.x, q.y, q.z, q.w],
        "pitch": m.attitude.pitch,
        "roll":  m.attitude.roll,
        "yaw":   m.attitude.yaw,
        "rotRate": [m.rotationRate.x, m.rotationRate.y, m.rotationRate.z],
    ])
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

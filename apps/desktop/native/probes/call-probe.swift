// Probe: can we tell that the user is in a call (Teams, Zoom, Meet, in an app,
// a browser tab or a web app), even muted with the camera off?
// See docs/design/call-notes.md, "Detection".
//
// Rule: a call is ONE process holding both audio input (mic) and audio output
// for 10 s or more, ignoring system listeners and our own dictation helper.
// - Muted calls still hold the mic (tested: Teams web app in Chrome, muted).
// - Requiring input AND output in the same process keeps out a voice memo
//   (input only) and music (output only), even when both run at once.
// - The app is not identified as Teams or Zoom on purpose: the prompt always says
//   "Call detected". A call in a browser tab only shows as the browser.
//
// Prints every 3 s each process using audio input or output, and the verdict.
// Reads system state only: records nothing, opens no audio stream, needs no
// permission prompt. macOS 14+.
//
// Run (Xcode command line tools):
//   swift apps/desktop/native/probes/call-probe.swift            # until Ctrl-C
//   swift apps/desktop/native/probes/call-probe.swift --seconds 60

import AppKit
import CoreAudio
import Foundation

let system = AudioObjectID(kAudioObjectSystemObject)
let pollSeconds = 3.0
let confirmSeconds = 10.0

/// Processes that hold the mic but are never a call.
let ignoredBundles: Set<String> = ["com.apple.CoreSpeech"]  // "Hey Siri" listener
let ignoredNames: Set<String> = ["corespeechd", "wgpt-dictate"]  // wgpt-dictate: WorkspaceGPT's own dictation helper

func address(_ selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
  AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
}

func readUInt32(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> UInt32? {
  var addr = address(selector)
  var value: UInt32 = 0
  var size = UInt32(MemoryLayout<UInt32>.size)
  return AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &value) == noErr ? value : nil
}

func readPid(_ object: AudioObjectID) -> pid_t? {
  var addr = address(kAudioProcessPropertyPID)
  var value: pid_t = 0
  var size = UInt32(MemoryLayout<pid_t>.size)
  return AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &value) == noErr ? value : nil
}

func readString(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
  var addr = address(selector)
  var value: Unmanaged<CFString>?
  var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
  guard AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &value) == noErr else { return nil }
  return value?.takeRetainedValue() as String?
}

func audioProcesses() -> [AudioObjectID] {
  var addr = address(kAudioHardwarePropertyProcessObjectList)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(system, &addr, 0, nil, &size) == noErr, size > 0 else { return [] }
  var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
  guard AudioObjectGetPropertyData(system, &addr, 0, nil, &size, &ids) == noErr else { return [] }
  return ids
}

func processName(_ pid: pid_t) -> String {
  if let app = NSRunningApplication(processIdentifier: pid), let name = app.localizedName { return name }
  let ps = Process()
  ps.executableURL = URL(fileURLWithPath: "/bin/ps")
  ps.arguments = ["-p", String(pid), "-o", "comm="]
  let pipe = Pipe()
  ps.standardOutput = pipe
  try? ps.run()
  ps.waitUntilExit()
  let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
  return (out.split(separator: "/").last.map(String.init) ?? "?").trimmingCharacters(in: .whitespacesAndNewlines)
}

var seconds = Int.max
if let i = CommandLine.arguments.firstIndex(of: "--seconds"), i + 1 < CommandLine.arguments.count, let n = Int(CommandLine.arguments[i + 1]) {
  seconds = n
}

guard #available(macOS 14.0, *) else {
  print("This probe needs macOS 14 or later (per-process audio state).")
  exit(1)
}

let clock = DateFormatter()
clock.dateFormat = "HH:mm:ss"
let started = Date()
var callSince: [pid_t: Date] = [:]  // when each process started holding input+output
print("Call probe: polling every \(Int(pollSeconds)) s, a call needs \(Int(confirmSeconds)) s. Ctrl-C to stop.\n")

while Date().timeIntervalSince(started) < Double(seconds) {
  let now = Date()
  var lines: [String] = []
  var holding: Set<pid_t> = []

  for object in audioProcesses() {
    let input = (readUInt32(object, kAudioProcessPropertyIsRunningInput) ?? 0) != 0
    let output = (readUInt32(object, kAudioProcessPropertyIsRunningOutput) ?? 0) != 0
    guard input || output, let pid = readPid(object) else { continue }
    let bundle = readString(object, kAudioProcessPropertyBundleID)
    let name = processName(pid)
    let ignored = ignoredBundles.contains(bundle ?? "") || ignoredNames.contains(name)
    if input && output && !ignored { holding.insert(pid) }
    let what = [input ? "IN" : nil, output ? "OUT" : nil].compactMap { $0 }.joined(separator: "+")
    lines.append("    \(ignored ? "-" : " ") \(what.padding(toLength: 6, withPad: " ", startingAt: 0)) pid \(pid)  \(name)  [\(bundle ?? "-")]")
  }

  callSince = callSince.filter { holding.contains($0.key) }
  for pid in holding where callSince[pid] == nil { callSince[pid] = now }
  let confirmed = callSince.filter { now.timeIntervalSince($0.value) >= confirmSeconds }.map { processName($0.key) }
  let verdict = !confirmed.isEmpty ? "=> CALL detected (\(confirmed.sorted().joined(separator: ", ")))"
    : !holding.isEmpty ? "=> possible call, confirming…" : "=> no call"
  print("\(clock.string(from: now))  \(verdict)")
  lines.forEach { print($0) }
  fflush(stdout)
  Thread.sleep(forTimeInterval: pollSeconds)
}

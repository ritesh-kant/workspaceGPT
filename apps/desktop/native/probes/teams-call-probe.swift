// Probe: can we tell that the user is in a Teams call, even muted with the camera off?
// See docs/design/call-notes.md, "Validate first".
//
// Prints every few seconds:
//   - every process Core Audio says is running audio INPUT or OUTPUT (macOS 14+),
//     with Teams-family processes marked;
//   - whether the default input device is in use by anyone;
//   - the power assertions held by Teams-family processes (calls keep the display awake).
//
// Reads system state only. It records nothing, opens no audio stream, and needs
// no permission prompt.
//
// Run (Xcode command line tools):
//   swift apps/desktop/native/probes/teams-call-probe.swift            # until Ctrl-C
//   swift apps/desktop/native/probes/teams-call-probe.swift --seconds 60
//
// Test plan: start it, join a Teams call, mute and turn the camera off, wait a
// minute, unmute, leave the call. Each line with "=> CALL" should match the
// time you were in the call, including the muted part.

import AppKit
import CoreAudio
import Foundation
import IOKit.pwr_mgt

let system = AudioObjectID(kAudioObjectSystemObject)

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

func isTeams(bundle: String?, name: String) -> Bool {
  (bundle ?? "").lowercased().contains("com.microsoft.teams") || name.lowercased().contains("teams")
}

func defaultInputInUse() -> Bool? {
  guard let device = readUInt32(system, kAudioHardwarePropertyDefaultInputDevice) else { return nil }
  return readUInt32(AudioObjectID(device), kAudioDevicePropertyDeviceIsRunningSomewhere).map { $0 != 0 }
}

/// Power assertions held by Teams-family processes: "pid name: Type 'Name'".
func teamsAssertions() -> [String] {
  var ref: Unmanaged<CFDictionary>?
  guard IOPMCopyAssertionsByProcess(&ref) == kIOReturnSuccess,
        let byPid = ref?.takeRetainedValue() as? [NSNumber: [[String: Any]]] else { return [] }
  var lines: [String] = []
  for (pidNumber, assertions) in byPid {
    let pid = pid_t(truncating: pidNumber)
    let name = processName(pid)
    let bundle = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier
    guard isTeams(bundle: bundle, name: name) else { continue }
    for a in assertions {
      let type = a["AssertType"] as? String ?? "?"
      let label = a["AssertName"] as? String ?? ""
      lines.append("\(pid) \(name): \(type) '\(label)'")
    }
  }
  return lines.sorted()
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
print("Teams call probe: polling every 3 s. Ctrl-C to stop.\n")

while Date().timeIntervalSince(started) < Double(seconds) {
  var lines: [String] = []
  var teamsInput = false
  var teamsRunning = NSWorkspace.shared.runningApplications.contains { isTeams(bundle: $0.bundleIdentifier, name: $0.localizedName ?? "") }

  for object in audioProcesses() {
    let input = (readUInt32(object, kAudioProcessPropertyIsRunningInput) ?? 0) != 0
    let output = (readUInt32(object, kAudioProcessPropertyIsRunningOutput) ?? 0) != 0
    guard input || output, let pid = readPid(object) else { continue }
    let bundle = readString(object, kAudioProcessPropertyBundleID)
    let name = processName(pid)
    let teams = isTeams(bundle: bundle, name: name)
    if teams { teamsRunning = true }
    if teams && input { teamsInput = true }
    let what = [input ? "IN" : nil, output ? "OUT" : nil].compactMap { $0 }.joined(separator: "+")
    lines.append("    \(teams ? "*" : " ") \(what.padding(toLength: 6, withPad: " ", startingAt: 0)) pid \(pid)  \(name)  [\(bundle ?? "-")]")
  }

  let assertions = teamsAssertions()
  let anyMic = defaultInputInUse().map { $0 ? "yes" : "no" } ?? "?"
  let verdict = teamsInput ? "=> CALL (Teams holds the mic)" : (!assertions.isEmpty ? "=> maybe (Teams assertion only)" : "=> no call")
  print("\(clock.string(from: Date()))  teams running: \(teamsRunning ? "yes" : "no")  mic in use (anyone): \(anyMic)  \(verdict)")
  lines.forEach { print($0) }
  assertions.forEach { print("    assertion: \($0)") }
  fflush(stdout)
  Thread.sleep(forTimeInterval: 3)
}

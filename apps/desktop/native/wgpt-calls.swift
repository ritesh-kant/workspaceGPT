// wgpt-calls: reports which processes look like they are in a call, for call notes
// (sidecar/host/callDetection.ts, docs/design/call-notes.md "Detection").
//
// Every few seconds it prints one JSON line:
//   {"holders":[{"pid":5516,"name":"Google Chrome"}]}
// listing each process that holds BOTH audio input (the mic) and audio output
// right now, minus the ignore list. It applies no timing: the sidecar decides
// when that becomes a call, so the rule lives in one place for every OS.
//
// Reads Core Audio's per-process state only (macOS 14+). It opens no audio
// stream, records nothing, and needs no permission prompt. Exits when stdin
// closes, so it never outlives the sidecar. On older macOS it prints
// {"unsupported":true} and exits.

import AppKit
import CoreAudio
import Foundation

let system = AudioObjectID(kAudioObjectSystemObject)
let pollSeconds = 3.0

/// Processes that hold the mic but are never a call.
let ignoredBundles: Set<String> = ["com.apple.CoreSpeech"]  // "Hey Siri" listener
let ignoredNames: Set<String> = ["corespeechd", "wgpt-dictate"]  // wgpt-dictate: our own dictation helper

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

/// The app's name; a browser's audio helper ("Google Chrome Helper (Aperitif)") reads as the browser.
func processName(_ pid: pid_t) -> String {
  var name = NSRunningApplication(processIdentifier: pid)?.localizedName
  if name == nil {
    var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
    if proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 { name = URL(fileURLWithPath: String(cString: buffer)).lastPathComponent }
  }
  let full = name ?? "?"
  if let r = full.range(of: #" Helper( \(.*\))?$"#, options: .regularExpression) { return String(full[..<r.lowerBound]) }
  return full
}

func line(_ object: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: object), let text = String(data: data, encoding: .utf8) {
    print(text)
    fflush(stdout)
  }
}

guard #available(macOS 14.0, *) else {
  line(["unsupported": true])
  exit(0)
}

// The sidecar closing our stdin (or dying) ends us.
Thread.detachNewThread {
  while readLine() != nil {}
  exit(0)
}

while true {
  var holders: [[String: Any]] = []
  for object in audioProcesses() {
    let input = (readUInt32(object, kAudioProcessPropertyIsRunningInput) ?? 0) != 0
    let output = (readUInt32(object, kAudioProcessPropertyIsRunningOutput) ?? 0) != 0
    guard input && output, let pid = readPid(object) else { continue }
    let bundle = readString(object, kAudioProcessPropertyBundleID) ?? ""
    let name = processName(pid)
    if ignoredBundles.contains(bundle) || ignoredNames.contains(name) { continue }
    holders.append(["pid": Int(pid), "name": name])
  }
  line(["holders": holders])
  Thread.sleep(forTimeInterval: pollSeconds)
}

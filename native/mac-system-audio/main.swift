// mc-system-audio — streams what this Mac is playing (all apps' output) as
// 16 kHz mono Float32 little-endian PCM on stdout, for MeetingCopilot's
// "对方" (other party) channel. It never opens a microphone.
//
// Uses a Core Audio process tap (macOS 14.2+): a private global tap on every
// process's output, wrapped in a private aggregate device whose IOProc
// receives the tapped audio. The user still hears everything (unmuted tap).
// macOS asks once for "System Audio Recording" permission for MeetingCopilot.
//
// Protocol: stdout = raw PCM only. stderr = one-line status messages:
//   "ready <sampleRate> <channels>"   tap running
//   "level <rms>"                      ~1/s, for diagnostics
//   "error <code> <message>"           fatal; the process exits non-zero
// The helper stops on SIGTERM / SIGINT, or when stdin closes (parent gone).
//
// Build: swiftc -O -o mc-system-audio main.swift   (see tools/build-mac-audio.mjs)

import AVFoundation
import CoreAudio
import Foundation

setvbuf(stderr, nil, _IONBF, 0)
// A broken stdout pipe means the parent is gone: write() fails and we exit.
signal(SIGPIPE, SIG_IGN)

func status(_ line: String) {
  FileHandle.standardError.write((line + "\n").data(using: .utf8)!)
}

func fail(_ code: Int32, _ message: String) -> Never {
  status("error \(code) \(message)")
  exit(code)
}

if CommandLine.arguments.contains("--version") {
  print("mc-system-audio 1")
  exit(0)
}

@available(macOS 14.2, *)
func runCapture() -> Never {

  func defaultOutputDeviceUID() -> String? {
    var deviceID = AudioObjectID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioHardwarePropertyDefaultSystemOutputDevice,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &deviceID) == noErr,
          deviceID != kAudioObjectUnknown else { return nil }
    var uid: Unmanaged<CFString>?
    size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    address.mSelector = kAudioDevicePropertyDeviceUID
    guard AudioObjectGetPropertyData(deviceID, &address, 0, nil, &size, &uid) == noErr, let value = uid else { return nil }
    return value.takeRetainedValue() as String
  }

  // ---- tap: every process, unmuted, private to this helper ----
  let tapDescription = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
  tapDescription.uuid = UUID()
  tapDescription.muteBehavior = .unmuted
  tapDescription.isPrivate = true
  tapDescription.name = "MeetingCopilot system audio"

  var tapID = AudioObjectID(kAudioObjectUnknown)
  var err = AudioHardwareCreateProcessTap(tapDescription, &tapID)
  guard err == noErr, tapID != kAudioObjectUnknown else {
    fail(3, "could not create the system audio tap (OSStatus \(err))")
  }

  var tapFormat = AudioStreamBasicDescription()
  var formatSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
  var formatAddress = AudioObjectPropertyAddress(
    mSelector: kAudioTapPropertyFormat,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
  err = AudioObjectGetPropertyData(tapID, &formatAddress, 0, nil, &formatSize, &tapFormat)
  guard err == noErr, let inputFormat = AVAudioFormat(streamDescription: &tapFormat) else {
    AudioHardwareDestroyProcessTap(tapID)
    fail(3, "could not read the tap format (OSStatus \(err))")
  }

  // ---- aggregate device that carries the tap ----
  guard let outputUID = defaultOutputDeviceUID() else {
    AudioHardwareDestroyProcessTap(tapID)
    fail(4, "no output device found")
  }
  let aggregateDescription: [String: Any] = [
    kAudioAggregateDeviceNameKey: "MeetingCopilot Tap",
    kAudioAggregateDeviceUIDKey: UUID().uuidString,
    kAudioAggregateDeviceMainSubDeviceKey: outputUID,
    kAudioAggregateDeviceIsPrivateKey: true,
    kAudioAggregateDeviceIsStackedKey: false,
    kAudioAggregateDeviceTapAutoStartKey: true,
    kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
    kAudioAggregateDeviceTapListKey: [[
      kAudioSubTapDriftCompensationKey: true,
      kAudioSubTapUIDKey: tapDescription.uuid.uuidString,
    ]],
  ]
  var aggregateID = AudioObjectID(kAudioObjectUnknown)
  err = AudioHardwareCreateAggregateDevice(aggregateDescription as CFDictionary, &aggregateID)
  guard err == noErr, aggregateID != kAudioObjectUnknown else {
    AudioHardwareDestroyProcessTap(tapID)
    fail(4, "could not create the capture device (OSStatus \(err))")
  }

  // ---- 16 kHz mono Float32 conversion ----
  guard let outputFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false),
        let converter = AVAudioConverter(from: inputFormat, to: outputFormat) else {
    AudioHardwareDestroyAggregateDevice(aggregateID)
    AudioHardwareDestroyProcessTap(tapID)
    fail(5, "unsupported tap format \(inputFormat)")
  }
  converter.downmix = true

  var levelSum: Double = 0
  var levelCount = 0
  var lastLevelReport = Date()

  func handle(_ input: UnsafePointer<AudioBufferList>) {
    guard let inBuffer = AVAudioPCMBuffer(pcmFormat: inputFormat, bufferListNoCopy: input, deallocator: nil),
          inBuffer.frameLength > 0 else { return }
    let capacity = AVAudioFrameCount(Double(inBuffer.frameLength) * 16_000 / inputFormat.sampleRate) + 32
    guard let outBuffer = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else { return }
    var supplied = false
    var conversionError: NSError?
    converter.convert(to: outBuffer, error: &conversionError) { _, inputStatus in
      if supplied {
        inputStatus.pointee = .noDataNow
        return nil
      }
      supplied = true
      inputStatus.pointee = .haveData
      return inBuffer
    }
    guard conversionError == nil, outBuffer.frameLength > 0, let samples = outBuffer.floatChannelData?[0] else { return }
    let count = Int(outBuffer.frameLength)
    for i in 0..<count { levelSum += Double(samples[i] * samples[i]) }
    levelCount += count
    let bytes = count * MemoryLayout<Float>.size
    var written = 0
    while written < bytes {
      let n = Darwin.write(1, UnsafeRawPointer(samples).advanced(by: written), bytes - written)
      if n <= 0 { if errno == EINTR { continue }; exit(0) }  // parent gone; the HAL drops private taps with us
      written += n
    }
    if Date().timeIntervalSince(lastLevelReport) >= 1 {
      status(String(format: "level %.5f", levelCount > 0 ? sqrt(levelSum / Double(levelCount)) : 0))
      levelSum = 0
      levelCount = 0
      lastLevelReport = Date()
    }
  }

  let ioQueue = DispatchQueue(label: "mc-system-audio.io")
  var procID: AudioDeviceIOProcID?
  err = AudioDeviceCreateIOProcIDWithBlock(&procID, aggregateID, ioQueue) { _, inputData, _, _, _ in
    handle(inputData)
  }
  guard err == noErr, let ioProc = procID else {
    AudioHardwareDestroyAggregateDevice(aggregateID)
    AudioHardwareDestroyProcessTap(tapID)
    fail(4, "could not attach to the capture device (OSStatus \(err))")
  }

  func shutdown(_ code: Int32) -> Never {
    AudioDeviceStop(aggregateID, ioProc)
    AudioDeviceDestroyIOProcID(aggregateID, ioProc)
    AudioHardwareDestroyAggregateDevice(aggregateID)
    AudioHardwareDestroyProcessTap(tapID)
    exit(code)
  }

  err = AudioDeviceStart(aggregateID, ioProc)
  guard err == noErr else {
    status("error 4 could not start capturing (OSStatus \(err))")
    shutdown(4)
  }
  status("ready \(Int(inputFormat.sampleRate)) \(inputFormat.channelCount)")

  var signalSources: [DispatchSourceSignal] = []
  for sig in [SIGTERM, SIGINT, SIGHUP] {
    signal(sig, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    source.setEventHandler { shutdown(0) }
    source.resume()
    signalSources.append(source)
  }
  // stdin EOF = the parent process exited without signalling us
  DispatchQueue.global().async {
    while FileHandle.standardInput.availableData.count > 0 {}
    DispatchQueue.main.async { shutdown(0) }
  }

  dispatchMain()
}

if #available(macOS 14.2, *) {
  runCapture()
} else {
  fail(2, "system audio capture needs macOS 14.2 or newer")
}

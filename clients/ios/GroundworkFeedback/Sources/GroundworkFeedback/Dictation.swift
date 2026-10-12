#if canImport(UIKit)
import AVFoundation
import Speech
import UIKit

/// Speak a comment instead of typing it. Uses Apple's speech recognition, on
/// the device when it can. Needs two keys in the app's debug Info.plist,
/// NSMicrophoneUsageDescription and NSSpeechRecognitionUsageDescription;
/// without them iOS would stop the app, so the mic explains what to add instead.
@MainActor
final class Dictation {
  static var allowed: Bool {
    ["NSMicrophoneUsageDescription", "NSSpeechRecognitionUsageDescription"].allSatisfy { Bundle.main.object(forInfoDictionaryKey: $0) != nil }
  }

  /// The languages to speak in: the person's preferred ones that speech recognition knows.
  static var languages: [Locale] {
    let supported = SFSpeechRecognizer.supportedLocales()
    var seen = Set<String>()
    return Locale.preferredLanguages
      .compactMap { id -> Locale? in
        let locale = Locale(identifier: id)
        if supported.contains(locale) { return locale }
        // "sv" or "sv-US": the first supported region for that language.
        let language = id.split(separator: "-").first.map(String.init) ?? id
        return supported.filter { $0.identifier.hasPrefix(language + "-") || $0.identifier.hasPrefix(language + "_") }.sorted { $0.identifier < $1.identifier }.first
      }
      .filter { seen.insert($0.identifier).inserted }
  }

  private static let languageKey = "GroundworkFeedback.language"
  static var language: Locale {
    get {
      let saved = UserDefaults.standard.string(forKey: languageKey)
      return languages.first { $0.identifier == saved } ?? languages.first ?? Locale.current
    }
    set { UserDefaults.standard.set(newValue.identifier, forKey: languageKey) }
  }

  private let engine = AVAudioEngine()
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  private var previous: (AVAudioSession.Category, AVAudioSession.Mode, AVAudioSession.CategoryOptions)?
  private(set) var running = false

  /// Listen, and call `heard` with everything recognized so far. `ended` gets
  /// a reason when it could not start or stopped by itself on an error.
  func start(heard: @escaping (String) -> Void, ended: @escaping (String?) -> Void) async {
    guard !running else { return }
    let speech = await withCheckedContinuation { (done: CheckedContinuation<SFSpeechRecognizerAuthorizationStatus, Never>) in
      SFSpeechRecognizer.requestAuthorization { done.resume(returning: $0) }
    }
    guard speech == .authorized else { return ended("Speech recognition is off for this app. Turn it on in Settings > Privacy & Security > Speech Recognition.") }
    guard await Self.microphone() else { return ended("The microphone is off for this app. Turn it on in Settings > Privacy & Security > Microphone.") }
    guard let recognizer = SFSpeechRecognizer(locale: Self.language), recognizer.isAvailable else {
      return ended("Speech recognition is not available right now.")
    }

    let session = AVAudioSession.sharedInstance()
    previous = (session.category, session.mode, session.categoryOptions)
    do {
      try session.setCategory(.record, mode: .measurement, options: .duckOthers)
      try session.setActive(true, options: .notifyOthersOnDeactivation)
    } catch {
      restore()
      return ended("The microphone could not start.")
    }

    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
    self.request = request
    let input = engine.inputNode
    input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0), block: Self.feed(request))
    engine.prepare()
    do {
      try engine.start()
    } catch {
      stop()
      return ended("The microphone could not start.")
    }
    running = true
    task = recognizer.recognitionTask(with: request, resultHandler: Self.results { [weak self] text, final, failed in
      MainActor.assumeIsolated {
        guard let self, self.running else { return }
        if let text { heard(text) }
        if final || failed {
          self.stop()
          ended(failed && text == nil ? "Nothing was heard." : nil)
        }
      }
    })
  }

  func stop() {
    running = false
    if engine.isRunning { engine.stop() }
    engine.inputNode.removeTap(onBus: 0)
    request?.endAudio()
    task?.finish()
    request = nil
    task = nil
    restore()
  }

  /// Give the app its own audio setup back.
  private func restore() {
    guard let (category, mode, options) = previous else { return }
    previous = nil
    let session = AVAudioSession.sharedInstance()
    try? session.setActive(false, options: .notifyOthersOnDeactivation)
    try? session.setCategory(category, mode: mode, options: options)
  }

  private static func microphone() async -> Bool {
    await withCheckedContinuation { (done: CheckedContinuation<Bool, Never>) in
      if #available(iOS 17, *) {
        AVAudioApplication.requestRecordPermission { done.resume(returning: $0) }
      } else {
        AVAudioSession.sharedInstance().requestRecordPermission { done.resume(returning: $0) }
      }
    }
  }

  // Audio and results arrive on other threads. These are built outside the
  // main actor, so they never claim to run on it.
  nonisolated private static func feed(_ request: SFSpeechAudioBufferRecognitionRequest) -> AVAudioNodeTapBlock {
    { buffer, _ in request.append(buffer) }
  }

  nonisolated private static func results(_ handle: @escaping @Sendable (String?, Bool, Bool) -> Void) -> (SFSpeechRecognitionResult?, Error?) -> Void {
    { result, error in
      let text = result?.bestTranscription.formattedString
      let final = result?.isFinal ?? false
      let failed = error != nil
      DispatchQueue.main.async { handle(text, final, failed) }
    }
  }
}
#endif
